import type { ControlEvent, IceServer, PeerLink } from '../shared/types';
import { decodeFrame } from '../shared/protocol';
import { api } from './api';
import type { ControlSession } from './control';

export interface DirectTransport {
  channel: RTCDataChannel;
  pc: RTCPeerConnection;
  subscribe(transferId: string, message: (data: string | ArrayBuffer) => void, closed: () => void): () => void;
}
export function addressFamily(address?: string): string {
  if (!address || address.endsWith('.local')) return '地址隐藏';
  return address.includes(':') ? 'IPv6' : /^\d+\.\d+\.\d+\.\d+$/.test(address) ? 'IPv4' : '地址隐藏';
}
class Connection implements DirectTransport {
  pc: RTCPeerConnection;
  channel!: RTCDataChannel;
  private ice: RTCIceCandidateInit[] = [];
  private localIce: RTCIceCandidateInit[] = [];
  private listeners = new Map<string, { message: (data: string | ArrayBuffer) => void; closed: () => void }>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private offered = false;
  private signaling: Promise<void> = Promise.resolve();
  constructor(public peer: PeerLink, private manager: PeerManager) {
    this.pc = new RTCPeerConnection({ iceServers: manager.stun, iceTransportPolicy: 'all' });
    this.pc.onicecandidate = event => { if (event.candidate) { const candidate = event.candidate.toJSON(); if (this.offered) this.queue('ice', { candidate }); else this.localIce.push(candidate); } };
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(this.pc.connectionState)) this.failed();
      else if (this.pc.connectionState === 'disconnected') { clearTimeout(this.timer); this.timer = setTimeout(() => this.failed(), 15000); }
      else if (this.pc.connectionState === 'connected') clearTimeout(this.timer);
    };
    this.pc.ondatachannel = event => this.attach(event.channel);
    this.timer = setTimeout(() => this.failed(), 45000);
  }
  private queue(kind: string, payload?: unknown) { this.signaling = this.signaling.then(async () => { await this.signal(kind, payload); }).catch(() => this.failed()); }
  private signal(kind: string, payload?: unknown) { if (this.stopped) return Promise.resolve(); return api(`${this.manager.control.base}/peer-signals`, this.manager.control.sessionToken, { peerId: this.peer.id, generation: this.peer.generation, kind, payload }); }
  async offer() {
    this.peer.generation++; this.attach(this.pc.createDataChannel('direct', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    // Offer 必须先于 trickle ICE；setLocalDescription 可能同步触发候选。
    await this.signal('offer', { description: this.pc.localDescription!.toJSON() }); this.offered = true;
    for (const candidate of this.localIce.splice(0)) this.queue('ice', { candidate });
  }
  async event(kind: string, payload: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (this.stopped) return;
    if (kind === 'ice') { if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate!); else this.ice.push(payload.candidate!); }
    else if (kind === 'offer') {
      await this.pc.setRemoteDescription(payload.description!); for (const ice of this.ice.splice(0)) await this.pc.addIceCandidate(ice);
      await this.pc.setLocalDescription(await this.pc.createAnswer()); await this.signal('answer', { description: this.pc.localDescription!.toJSON() }); this.offered = true;
      for (const candidate of this.localIce.splice(0)) this.queue('ice', { candidate });
    } else if (kind === 'answer') { await this.pc.setRemoteDescription(payload.description!); for (const ice of this.ice.splice(0)) await this.pc.addIceCandidate(ice); }
  }
  private attach(channel: RTCDataChannel) {
    this.channel = channel; channel.binaryType = 'arraybuffer';
    channel.onopen = () => { if (this.stopped) return; clearTimeout(this.timer); this.queue('ready'); void this.describe().catch(() => this.manager.status('直连已打通 · 浏览器未提供地址族统计')); this.manager.onLocalReady(this.peer.id); };
    channel.onclose = channel.onerror = () => this.failed();
    channel.onmessage = event => {
      try {
        const key = typeof event.data === 'string' ? String(JSON.parse(event.data).transferId) : decodeFrame(event.data).transferId;
        this.listeners.get(key)?.message(event.data);
      } catch { this.failed(); }
    };
  }
  private async describe() {
    const stats = await this.pc.getStats(); let family = '地址隐藏';
    stats.forEach(item => { if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) { const local = stats.get(item.localCandidateId), remote = stats.get(item.remoteCandidateId); family = `${addressFamily(local?.address)} → ${addressFamily(remote?.address)}`; } });
    this.manager.status(`直连已打通 · ${family} · 后续自动传输可复用`);
  }
  subscribe(transferId: string, message: (data: string | ArrayBuffer) => void, closed: () => void) { this.listeners.set(transferId, { message, closed }); return () => this.listeners.delete(transferId); }
  private failed() {
    if (this.stopped) return;
    void this.signal('closed').catch(() => {}); this.close(); this.manager.status('直连暂未打通，页面在线时会继续重试');
  }
  close(notify = true) { if (this.stopped) return; this.stopped = true; clearTimeout(this.timer); if (notify) for (const listener of this.listeners.values()) listener.closed(); this.listeners.clear(); this.pc.onconnectionstatechange = this.pc.onicecandidate = this.pc.ondatachannel = null; if (this.channel) this.channel.onopen = this.channel.onmessage = this.channel.onclose = this.channel.onerror = null; this.pc.close(); }
  get ready() { return !this.stopped && this.channel?.readyState === 'open'; }
  get dead() { return this.stopped; }
}

export class PeerManager {
  private connections = new Map<string, Connection>();
  private timer?: ReturnType<typeof setInterval>;
  private syncing = false;
  private stopped = false;
  onReady = (_peer: PeerLink) => {};
  onLocalReady = (_id: string) => {};
  constructor(public control: ControlSession, public stun: IceServer[], public status: (text: string) => void) {}
  start() { if (!this.control.capabilities.webrtc) { this.status('此浏览器不支持 WebRTC'); return; } void this.sync(); this.timer = setInterval(() => { void this.sync(); }, 30000); }
  async sync() {
    if (this.syncing || this.stopped || this.control.stopped || !this.control.capabilities.webrtc) return; this.syncing = true;
    try {
      const result = await api<{ peers: PeerLink[] }>(`${this.control.base}/peers`, this.control.sessionToken, {});
      const live = new Set(result.peers.map(p => p.id));
      for (const [key, conn] of this.connections) if (!live.has(key)) { conn.close(); this.connections.delete(key); }
      for (const peer of result.peers) {
        const current = this.connections.get(peer.id);
        if (peer.ownerId === this.control.sessionId && (!current || current.dead)) {
          const conn = new Connection({ ...peer }, this); this.connections.set(peer.id, conn); this.status('正在尝试 IPv4 / IPv6 直连打洞'); await conn.offer();
        }
        if (peer.ownerReady && peer.receiverReady && this.get(peer.id)) this.onReady(peer);
      }
      if (!result.peers.length) this.status('等待另一端在线，随后自动进行直连打洞');
    } catch (error) { this.status(`直连探测等待重试：${error instanceof Error ? error.message : String(error)}`); }
    finally { this.syncing = false; }
  }
  async event(event: ControlEvent) {
    if (event.type === 'peer-needed') { void this.sync(); return true; }
    if (event.type === 'peer-ready') { const peer = event.data as PeerLink; if (this.get(peer.id)) this.onReady(peer); return true; }
    if (event.type !== 'peer-signal') return false;
    const { peer, kind, payload } = event.data as { peer: PeerLink; kind: string; payload: Parameters<Connection['event']>[1] };
    let conn = this.connections.get(peer.id);
    if (kind === 'offer' && (!conn || conn.peer.generation < peer.generation || conn.dead)) { conn?.close(); conn = new Connection({ ...peer }, this); this.connections.set(peer.id, conn); }
    if (conn && conn.peer.generation === peer.generation) { try { await conn.event(kind, payload); } catch { conn.close(); } }
    return true;
  }
  get(id?: string): DirectTransport | undefined { const conn = id ? this.connections.get(id) : undefined; return conn?.ready ? conn : undefined; }
  retest() { for (const conn of this.connections.values()) if (!conn.ready) conn.close(); void this.sync(); }
  stop() { this.stopped = true; clearInterval(this.timer); for (const conn of this.connections.values()) conn.close(false); this.connections.clear(); }
}
