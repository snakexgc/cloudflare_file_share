import type { Capabilities, ControlEvent, DownloadRequest, ShareInfo } from '../shared/types';
import type { Limits } from '../worker/config';
import { api, ApiError, delay, makeId } from './api';
import { decodeFrame } from '../shared/protocol';

export class ControlSession {
  sessionId = '';
  sessionToken = '';
  socket?: WebSocket;
  cursor = 0;
  stopped = false;
  busy = () => false;
  onEvent = (_event: ControlEvent) => {};
  onBinary = (_data: ArrayBuffer) => {};
  onRaw = (_data: Record<string, unknown>) => {};
  onState = (_state: 'ws' | 'http' | 'offline', _message?: string) => {};
  onShare = (_share: ShareInfo) => {};
  private polling = false;
  private resyncing = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private binaryInFlight = new Map<string, number>();
  constructor(public shareId: string, public role: 'owner' | 'receiver', public capabilities: Capabilities, private conf: Limits, private ownerToken?: string) {}
  get base() { return `/api/shares/${this.shareId}`; }
  get ws() { return this.socket?.readyState === WebSocket.OPEN; }
  async start() {
    this.stopped = false;
    const result = await api<{ sessionId: string; sessionToken: string }>(`${this.base}/sessions`, this.ownerToken, { role: this.role, capabilities: this.capabilities });
    this.sessionId = result.sessionId; this.sessionToken = result.sessionToken;
    if (this.capabilities.ws && typeof WebSocket !== 'undefined') {
      try { await this.connect(); } catch { this.socket?.close(); this.socket = undefined; }
    }
    await this.heartbeat();
    if (!this.ws) this.useHttp(); else this.onState('ws');
    this.timer = setInterval(() => {
      if (this.ws && this.socket!.bufferedAmount === 0 && !this.binaryInFlight.size) this.socket!.send('{"type":"ping"}');
      void this.heartbeat().catch(error => this.onState('offline', String(error)));
    }, 25000);
  }
  private async connect() {
    await new Promise<void>((resolve, reject) => {
      const url = new URL(`${this.base}/ws`, location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, ['file-share', `token.${this.sessionToken}`]); this.socket = socket; socket.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => { socket.close(); reject(new Error('WS 握手超时')); }, this.conf.wsHandshakeMs);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('WS 连接失败')); };
      socket.onclose = () => {
        clearTimeout(timeout); reject(new Error('WS 已断开'));
        this.binaryInFlight.clear();
        if (!this.stopped && this.sessionToken) { this.useHttp(); this.onRaw({ type: 'ws-disconnected' }); }
      };
      socket.onmessage = event => {
        if (typeof event.data !== 'string') { this.onBinary(event.data as ArrayBuffer); return; }
        const data = JSON.parse(event.data) as Record<string, unknown>;
        if (data.type === 'event') this.deliver(data.event as ControlEvent);
        else if (data.type === 'signal-result') {
          const pending = this.pending.get(String(data.eventId));
          if (pending) { data.ok ? pending.resolve() : pending.reject(new Error(String(data.message))); this.pending.delete(String(data.eventId)); }
        } else if (data.type === 'heartbeat-result') this.onShare(data.share as ShareInfo);
        else if (data.type === 'relay-credit') {
          const transferId = String(data.transferId), end = this.binaryInFlight.get(transferId);
          if (end !== undefined && typeof data.offset === 'number' && data.offset >= end) this.binaryInFlight.delete(transferId);
          this.onRaw(data);
        }
        else if (data.type !== 'pong') this.onRaw(data);
      };
    });
  }
  private deliver(event: ControlEvent) {
    if (event.seq <= this.cursor) return;
    if (event.seq !== this.cursor + 1) { void this.resync().catch(error => { this.onState('offline', String(error)); this.socket?.close(); }); return; }
    if (event.request && ['stop-attempt', 'completed', 'canceled', 'relay-error', 'waiting-source'].includes(event.type)) this.binaryInFlight.delete(event.request.transferId);
    this.cursor = event.seq; this.onEvent(event);
  }
  private syncBinaryRequests(requests: DownloadRequest[]) {
    const activeTransfers = new Set(requests.filter(task => task.mode === 'ws' && !['completed', 'canceled', 'failed'].includes(task.status)).map(task => task.transferId));
    for (const key of this.binaryInFlight.keys()) if (!activeTransfers.has(key)) this.binaryInFlight.delete(key);
  }
  private useHttp() {
    if (this.stopped) return;
    this.capabilities.ws = false; this.onState('http');
    void this.heartbeat().catch(() => {});
    if (!this.polling) void this.poll();
  }
  private async resync() {
    if (this.resyncing) return; this.resyncing = true;
    try {
      const data = await api<{ share: ShareInfo; requests: DownloadRequest[]; cursor: number }>(`${this.base}/files-status`, this.sessionToken);
      this.syncBinaryRequests(data.requests);
      this.cursor = Math.max(this.cursor, data.cursor); this.onShare(data.share); this.onRaw({ type: 'resync', requests: data.requests });
    } finally { this.resyncing = false; }
  }
  private async poll() {
    this.polling = true;
    let failures = 0;
    while (!this.stopped && !this.ws) {
      try {
        const result = await api<{ events: ControlEvent[]; cursor: number }>(`${this.base}/events?cursor=${this.cursor}`, this.sessionToken);
        for (const event of result.events) this.deliver(event);
        this.cursor = Math.max(this.cursor, result.cursor); failures = 0;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'resync_required') {
          const details = error.details as { cursor: number; share: ShareInfo; requests: DownloadRequest[] };
          this.syncBinaryRequests(details.requests);
          this.cursor = details.cursor; this.onShare(details.share); this.onRaw({ type: 'resync', requests: details.requests }); failures = 0;
        } else if (error instanceof ApiError && error.status === 410) { this.onRaw({ type: 'expired' }); this.stop(); break; }
        else if (++failures >= 4) { this.onState('offline', error instanceof Error ? error.message : '控制连接失败'); break; }
      }
      await delay(failures ? 2000 * 2 ** failures : this.busy() ? Math.max(2100, this.conf.pollMinMs) : Math.max(12000, this.conf.pollMinMs));
    }
    this.polling = false;
  }
  async heartbeat() {
    if (this.stopped) return;
    if (this.ws && this.socket!.bufferedAmount === 0 && !this.binaryInFlight.size) { this.socket!.send(JSON.stringify({ type: 'heartbeat', capabilities: this.capabilities })); return; }
    // 大消息可能阻塞 WS 的后续应用消息；HTTPS 心跳维持源会话租约。
    const result = await api<{ share: ShareInfo }>(`${this.base}/heartbeat`, this.sessionToken, { capabilities: { ...this.capabilities, ws: this.ws } });
    this.onShare(result.share);
  }
  async signal(task: DownloadRequest, kind: string, payload: unknown) {
    const eventId = makeId(), body = { eventId, requestId: task.id, epoch: task.epoch, kind, payload };
    if (this.ws) {
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => { this.pending.delete(eventId); reject(new Error('WS 信令确认超时')); }, 5000);
          this.pending.set(eventId, { resolve: () => { clearTimeout(timeout); resolve(); }, reject: error => { clearTimeout(timeout); reject(error); } });
          this.socket!.send(JSON.stringify({ type: 'signal', ...body }));
        });
        return;
      } catch { /* 同一 eventId 通过 HTTPS 补发，服务端去重。 */ }
    }
    await api(`${this.base}/signals`, this.sessionToken, body);
  }
  relayAck(task: DownloadRequest, offset: number) {
    if (!this.ws) throw new Error('WS 数据连接不可用');
    this.socket!.send(JSON.stringify({ type: 'relay-ack', transferId: task.transferId, epoch: task.epoch, offset }));
  }
  binary(buffer: ArrayBuffer) {
    if (!this.ws) throw new Error('WS 数据连接不可用');
    const frame = decodeFrame(buffer); this.binaryInFlight.set(frame.transferId, frame.offset + frame.payload.byteLength); this.socket!.send(buffer);
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.socket?.close();
    this.binaryInFlight.clear();
    for (const pending of this.pending.values()) pending.reject(new Error('控制会话已关闭'));
    this.pending.clear();
  }
  async recover() { if (!this.stopped) { await this.heartbeat(); if (!this.ws) this.useHttp(); } }
}
