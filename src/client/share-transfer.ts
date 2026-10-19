import type { ChatAttachment } from '../shared/chat';
import type { ControlEvent, DownloadRequest, FileInfo, ShareInfo, ShareTransferMode } from '../shared/types';
import { decodeFrame } from '../shared/protocol';
import { api, ApiError } from './api';
import { ControlSession } from './control';
import { PeerManager } from './peer';
import { rtcSupport } from './rtc';
import { ReceiveTask, SendTask, UploadManager, type Progress } from './transfer';
import type { VerifiedSink } from './sink';
import type { PublicConfig } from './config';

const terminal = (task: DownloadRequest) => ['completed', 'canceled', 'failed'].includes(task.status);
class TransferConnection {
  control: ControlSession;
  peers?: PeerManager;
  uploads?: UploadManager;
  senders = new Map<string, SendTask>();
  receivers = new Map<string, ReceiveTask>();
  private events: ControlEvent[] = [];
  private credits = new Map<string, Record<string, unknown>>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(public share: ShareInfo, private config: PublicConfig, private progress: Progress, private sources = new Map<string, File>(), private ownerToken?: string) {
    this.control = new ControlSession(share.id, ownerToken ? 'owner' : 'receiver', { webrtc: rtcSupport().available, ws: typeof WebSocket === 'function', https: true, readable: [...sources.keys()] }, config.limits, ownerToken);
    if (share.transferMode !== 'lan') {
      this.peers = new PeerManager(this.control, config.stunServers, () => {});
      this.peers.onReady = peer => { for (const receiver of this.receivers.values()) if (!receiver.done && receiver.task.ownerId === peer.ownerId) void receiver.upgrade(peer.id); };
    }
    if (ownerToken) this.uploads = new UploadManager(this.control, config.limits, fileId => sources.get(fileId), progress);
    this.control.busy = () => [...this.receivers.values()].some(task => !task.done) || [...this.senders.values()].some(task => task.active);
    this.control.onShare = snapshot => { this.share = snapshot; if (snapshot.status !== 'active') this.stop(); };
    this.control.onEvent = event => { this.queue = this.queue.then(() => this.event(event)).catch(error => { if (event.request) this.progress(event.request.fileId, `未完成：${String(error)}`, event.request.offset, event.request.mode); }); };
    this.control.onBinary = buffer => { try { const frame = decodeFrame(buffer); this.receivers.get([...this.receivers.values()].find(receiver => receiver.task.transferId === frame.transferId)?.task.id ?? '')?.frame(buffer); } catch { /* The receiving task handles timeouts and rejects malformed frames. */ } };
    this.control.onRaw = data => {
      if (data.type === 'relay-credit') {
        const sender = [...this.senders.values()].find(task => task.task.transferId === data.transferId);
        if (sender) sender.credit(data); else this.credits.set(String(data.transferId), data);
      } else if (data.type === 'ws-disconnected') {
        for (const receiver of this.receivers.values()) if (!receiver.done && receiver.task.mode === 'ws') void receiver.advance(new Error('WS 中继断开'));
      } else if (data.type === 'resync' || data.type === 'http-tasks') {
        for (const task of data.requests as DownloadRequest[]) {
          if (ownerToken && task.ownerId === this.control.sessionId) this.control.onEvent({ seq: 0, eventId: '', request: task, type: terminal(task) ? task.status : task.mode === 'r2' ? 'upload-needed' : 'attempt', createdAt: Date.now() });
          const receiver = this.receivers.get(task.id);
          if (receiver && !receiver.done) {
            if (terminal(task) || task.epoch !== receiver.task.epoch || task.mode === 'r2' || task.mode === 'https') void receiver.start(task);
            else if (data.type === 'resync' && task.status === 'connecting' && !receiver.connected) void receiver.advance(new Error('正在重新协商文件连接'));
          }
        }
      } else if (data.type === 'expired') this.stop();
    };
  }
  async start() { try { await this.control.start(); this.peers?.start(); } catch (error) { this.stop(); throw error; } }
  private async event(event: ControlEvent) {
    if (this.stopped) return;
    if (await this.peers?.event(event)) return;
    if (event.type === 'expired') { this.stop(); return; }
    if (event.type === 'file-deleted') {
      const fileId = (event.data as { fileId: string }).fileId;
      for (const receiver of this.receivers.values()) if (receiver.task.fileId === fileId) await receiver.cancel();
      this.sources.delete(fileId); this.progress(fileId, '未完成：文件已被删除', 0); return;
    }
    const task = event.request;
    if (this.ownerToken) {
      const data = event.data as { fileId?: string } | undefined;
      if (event.type === 'upload-needed' && task) { void this.uploads!.start(task.fileId); return; }
      if (event.type === 'upload-pause' && data?.fileId) { this.uploads!.pause(data.fileId); return; }
      if (event.type === 'upload-cancel' && data?.fileId) { this.uploads!.cancel(data.fileId); return; }
      if (!task) return;
      const old = this.senders.get(task.id);
      if (event.type === 'attempt' && task.mode !== 'r2' && !terminal(task)) {
        if (old?.task.epoch === task.epoch) return;
        old?.stop(); const source = this.sources.get(task.fileId);
        if (!source) { await this.control.signal(task, 'source-error', {}); return; }
        const sender = new SendTask(task, source, this.control, this.config.limits, this.config.stunServers, this.progress, this.peers?.get(task.peerId)); this.senders.set(task.id, sender);
        const credit = this.credits.get(task.transferId); if (credit) { sender.credit(credit); this.credits.delete(task.transferId); }
        void sender.start();
      } else if (event.type === 'rtc-answer' || event.type === 'rtc-ice') { if (old?.task.epoch === task.epoch) await old.event(event); }
      else if (['stop-attempt', 'completed', 'canceled', 'failed', 'waiting-source', 'relay-error'].includes(event.type)) {
        old?.stop(); this.senders.delete(task.id);
        if (event.type === 'completed') this.progress(task.fileId, '对方已保存并通过校验', this.share.files.find(file => file.id === task.fileId)?.size ?? 0, task.mode, true);
        else if (event.type === 'failed') this.progress(task.fileId, `未完成：${task.error ?? '传输失败'}`, task.offset, task.mode);
      }
    } else if (task) {
      const receiver = this.receivers.get(task.id);
      if (receiver) await receiver.event(event);
      else { this.events.push(event); if (this.events.length > this.config.limits.eventQueueSize) this.events.shift(); }
    }
  }
  async receive(file: FileInfo, sink: VerifiedSink) {
    for (const [key, task] of this.receivers) if (task.done) this.receivers.delete(key);
    const request = await api<DownloadRequest>(`${this.control.base}/download-requests`, this.control.sessionToken, { fileId: file.id });
    const receiver = new ReceiveTask(request, sink, this.control, this.config.limits, this.config.stunServers, this.progress, peerId => this.peers?.get(peerId));
    this.receivers.set(request.id, receiver); await receiver.start();
    const pending = this.events.splice(0);
    for (const event of pending) if (event.request?.id === request.id) await receiver.event(event); else this.events.push(event);
    return receiver;
  }
  stop() {
    if (this.stopped) return; this.stopped = true; this.control.stop(); this.peers?.stop(); this.uploads?.stop();
    for (const sender of this.senders.values()) sender.stop();
    for (const receiver of this.receivers.values()) if (!receiver.done) void receiver.cancel();
  }
  get alive() { return !this.stopped; }
}

export class ChatTransfers {
  private owners = new Map<string, TransferConnection>();
  private incoming = new Map<string, Promise<TransferConnection>>();
  private downloads = new Map<string, ReceiveTask>();
  private pending = new Set<string>();
  private unavailable = new Set<string>();
  onProgress: Progress = () => {};
  constructor(private config: PublicConfig) {}
  private progress: Progress = (...args) => { this.onProgress(...args); };
  async prepare(files: File[], transferMode: ShareTransferMode, turnstileToken?: string): Promise<ChatAttachment & { ownerToken: string }> {
    const created = await api<ShareInfo & { ownerToken: string }>('/api/shares', undefined, { transferMode, expiresInHours: this.config.limits.defaultShareHours, files: files.map(file => ({ name: file.name, size: file.size, mime: file.type, lastModified: file.lastModified })), ...(turnstileToken ? { turnstileToken } : {}) });
    const sources = new Map(created.files.map((file, index) => [file.id, files[index]]));
    const connection = new TransferConnection(created, this.config, this.progress, sources, created.ownerToken);
    try { await connection.start(); this.owners.set(created.id, connection); }
    catch (error) { await api(`/api/shares/${created.id}`, created.ownerToken, undefined, 'DELETE').catch(() => {}); throw error; }
    return { shareId: created.id, files: created.files, expiresAt: created.expiresAt, transferMode, ownerToken: created.ownerToken };
  }
  async discard(attachment: ChatAttachment & { ownerToken: string }) {
    this.owners.get(attachment.shareId)?.stop(); this.owners.delete(attachment.shareId);
    await api(`/api/shares/${attachment.shareId}`, attachment.ownerToken, undefined, 'DELETE');
  }
  async download(attachment: ChatAttachment, file: FileInfo, sink: VerifiedSink) {
    if (this.busy(file.id)) { await sink.abort(); return; } this.pending.add(file.id);
    try {
      let connection = this.incoming.get(attachment.shareId);
      if (!connection) {
        connection = (async () => { const share = await api<ShareInfo>(`/api/shares/${attachment.shareId}`); const receiver = new TransferConnection(share, this.config, this.progress); await receiver.start(); return receiver; })();
        this.incoming.set(attachment.shareId, connection); void connection.catch(() => this.incoming.delete(attachment.shareId));
      }
      this.downloads.set(file.id, await (await connection).receive(file, sink));
    } catch (error) {
      await sink.abort().catch(() => {});
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) this.unavailable.add(attachment.shareId);
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.progress(file.id, `未完成：${error instanceof Error ? error.message : String(error)}`, 0);
      throw error;
    } finally { this.pending.delete(file.id); }
  }
  busy(fileId: string) { return this.pending.has(fileId) || Boolean(this.downloads.get(fileId) && !this.downloads.get(fileId)!.done); }
  owns(shareId: string) { return this.owners.has(shareId); }
  available(shareId: string) { return !this.unavailable.has(shareId); }
  prune() { for (const [key, owner] of this.owners) if (!owner.alive || owner.share.expiresAt <= Date.now()) { owner.stop(); this.owners.delete(key); } }
  async cancel(fileId: string) { await this.downloads.get(fileId)?.cancel(); }
  samples(fileId: string) {
    const samples: { key: string; bytes: number; mode: string }[] = [];
    const receiver = this.downloads.get(fileId);
    if (receiver && !receiver.done) samples.push({ key: receiver.task.transferId, bytes: receiver.transferredBytes, mode: receiver.task.mode });
    for (const owner of this.owners.values()) for (const sender of owner.senders.values()) if (sender.task.fileId === fileId && sender.active) samples.push({ key: sender.task.transferId, bytes: sender.transferredBytes, mode: sender.task.mode });
    return samples;
  }
  stop() { for (const connection of this.owners.values()) connection.stop(); for (const connection of this.incoming.values()) void connection.then(value => value.stop()).catch(() => {}); this.owners.clear(); this.incoming.clear(); }
}
