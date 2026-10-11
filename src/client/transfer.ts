import { bytesToHex } from '@noble/hashes/utils.js';
import type { ControlEvent, DownloadRequest, IceServer, UploadAuthorization } from '../shared/types';
import { decodeFrame, encodeFrame, validateFrame } from '../shared/protocol';
import type { Limits } from '../worker/config';
import { api, ApiError, delay } from './api';
import { ControlSession } from './control';
import { hashFile, VerifiedSink } from './sink';

export type Progress = (fileId: string, label: string, bytes: number, mode?: string, finished?: boolean) => void;
const terminal = (task: DownloadRequest) => ['canceled', 'failed', 'completed'].includes(task.status);
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
class SourceReadError extends Error {}

export class SendTask {
  private abort = new AbortController();
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private ice: RTCIceCandidateInit[] = [];
  private acked: number;
  private sent: number;
  private ready = false;
  private running = false;
  private lastAck = Date.now();
  constructor(public task: DownloadRequest, private file: File, private control: ControlSession, private conf: Limits, private stun: IceServer[], private progress: Progress) { this.acked = this.sent = task.offset; }
  async start() {
    try {
      try { await this.file.slice(0, Math.min(1, this.file.size)).arrayBuffer(); } catch { throw new SourceReadError('本地文件不可读，请重新选择原文件'); }
      if (this.task.mode === 'ws') { void this.run(); return; }
      const pc = this.pc = new RTCPeerConnection({ iceServers: this.task.mode === 'turn' ? this.task.iceServers : this.stun, iceTransportPolicy: this.task.mode === 'turn' ? 'relay' : 'all' });
      pc.onicecandidate = event => { if (event.candidate && !this.abort.signal.aborted) void this.control.signal(this.task, 'rtc-ice', { candidate: event.candidate.toJSON() }).catch(error => this.fail(error)); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && !this.abort.signal.aborted) void this.fail(new Error('WebRTC 数据连接失败')); };
      const channel = this.channel = pc.createDataChannel('file', { ordered: true }); channel.binaryType = 'arraybuffer';
      channel.onopen = () => { void this.run(); };
      channel.onclose = () => { if (!this.abort.signal.aborted && !this.running) void this.fail(new Error('数据通道提前关闭')); };
      channel.onerror = () => { void this.fail(new Error('DataChannel 发送失败')); };
      channel.onmessage = event => {
        if (typeof event.data !== 'string') { void this.fail(new Error('发送端收到非法数据帧')); return; }
        try { this.credit(JSON.parse(event.data) as Record<string, unknown>); } catch (error) { void this.fail(error); }
      };
      await pc.setLocalDescription(await pc.createOffer());
      await this.control.signal(this.task, 'rtc-offer', { description: pc.localDescription!.toJSON() });
    } catch (error) { await this.fail(error); }
  }
  credit(data: Record<string, unknown>) {
    if (this.abort.signal.aborted || data.transferId !== this.task.transferId || data.epoch !== this.task.epoch) return;
    const offset = data.offset;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < this.acked || offset > this.sent) throw new Error('接收端 ACK 偏移无效');
    this.ready = true; this.acked = offset; this.lastAck = Date.now();
  }
  async event(event: ControlEvent) {
    if (this.abort.signal.aborted) return;
    if (event.type === 'rtc-answer') {
      const data = event.data as { description: RTCSessionDescriptionInit };
      await this.pc!.setRemoteDescription(data.description); for (const candidate of this.ice.splice(0)) await this.pc!.addIceCandidate(candidate);
    } else if (event.type === 'rtc-ice') {
      const candidate = (event.data as { candidate: RTCIceCandidateInit }).candidate;
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate); else this.ice.push(candidate);
    }
  }
  private check() { this.abort.signal.throwIfAborted(); }
  private async wait(test: () => boolean) {
    while (!test()) { this.check(); if (Date.now() - this.lastAck > this.conf.ackTimeoutMs) throw new Error('接收端 ACK 超时'); await delay(15, this.abort.signal); }
  }
  private async run() {
    if (this.running) return; this.running = true;
    try {
      let hash;
      try { hash = await hashFile(this.file, this.conf.chunkBytes, this.abort.signal, this.task.offset); } catch (error) { this.check(); throw new SourceReadError(messageOf(error)); }
      await this.wait(() => this.ready);
      const chunkBytes = this.task.mode === 'ws' ? this.conf.chunkBytes : Math.min(this.conf.rtcChunkBytes, (this.pc?.sctp?.maxMessageSize || 65536) - 52);
      while (this.sent < this.file.size) {
        this.check(); const length = Math.min(chunkBytes, this.file.size - this.sent);
        await this.wait(() => this.sent + length - this.acked <= this.conf.windowBytes && (this.task.mode === 'ws' ? (this.control.socket?.bufferedAmount ?? Infinity) : (this.channel?.bufferedAmount ?? Infinity)) < this.conf.windowBytes);
        let payload: Uint8Array;
        try { payload = new Uint8Array(await this.file.slice(this.sent, this.sent + length).arrayBuffer()); } catch { throw new SourceReadError('读取本地文件失败'); }
        this.check(); if (payload.byteLength !== length) throw new SourceReadError('源文件读取长度发生变化');
        hash.update(payload);
        const buffer = encodeFrame({ transferId: this.task.transferId, fileId: this.task.fileId, epoch: this.task.epoch, offset: this.sent, payload });
        if (this.task.mode === 'ws') this.control.binary(buffer); else this.channel!.send(buffer);
        this.sent += length; this.progress(this.task.fileId, '正在发送', this.acked, this.task.mode);
      }
      await this.wait(() => this.acked === this.file.size);
      const sha256 = bytesToHex(hash.digest());
      await this.control.signal(this.task, 'file-end', { sha256, size: this.file.size });
      this.check();
      if (this.task.mode !== 'ws') this.channel!.send(JSON.stringify({ kind: 'end', transferId: this.task.transferId, epoch: this.task.epoch, sha256, size: this.file.size }));
      this.progress(this.task.fileId, '等待接收端校验', this.file.size, this.task.mode);
    } catch (error) { await this.fail(error); }
  }
  private async fail(error: unknown) {
    if (this.abort.signal.aborted) return;
    this.stop();
    try { await this.control.signal(this.task, error instanceof SourceReadError ? 'source-error' : 'transport-error', { message: messageOf(error) }); } catch { /* 接收端的超时机制仍会停止旧任务。 */ }
    this.progress(this.task.fileId, messageOf(error), this.acked, this.task.mode);
  }
  stop() { this.abort.abort(new Error('旧传输已终止')); if (this.channel) { this.channel.onclose = null; this.channel.onerror = null; this.channel.close(); } this.pc?.close(); }
}

export class ReceiveTask {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private ice: RTCIceCandidateInit[] = [];
  private abort = new AbortController();
  private serial: Promise<void> = Promise.resolve();
  private generation = 0;
  private received = 0;
  private pendingBytes = 0;
  private timeout?: ReturnType<typeof setTimeout>;
  private advancing = false;
  private finished = false;
  private r2Running = false;
  private startedAttempt = '';
  private deferred: ControlEvent[] = [];
  constructor(public task: DownloadRequest, public sink: VerifiedSink, private control: ControlSession, private conf: Limits, private stun: IceServer[], private progress: Progress) { this.received = sink.offset; }
  async start(task = this.task) {
    if (this.finished || task.epoch < this.task.epoch) return;
    const attemptKey = `${task.epoch}:${task.transferId}:${task.status}`;
    if (this.startedAttempt === attemptKey) return;
    this.startedAttempt = attemptKey;
    if (task.epoch !== this.task.epoch || task.transferId !== this.task.transferId) {
      this.stopTransport(); await this.serial; this.task = task;
      if (task.offset !== this.sink.offset) await this.sink.reset();
      this.received = this.sink.offset; this.pendingBytes = 0; this.abort = new AbortController(); this.ice = [];
    } else this.task = task;
    if (terminal(task)) { if (task.status !== 'completed') await this.fail(new Error(task.error ?? '任务已取消')); return; }
    if (task.status === 'requested') {
      this.progress(task.fileId, task.mode === 'r2' ? '等待分享者上传云端' : '分享者离线或源文件不可读，等待恢复', this.sink.offset, task.mode); return;
    }
    this.progress(task.fileId, task.mode === 'p2p' ? '正在连接直传' : task.mode === 'turn' ? '正在连接 TURN' : task.mode === 'ws' ? '正在连接 WS 中继' : '准备云端下载', this.sink.offset, task.mode);
    if (task.mode === 'ws') { this.control.relayAck(task, this.sink.offset); this.armTimeout(); }
    else if (task.mode === 'r2') { if (task.status === 'transferring') void this.downloadR2(); }
    else this.armTimeout(this.conf.connectTimeoutMs + 15000);
  }
  private armTimeout(ms = this.conf.ackTimeoutMs) {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { void this.advance(new Error('连接或数据等待超时')); }, ms);
  }
  async event(event: ControlEvent) {
    const task = event.request;
    if (!task || this.finished || task.epoch < this.task.epoch) return;
    if (this.advancing && ['attempt', 'rtc-offer', 'rtc-ice', 'file-end', 'r2-ready'].includes(event.type)) { this.deferred.push(event); return; }
    if (event.type === 'attempt') { await this.start(task); return; }
    if (event.type === 'waiting-source') { this.stopTransport(); this.task = task; this.progress(task.fileId, '分享者离线或源文件不可读，等待恢复', this.sink.offset, task.mode); return; }
    if (event.type === 'expired' || event.type === 'canceled' || event.type === 'failed') { await this.fail(new Error(task.error ?? '此分享已结束')); return; }
    if (event.type === 'stop-attempt' || event.type === 'completed') return;
    if (event.type === 'relay-error' || event.type === 'transport-error' || event.type === 'r2-error') { await this.advance(new Error((event.data as { message?: string })?.message ?? task.error ?? '传输失败')); return; }
    if (event.type === 'r2-ready') { this.task = task; void this.downloadR2(); return; }
    if (event.type === 'file-end') { if (this.task.mode === 'ws') await this.finish((event.data as { sha256: string }).sha256); return; }
    if (event.type === 'rtc-offer') {
      if (this.pc) return;
      this.task = task;
      const pc = this.pc = new RTCPeerConnection({ iceServers: task.mode === 'turn' ? task.iceServers : this.stun, iceTransportPolicy: task.mode === 'turn' ? 'relay' : 'all' });
      pc.onicecandidate = candidate => { if (candidate.candidate && !this.finished) void this.control.signal(this.task, 'rtc-ice', { candidate: candidate.candidate.toJSON() }).catch(error => this.advance(error)); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && !this.finished) void this.advance(new Error('WebRTC 连接失败')); };
      pc.ondatachannel = event => this.attach(event.channel);
      await pc.setRemoteDescription((event.data as { description: RTCSessionDescriptionInit }).description);
      for (const candidate of this.ice.splice(0)) await pc.addIceCandidate(candidate);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.control.signal(task, 'rtc-answer', { description: pc.localDescription!.toJSON() });
      this.armTimeout(this.conf.connectTimeoutMs);
    } else if (event.type === 'rtc-ice') {
      const candidate = (event.data as { candidate: RTCIceCandidateInit }).candidate;
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(candidate); else this.ice.push(candidate);
    }
  }
  private attach(channel: RTCDataChannel) {
    this.channel = channel; channel.binaryType = 'arraybuffer';
    const opened = () => { this.ack(); this.armTimeout(); };
    channel.onopen = opened; if (channel.readyState === 'open') opened();
    channel.onerror = () => { void this.advance(new Error('DataChannel 读取失败')); };
    channel.onclose = () => { if (!this.finished && !this.advancing) void this.advance(new Error('数据通道中断')); };
    channel.onmessage = event => {
      if (typeof event.data === 'string') {
        try { const data = JSON.parse(event.data) as { kind: string; epoch: number; transferId: string; sha256: string; size: number }; if (data.epoch !== this.task.epoch || data.transferId !== this.task.transferId) return; if (data.kind !== 'end' || data.size !== this.sink.file.size) throw new Error('文件完成消息无效'); void this.finish(data.sha256).catch(error => this.fail(error)); }
        catch (error) { void this.advance(error); }
      } else this.frame(event.data as ArrayBuffer);
    };
  }
  frame(buffer: ArrayBuffer) {
    if (this.finished || this.advancing) return;
    try {
      const frame = decodeFrame(buffer), generation = this.generation;
      if (frame.epoch !== this.task.epoch || frame.transferId !== this.task.transferId) return;
      validateFrame(frame, { transferId: this.task.transferId, fileId: this.task.fileId, epoch: this.task.epoch, offset: this.received, size: this.sink.file.size });
      if (this.pendingBytes + frame.payload.byteLength > this.conf.windowBytes) throw new Error('接收缓冲超出授权窗口');
      this.received += frame.payload.byteLength; this.pendingBytes += frame.payload.byteLength;
      this.serial = this.serial.then(async () => {
        if (generation !== this.generation || this.finished) return;
        await this.sink.write(frame.payload, frame.offset); this.pendingBytes -= frame.payload.byteLength;
        if (generation !== this.generation) return;
        this.ack(); this.armTimeout(); this.progress(this.task.fileId, '正在接收', this.sink.offset, this.task.mode);
      }).catch(error => { void this.advance(error); });
    } catch (error) { void this.advance(error); }
  }
  private ack() {
    if (this.task.mode === 'ws') this.control.relayAck(this.task, this.sink.offset);
    else if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ kind: 'ack', transferId: this.task.transferId, epoch: this.task.epoch, offset: this.sink.offset }));
  }
  private async finish(sha256: string) {
    if (this.finished || this.advancing) return;
    clearTimeout(this.timeout); await this.serial;
    this.progress(this.task.fileId, '校验 SHA-256 并保存文件', this.sink.offset, this.task.mode);
    const actual = await this.sink.finish(sha256); this.finished = true;
    this.stopTransport();
    this.progress(this.task.fileId, this.sink.native ? '下载完成 · SHA-256 已校验' : 'SHA-256 已校验 · 已交给浏览器保存', this.sink.offset, this.task.mode, true);
    try { await this.control.signal(this.task, 'completed', { sha256: actual, size: this.sink.file.size }); } catch { /* 已校验并完成保存，不回退重新写入文件。 */ }
  }
  private async downloadR2() {
    if (this.r2Running || this.finished || this.advancing) return; this.r2Running = true;
    const generation = this.generation;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.sink.reset(); this.received = 0;
          const auth = await api<{ url: string; sha256: string; size: number }>(`${this.control.base}/files/${this.task.fileId}/download`, this.control.sessionToken, { requestId: this.task.id, epoch: this.task.epoch });
          if (auth.size !== this.sink.file.size) throw new Error('云端文件身份不一致');
          const response = await fetch(auth.url, { signal: this.abort.signal });
          if (!response.ok || !response.body) throw new Error(`R2 直连下载失败 (${response.status})`);
          const reader = response.body.getReader();
          try {
            while (true) {
              this.abort.signal.throwIfAborted();
              const next = await reader.read(); if (next.done) break;
              for (let offset = 0; offset < next.value.byteLength; offset += this.conf.chunkBytes) {
                await this.sink.write(next.value.subarray(offset, offset + this.conf.chunkBytes), this.sink.offset);
                this.progress(this.task.fileId, '从云端直接下载', this.sink.offset, 'r2');
              }
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          await this.finish(auth.sha256); return;
        } catch (error) {
          if (this.abort.signal.aborted || generation !== this.generation || this.finished || (error instanceof ApiError && [403, 409, 410, 429].includes(error.status)) || this.sink.closed || attempt === 1) throw error;
          this.progress(this.task.fileId, '云端直连中断，正在从头重试', 0, 'r2'); await delay(1000, this.abort.signal);
        }
      }
    } catch (error) { if (!this.abort.signal.aborted && !this.finished && generation === this.generation) await this.advance(error); }
    finally { this.r2Running = false; }
  }
  async advance(error: unknown) {
    if (this.finished || this.advancing) return; this.advancing = true;
    this.stopTransport(); await this.serial;
    try {
      this.progress(this.task.fileId, `正在切换传输方式：${messageOf(error)}`, this.sink.offset, this.task.mode);
      const task = await api<DownloadRequest>(`${this.control.base}/download-requests/${this.task.id}/advance`, this.control.sessionToken, { epoch: this.task.epoch, offset: this.sink.offset, reason: messageOf(error) });
      this.advancing = false; await this.start(task);
      for (const event of this.deferred.splice(0)) if (event.type !== 'attempt') await this.event(event);
    } catch (failure) { this.advancing = false; await this.fail(failure); }
  }
  private stopTransport() { this.generation++; clearTimeout(this.timeout); this.abort.abort(new Error('旧传输已停止')); if (this.channel) { this.channel.onclose = null; this.channel.onerror = null; this.channel.close(); } this.pc?.close(); this.pc = undefined; this.channel = undefined; }
  async fail(error: unknown) { if (this.finished) return; this.finished = true; this.stopTransport(); await this.serial; await this.sink.abort().catch(() => {}); this.progress(this.task.fileId, `未完成：${messageOf(error)}`, this.sink.offset, this.task.mode); }
  async cancel() { if (this.finished) return; await this.fail(new Error('已取消')); await api(`${this.control.base}/download-requests/${this.task.id}`, this.control.sessionToken, undefined, 'DELETE').catch(() => {}); }
  get done() { return this.finished; }
  get connected() { return this.channel?.readyState === 'open' && !this.finished; }
}

export class UploadManager {
  private running = new Map<string, { abort: AbortController; paused: boolean; hashingIdentity: boolean; attemptId?: string }>();
  constructor(private control: ControlSession, private conf: Limits, private source: (id: string) => File | undefined, private progress: Progress) {}
  pause(fileId: string) { const current = this.running.get(fileId); if (current) { current.paused = true; if (current.hashingIdentity) { current.abort.abort(new Error('上传暂停')); this.progress(fileId, '云端上传暂停，等待新的下载需求', 0, 'r2'); } } }
  cancel(fileId: string) { this.running.get(fileId)?.abort.abort(new Error('上传需求已结束')); }
  stop() { for (const entry of this.running.values()) entry.abort.abort(new Error('分享已结束')); }
  async start(fileId: string) {
    if (this.running.has(fileId)) return;
    const file = this.source(fileId); if (!file) return;
    const entry = { abort: new AbortController(), paused: false, hashingIdentity: false, attemptId: undefined as string | undefined }; this.running.set(fileId, entry);
    let hashPromise: ReturnType<typeof hashFile> | undefined;
    try {
      const auth = await api<UploadAuthorization>(`${this.control.base}/files/${fileId}/uploads`, this.control.sessionToken, {});
      if (auth.shared || auth.ready) return;
      entry.attemptId = auth.attemptId; entry.abort.signal.throwIfAborted();
      hashPromise = hashFile(file, this.conf.chunkBytes, entry.abort.signal); void hashPromise.catch(() => {});
      if (auth.mode === 'put') await this.put(auth.url!, file, auth.headers!, entry.abort.signal, bytes => this.progress(fileId, '整文件直接上传到 R2', bytes, 'r2'));
      else {
        entry.hashingIdentity = true; this.progress(fileId, '校验源文件，确保分片续传使用原内容', 0, 'r2');
        const hash = await hashPromise; entry.abort.signal.throwIfAborted();
        await api(`${this.control.base}/files/${fileId}/identity`, this.control.sessionToken, { attemptId: auth.attemptId, sha256: bytesToHex(hash.clone().digest()) });
        entry.hashingIdentity = false;
        const count = Math.ceil(file.size / auth.partSize), existing = new Map(auth.uploadedParts.map(part => [part.partNumber, part]));
        let uploaded = auth.uploadedParts.reduce((n, part) => n + part.size, 0);
        for (let part = 1; part <= count; part++) {
          entry.abort.signal.throwIfAborted();
          if (entry.paused) { this.progress(fileId, '云端上传暂停，等待新的下载需求', uploaded, 'r2'); entry.abort.abort(new Error('暂停')); return; }
          if (existing.has(part)) continue;
          const signed = await api<{ url: string; headers: Record<string, string> }>(`${this.control.base}/files/${fileId}/parts/${part}/sign`, this.control.sessionToken, { attemptId: auth.attemptId });
          const blob = file.slice((part - 1) * auth.partSize, Math.min(file.size, part * auth.partSize));
          await this.put(signed.url, blob, signed.headers, entry.abort.signal, bytes => this.progress(fileId, `直接上传到 R2 · ${part}/${count}`, uploaded + bytes, 'r2'));
          uploaded += blob.size;
        }
        if (entry.paused) { this.progress(fileId, '云端上传暂停，等待新的下载需求', uploaded, 'r2'); return; }
      }
      entry.abort.signal.throwIfAborted();
      this.progress(fileId, '确认完整对象与源文件 SHA-256', file.size, 'r2');
      const hash = await hashPromise;
      await api(`${this.control.base}/files/${fileId}/complete`, this.control.sessionToken, { attemptId: auth.attemptId, sha256: bytesToHex(hash.digest()) });
      this.progress(fileId, '云端可下载 · 分享者可以离线', file.size, 'r2', true);
    } catch (error) {
      if (!entry.abort.signal.aborted) {
        entry.abort.abort(error); this.progress(fileId, `云端上传未完成：${messageOf(error)}`, 0, 'r2');
        let sourceUnavailable = error instanceof DOMException && ['NotFoundError', 'NotReadableError'].includes(error.name);
        try { await file.slice(0, Math.min(1, file.size)).arrayBuffer(); } catch { sourceUnavailable = true; }
        if (entry.attemptId) await api(`${this.control.base}/files/${fileId}/abort`, this.control.sessionToken, { attemptId: entry.attemptId }).catch(() => {});
        await api(`${this.control.base}/files/${fileId}/failure`, this.control.sessionToken, { reason: messageOf(error), sourceUnavailable }).catch(() => {});
      }
    } finally { if (hashPromise) await hashPromise.catch(() => {}); this.running.delete(fileId); }
  }
  private put(url: string, file: Blob, headers: Record<string, string>, signal: AbortSignal, progress: (bytes: number) => void) {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted(); const xhr = new XMLHttpRequest();
      xhr.open('PUT', url); for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = event => progress(event.loaded);
      const abort = () => xhr.abort(); signal.addEventListener('abort', abort, { once: true });
      const cleanup = () => signal.removeEventListener('abort', abort);
      xhr.onload = () => { cleanup(); xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`R2 直传失败 (${xhr.status})`)); };
      xhr.onerror = () => { cleanup(); reject(new Error('R2 直传网络失败，请检查桶 CORS 与网络连接')); };
      xhr.onabort = () => { cleanup(); reject(new Error('R2 上传已取消')); };
      xhr.send(file);
    });
  }
}
