import { assert, HttpError, json } from './util';

const ISOLATE_BUFFER_BYTES = 64 * 1024 ** 2;
let reservedBytes = 0;
const roomRelays = new Map<string, Set<HttpsRelay>>();
export function httpsBufferUsage() { return reservedBytes; }
export function closeHttpsRoom(roomId: string) { for (const relay of [...roomRelays.get(roomId) ?? []]) relay.close('HTTPS 运行实例已重启'); }

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A canceled transfer can have no HTTP caller left to observe its rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Chunk {
  offset: number;
  length: number;
  parts: Uint8Array[];
  published: boolean;
  served: boolean;
  ack: ReturnType<typeof deferred<number>>;
}

/** One bounded, volatile block. Room authorization and durable metadata stay in ShareRoom. */
export class HttpsRelay {
  readonly bufferBytes: number;
  readonly startedAt = Date.now();
  lastAck = Date.now();
  acked: number;
  bytes = 0;
  private chunk?: Chunk;
  private changed = deferred<void>();
  private failure?: HttpError;
  private uploadReader?: ReadableStreamDefaultReader<Uint8Array>;
  private getController?: ReadableStreamDefaultController<Uint8Array>;
  private getWaiting = false;
  private postsWaiting = 0;
  private released = false;
  constructor(readonly size: number, readonly initialOffset: number, readonly chunkBytes: number,
    private validate: () => Promise<void>, private forwarded: (bytes: number) => Promise<void>, private roomId = '') {
    this.acked = initialOffset;
    this.bufferBytes = Math.min(chunkBytes, size - initialOffset);
    assert(reservedBytes + this.bufferBytes <= ISOLATE_BUFFER_BYTES, 429, 'https_buffer', 'HTTPS 运行实例缓冲已满');
    reservedBytes += this.bufferBytes;
    if (roomId) { if (!roomRelays.has(roomId)) roomRelays.set(roomId, new Set()); roomRelays.get(roomId)!.add(this); }
  }
  private check() { if (this.failure) throw this.failure; }
  private notify() { this.changed.resolve(); this.changed = deferred<void>(); }
  private release() {
    if (!this.released && !this.uploadReader) {
      this.released = true; reservedBytes -= this.bufferBytes;
      if (this.roomId) { const entries = roomRelays.get(this.roomId); entries?.delete(this); if (!entries?.size) roomRelays.delete(this.roomId); }
    }
  }
  close(message = 'HTTPS 传输已停止') {
    if (this.failure) return;
    this.failure = new HttpError(409, 'relay_stopped', message);
    this.changed.reject(this.failure); this.chunk?.ack.reject(this.failure);
    this.chunk = undefined;
    this.getController?.error(this.failure); this.getController = undefined;
    void this.uploadReader?.cancel(this.failure).catch(() => {});
    this.release();
  }
  private async wait<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
    signal.throwIfAborted(); this.check();
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      signal.addEventListener('abort', aborted, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => { cleanup(); reject(new HttpError(204, 'chunk_pending', '数据块尚未就绪')); }, timeoutMs);
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async upload(request: Request, offset: number): Promise<Response> {
    this.check();
    const length = Math.min(this.chunkBytes, this.size - offset);
    assert(offset >= this.initialOffset && (offset - this.initialOffset) % this.chunkBytes === 0 && length > 0, 400, 'invalid_offset', 'HTTPS 数据块偏移无效');
    assert(request.headers.get('Content-Type')?.split(';')[0] === 'application/octet-stream' && !request.headers.has('Content-Encoding'), 400, 'binary_required', 'HTTPS 数据块必须使用未压缩的二进制请求体');
    const declared = request.headers.get('Content-Length');
    assert(declared === null || Number(declared) <= length, 413, 'chunk_too_large', 'HTTPS 数据块超出授权长度');
    assert(declared === null || /^\d+$/.test(declared) && Number(declared) === length, 400, 'chunk_length', 'HTTPS 数据块长度不一致');
    if (offset + length <= this.acked) { void request.body?.cancel().catch(() => {}); return json({ offset: this.acked }); }
    assert(offset === this.acked, 409, 'chunk_order', '上一块尚未确认或数据块乱序');
    assert(this.postsWaiting < 3, 429, 'https_busy', '此数据块的上传确认请求过多');
    this.postsWaiting++;
    try {
      let chunk = this.chunk;
      if (chunk) { void request.body?.cancel().catch(() => {}); }
      else {
        const reader = request.body?.getReader();
        assert(reader, 400, 'body_required', '缺少 HTTPS 数据块');
        const payload = new Uint8Array(length);
        chunk = { offset, length, parts: [payload], published: false, served: false, ack: deferred<number>() };
        this.chunk = chunk; this.uploadReader = reader;
        let received = 0;
        try {
          while (true) {
            const next = await reader.read(); this.check(); request.signal.throwIfAborted();
            if (next.done) break;
            assert(received + next.value.byteLength <= length, 413, 'chunk_too_large', 'HTTPS 数据块超出授权长度');
            // A fixed buffer also bounds metadata when a request arrives in many tiny segments.
            payload.set(next.value, received); received += next.value.byteLength;
          }
          assert(received === length, 400, 'chunk_length', 'HTTPS 数据块未完整上传');
          await this.validate(); this.check();
          chunk.published = true; this.notify();
        } catch (error) {
          await reader.cancel().catch(() => {}); chunk.parts = []; chunk.ack.reject(error);
          if (this.chunk === chunk) this.chunk = undefined;
          throw this.failure ?? error;
        } finally { reader.releaseLock(); this.uploadReader = undefined; if (this.failure) this.release(); }
      }
      return json({ offset: await this.wait(chunk.ack.promise, request.signal) });
    } finally { this.postsWaiting--; }
  }
  async download(request: Request, offset: number): Promise<Response> {
    this.check();
    assert(offset === this.acked && offset < this.size, 409, 'chunk_order', 'HTTPS 读取偏移与确认进度不一致');
    assert(!this.getWaiting && !this.getController, 429, 'https_busy', '此任务已有数据块读取请求');
    this.getWaiting = true;
    try {
      const deadline = Date.now() + 25000;
      while (!this.chunk?.published) {
        try { await this.wait(this.changed.promise, request.signal, Math.max(0, deadline - Date.now())); }
        catch (error) { if (error instanceof HttpError && error.status === 204) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } }); throw error; }
      }
      await this.validate(); this.check();
      const chunk = this.chunk;
      assert(chunk?.published && chunk.offset === offset, 409, 'chunk_order', 'HTTPS 数据块已更新');
      let index = 0, partOffset = 0, bytes = 0;
      const done = async () => { if (bytes) { const count = bytes; bytes = 0; await this.forwarded(count); } };
      const body = new ReadableStream<Uint8Array>({
        start: controller => { this.getController = controller; },
        pull: async controller => {
          try {
            this.check();
            if (index < chunk.parts.length) {
              // Stream small views: do not queue a second entire 16–50 MiB block in the response runtime.
              const part = chunk.parts[index], end = Math.min(partOffset + 65536, part.byteLength), view = part.subarray(partOffset, end);
              bytes += view.byteLength; this.bytes += view.byteLength; partOffset = end; controller.enqueue(view);
              if (partOffset === part.byteLength) { index++; partOffset = 0; }
            }
            else { await done(); this.check(); chunk.served = true; this.getController = undefined; controller.close(); }
          } catch (error) { this.getController = undefined; try { controller.error(error); } catch { /* already canceled */ } }
        },
        cancel: async () => { this.getController = undefined; await done(); },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.length), 'Cache-Control': 'no-store', 'X-File-Offset': String(offset) } });
    } finally { this.getWaiting = false; }
  }
  acknowledge(offset: number) {
    this.check();
    if (offset === this.acked && offset > this.initialOffset) return json({ offset });
    const chunk = this.chunk;
    assert(chunk?.published && chunk.served && offset === chunk.offset + chunk.length, 409, 'invalid_ack', 'HTTPS ACK 尚未读取完整数据块或结束偏移无效');
    this.acked = offset; this.lastAck = Date.now(); this.chunk = undefined;
    chunk.parts = []; chunk.ack.resolve(offset); this.notify();
    return json({ offset });
  }
}
