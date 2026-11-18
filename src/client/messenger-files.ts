import type { MessengerFile, MessengerTransfer } from '../shared/messenger';
import type { FileInfo, ShareInfo, ShareTransferMode } from '../shared/types';
import { api, ApiError, makeId } from './api';
import type { PublicConfig } from './config';
import { messengerChallenge } from './messenger-challenge';
import { MessengerSources, type LocalSource } from './messenger-sources';
import { TransferConnection } from './share-transfer';
import { chooseSink, type VerifiedSink } from './sink';
import type { Progress, ReceiveTask } from './transfer';

interface Room {
  shareId: string;
  shareFileId: string;
  ownerToken: string;
  password: string;
  expiresAt: number;
}
interface Host { room: Room; fileId: string; connection: TransferConnection; published: boolean }
interface Download {
  file: MessengerFile;
  ticketId?: string;
  sink?: VerifiedSink;
  connection?: TransferConnection;
  task?: ReceiveTask;
  timeout?: ReturnType<typeof setTimeout>;
}
const transfersUrl = '/api/messenger/transfers';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const transient = (error: unknown) => (error instanceof ApiError && error.status >= 500) || error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError');
const asInfo = (file: MessengerFile, id = file.id): FileInfo => ({
  id, name: file.name, size: file.size, mime: file.mime, lastModified: file.lastModified, uploadStatus: 'none',
});

export class MessengerFiles {
  onProgress: Progress = () => {};
  onNotice = (_message: string) => {};
  private sources: MessengerSources;
  private downloads = new Map<string, Download>();
  private hosts = new Map<string, Host>();
  private handling = new Set<string>();
  private missing = new Map<string, number>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private lifetime = new AbortController();
  private challengeQueue = Promise.resolve();
  private roomKey: string;

  constructor(private userId: string, private token: string, private config: PublicConfig) {
    this.sources = new MessengerSources(userId, token);
    this.roomKey = `file-share.messenger.room.${userId}.`;
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(this.roomKey) && !(JSON.parse(localStorage.getItem(key)!).expiresAt > Date.now())) localStorage.removeItem(key);
      }
    } catch { /* A browser with storage disabled can still serve this tab's files. */ }
  }

  /** Only local storage is touched. Callers register the returned metadata in the drive. */
  async prepare(file: File, transferMode: ShareTransferMode = 'auto') {
    this.lifetime.signal.throwIfAborted();
    if (file.size > Math.min(this.config.limits.maxFileBytes, this.config.limits.maxShareBytes)) throw new Error('文件大小超出传输限制');
    const metadata = { id: makeId(), name: file.name, size: file.size, mime: file.type || 'application/octet-stream', lastModified: file.lastModified, transferMode };
    const persisted = await this.sources.save({ ...metadata, ownerId: this.userId, blob: file });
    this.lifetime.signal.throwIfAborted();
    if (!persisted) this.onNotice(`浏览器未能保存「${file.name}」的本地副本。此文件只能在当前页面打开时提供下载。`);
    return metadata;
  }

  async forget(fileId: string) {
    try { await this.sources.remove(fileId); }
    finally { for (const [ticketId, host] of this.hosts) if (host.fileId === fileId) this.closeHost(ticketId, true); }
  }

  busy(fileId: string) {
    const job = this.downloads.get(fileId);
    return !!job && !job.task?.done;
  }

  /** The save picker must run during the initiating click, before any network or storage await. */
  async download(file: MessengerFile, conversationId?: string) {
    this.lifetime.signal.throwIfAborted();
    if (this.busy(file.id)) return;
    const previous = this.downloads.get(file.id);
    if (previous) void this.endDownload(previous);
    const job: Download = { file };
    this.downloads.set(file.id, job);
    try {
      job.sink = await chooseSink(asInfo(file), this.config.limits.memoryDownloadBytes);
      if (!this.current(job)) { await job.sink.abort(); return; }
      const { transfer } = await api<{transfer: MessengerTransfer}>(transfersUrl, this.token, { fileId: file.id, conversationId });
      if (!this.current(job)) { await this.releaseTicket(transfer.id); return; }
      job.ticketId = transfer.id;
      job.timeout = setTimeout(() => { void this.endDownload(job, '等待超时，请确认发送文件的设备在线后重新下载'); }, Math.max(0, transfer.expiresAt - Date.now()));
      this.onProgress(file.id, '已请求下载，等待保存原文件的设备响应', 0);
      this.observe([transfer]);
    } catch (error) {
      await this.endDownload(job);
      throw error;
    }
  }

  observe(tickets: readonly MessengerTransfer[]) {
    if (this.lifetime.signal.aborted) return;
    for (const [id, host] of this.hosts) if (!host.connection.alive || host.room.expiresAt <= Date.now()) this.closeHost(id, false);
    for (const [id, expiry] of this.missing) if (expiry <= Date.now()) this.missing.delete(id);
    for (const ticket of tickets) {
      const job = this.downloads.get(ticket.fileId);
      if (ticket.requesterId === this.userId && job?.ticketId === ticket.id && job.file.ownerId === ticket.ownerId && !job.connection) {
        if (ticket.status === 'failed') void this.endDownload(job, ticket.reason || '发送设备无法提供此文件');
        else if (ticket.status === 'ready' && ticket.expiresAt > Date.now()) void this.receive(job, ticket);
      }
      if (ticket.ownerId !== this.userId || ticket.expiresAt <= Date.now() || this.handling.has(ticket.id) || this.retries.has(ticket.id)) continue;
      const host = this.hosts.get(ticket.id);
      if (ticket.status === 'failed' || (host && ticket.shareId && host.room.shareId !== ticket.shareId)) {
        if (host) this.closeHost(ticket.id, true);
        continue;
      }
      if (host?.published || (ticket.status === 'ready' && !host && !this.readRoom(ticket.id, ticket.shareId))) continue;
      this.handling.add(ticket.id);
      void this.serve(ticket).catch(error => {
        if (!this.lifetime.signal.aborted) {
          if (transient(error)) this.retryTicket(ticket);
          else this.onNotice(errorText(error));
        }
      }).finally(() => this.handling.delete(ticket.id));
    }
  }

  private retryTicket(ticket: MessengerTransfer) {
    if (this.lifetime.signal.aborted || Date.now() + 8000 >= ticket.expiresAt || this.retries.has(ticket.id)) return;
    const timer = setTimeout(async () => {
      this.retries.delete(ticket.id);
      try {
        const { transfer } = await api<{transfer: MessengerTransfer}>(`${transfersUrl}/${ticket.id}`, this.token);
        this.observe([transfer]);
      } catch (error) {
        if (transient(error)) this.retryTicket(ticket);
        else this.closeHost(ticket.id, true);
      }
    }, 8000);
    this.retries.set(ticket.id, timer);
  }

  private current(job: Download) { return !this.lifetime.signal.aborted && this.downloads.get(job.file.id) === job; }

  private async receive(job: Download, ticket: MessengerTransfer) {
    try {
      if (!ticket.shareId || !ticket.shareFileId || !ticket.password) throw new Error('文件传输凭据缺失，请重新下载');
      clearTimeout(job.timeout);
      const file = asInfo(job.file, ticket.shareFileId);
      const connection = job.connection = new TransferConnection({
        id: ticket.shareId, transferMode: job.file.transferMode, files: [file], expiresAt: ticket.expiresAt,
      }, this.config, (_fileId, ...progress) => {
        if (this.current(job)) this.onProgress(job.file.id, ...progress);
      }, undefined, undefined, ticket.password);
      connection.onTerminal = task => {
        if (task.fileId === file.id && this.current(job)) void this.endDownload(job);
      };
      job.timeout = setTimeout(() => { void this.endDownload(job, '文件传输已过期，请重新下载'); }, Math.max(0, ticket.expiresAt - Date.now()));
      await connection.start();
      if (!this.current(job)) return;
      // Use the canonical file descriptor (including any source hash) in the verified sink.
      const snapshot = await api<ShareInfo>(connection.control.base, connection.control.sessionToken);
      const actual = snapshot.files.find(candidate => candidate.id === file.id);
      if (!actual || actual.name !== file.name || actual.size !== file.size || actual.mime !== file.mime || actual.lastModified !== file.lastModified) throw new Error('发送端文件与下载元数据不一致');
      if (!this.current(job)) return;
      job.sink!.file = actual;
      job.task = await connection.receive(actual, job.sink!);
    } catch (error) { await this.endDownload(job, errorText(error)); }
  }

  private readRoom(ticketId: string, shareId?: string): Room | undefined {
    try {
      const prefix = this.roomKey + ticketId + '.';
      const key = shareId ? prefix + shareId : Object.keys(localStorage).find(key => key.startsWith(prefix));
      const raw = key && localStorage.getItem(key);
      if (raw) { const record = JSON.parse(raw) as Room; if (record.expiresAt > Date.now()) return record; }
    } catch { /* Reload recovery requires local storage. */ }
  }
  private rememberRoom(id: string, room: Room, remove = false) {
    const key = this.roomKey + id + '.' + room.shareId;
    try { if (remove) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(room)); }
    catch { if (!remove) this.onNotice('浏览器未能保存本次传输的连接信息。请保持页面打开，刷新后接收者可能需要重新下载。'); }
  }

  private async createRoom(source: LocalSource, deadline: number) {
    if (deadline <= Date.now()) throw new Error('下载请求已过期');
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
    let turnstileToken: string | undefined;
    if (this.config.challengeRequired) {
      const next = this.challengeQueue.then(() => messengerChallenge(this.config.turnstileSiteKey, source.name, signal));
      this.challengeQueue = next.then(() => {}, () => {});
      turnstileToken = await next;
    }
    signal.throwIfAborted();
    const password = makeId() + makeId();
    const share = await api<ShareInfo & {ownerToken: string}>('/api/shares', undefined, {
      transferMode: source.transferMode, password, expiresInHours: this.config.limits.defaultShareHours, turnstileToken,
      files: [{ name: source.name, size: source.blob.size, mime: source.mime, lastModified: source.lastModified }],
    });
    return { shareId: share.id, shareFileId: share.files[0].id, ownerToken: share.ownerToken, password, expiresAt: share.expiresAt };
  }

  private async serve(ticket: MessengerTransfer) {
    let host = this.hosts.get(ticket.id);
    try {
      if (!host) {
        const source = await this.sources.get(ticket.fileId);
        // Another device of this account may have the bytes and can still claim the request.
        if (this.lifetime.signal.aborted) return;
        if (!source) {
          if (!this.missing.has(ticket.id)) {
            this.missing.set(ticket.id, ticket.expiresAt);
            this.onProgress(ticket.fileId, '本设备缺少原文件，等待保存原文件的设备响应', 0);
          }
          return;
        }
        let room = this.readRoom(ticket.id, ticket.shareId);
        if (ticket.status === 'ready' && (!room || room.shareId !== ticket.shareId)) return;
        room ??= await this.createRoom(source, ticket.expiresAt);
        if (this.lifetime.signal.aborted) { if (ticket.status === 'pending') await this.revoke(room); return; }
        const file = source.blob instanceof File ? source.blob : new File([source.blob], source.name, { type: source.mime, lastModified: source.lastModified });
        const info: FileInfo = { id: room.shareFileId, name: source.name, size: file.size, mime: source.mime, lastModified: source.lastModified, uploadStatus: 'none' };
        const connection = new TransferConnection({ id: room.shareId, files: [info], expiresAt: room.expiresAt, transferMode: source.transferMode }, this.config,
          (_id, ...progress) => { if (!this.lifetime.signal.aborted && !this.busy(source.id)) this.onProgress(source.id, ...progress); }, new Map([[info.id, file]]), room.ownerToken);
        host = { fileId: source.id, room, connection, published: ticket.status === 'ready' };
        this.hosts.set(ticket.id, host);
        this.rememberRoom(ticket.id, room);
        connection.onTerminal = () => this.closeHost(ticket.id, true);
        await connection.start();
      }
      if (host.published || this.lifetime.signal.aborted) return;
      if (ticket.status === 'ready') { host.published = true; return; }
      const { shareId, shareFileId, ownerToken, password } = host.room;
      try {
        await api(`${transfersUrl}/${ticket.id}`, this.token, { status: 'ready', shareId, shareFileId, ownerToken, password }, 'PATCH');
      } catch (error) {
        // A lost response or a competing browser may already have fulfilled the ticket.
        const { transfer } = await api<{transfer: MessengerTransfer}>(`${transfersUrl}/${ticket.id}`, this.token);
        if (transfer.status !== 'ready') throw error;
        if (transfer.shareId !== shareId) { this.closeHost(ticket.id, true); return; }
      }
      host.published = true;
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      if (transient(error)) {
        // A recipient may already hold this room. Reopen it with the saved owner key.
        if (host && !host.connection.alive) this.hosts.delete(ticket.id);
        throw error;
      }
      if (host && !host.connection.alive) this.closeHost(ticket.id, true);
      if (error instanceof ApiError && (error.code === 'transfer_not_found' || error.code === 'file_not_found')) {
        this.closeHost(ticket.id, true); return;
      }
      if (ticket.status === 'pending') {
        try { await api(`${transfersUrl}/${ticket.id}`, this.token, { status: 'failed', reason: errorText(error).slice(0, 200) }, 'PATCH'); }
        finally { this.closeHost(ticket.id, true); }
      } else throw error;
    }
  }

  private revoke(room: Room) { return api(`/api/shares/${room.shareId}`, room.ownerToken, undefined, 'DELETE').catch(() => {}); }
  private releaseTicket(ticketId: string) { return api(`${transfersUrl}/${ticketId}`, this.token, undefined, 'DELETE').catch(() => {}); }
  private closeHost(ticketId: string, revoke: boolean) {
    const host = this.hosts.get(ticketId);
    if (!host) return;
    this.hosts.delete(ticketId);
    host.connection.stop();
    this.rememberRoom(ticketId, host.room, true);
    if (revoke) void this.revoke(host.room);
  }
  private async endDownload(job: Download, reason?: string) {
    if (this.downloads.get(job.file.id) !== job) return;
    this.downloads.delete(job.file.id);
    clearTimeout(job.timeout); job.connection?.stop();
    if (job.ticketId) void this.releaseTicket(job.ticketId);
    await job.sink?.abort().catch(() => {});
    if (reason && !this.lifetime.signal.aborted) this.onProgress(job.file.id, `未完成：${reason}`, job.sink?.offset ?? 0);
  }
  async cancel(fileId: string) {
    const job = this.downloads.get(fileId);
    if (job) await this.endDownload(job, '已取消');
  }
  stop() {
    this.lifetime.abort();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const job of this.downloads.values()) void this.endDownload(job);
    // Keep the owner credential until expiry so reopening the sender can serve a ready ticket.
    for (const host of this.hosts.values()) host.connection.stop();
    this.hosts.clear(); this.sources.close();
  }
}
