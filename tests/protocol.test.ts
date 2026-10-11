import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chooseMultipartPartSize, decodeFrame, encodeFrame, FRAME_HEADER_BYTES, MULTIPART_MIN_PART_BYTES, SINGLE_PUT_MAX_BYTES, urlTtl, validHours, validateFrame, WS_DEFAULT_PAYLOAD_BYTES, WS_MAX_MESSAGE_BYTES } from '../src/shared/protocol';
import { hashFile, VerifiedSink, type FileWriter } from '../src/client/sink';
import { ControlSession } from '../src/client/control';
import { findMultipartUploads, validateParts } from '../src/worker/r2';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { limits } from '../src/worker/config';

const identity = { transferId: 'a'.repeat(32), fileId: 'b'.repeat(32), epoch: 1 };
class Writer implements FileWriter {
  bytes = new Uint8Array(0); closed = false; aborted = false;
  async write(data: Uint8Array) { const next = new Uint8Array(this.bytes.length + data.length); next.set(this.bytes); next.set(data, this.bytes.length); this.bytes = next; }
  async truncate(n: number) { this.bytes = this.bytes.slice(0, n); }
  async seek(_position: number) {}
  async close() { this.closed = true; }
  async abort() { this.aborted = true; this.bytes = new Uint8Array(0); }
}
function file(size: number) { return { id: identity.fileId, name: '原文件.bin', size, mime: 'application/octet-stream', lastModified: 0, uploadStatus: 'none' as const }; }
describe('完整文件协议', () => {
  it.each([1, 6, 24])('接受整数有效期 %s', n => expect(validHours(n)).toBe(true));
  it.each([0, 25, -1, 1.5, '6', NaN, undefined])('拒绝无效有效期 %s', n => expect(validHours(n)).toBe(false));
  it('完整消息计算包含头部，最后一块可以更小', () => {
    const payload = new Uint8Array(WS_MAX_MESSAGE_BYTES - FRAME_HEADER_BYTES);
    expect(encodeFrame({ ...identity, offset: 0, payload }).byteLength).toBe(WS_MAX_MESSAGE_BYTES);
    expect(() => encodeFrame({ ...identity, offset: 0, payload: new Uint8Array(payload.length + 1) })).toThrow();
    expect(decodeFrame(encodeFrame({ ...identity, offset: 17, payload: new Uint8Array([1]) })).offset).toBe(17);
  });
  it('拒绝重复、乱序、串任务、旧 epoch 与越界消息', () => {
    const frame = decodeFrame(encodeFrame({ ...identity, offset: 0, payload: new Uint8Array([1, 2]) }));
    const expected = { ...identity, offset: 0, size: 2 };
    for (const wrong of [{ offset: 1 }, { epoch: 2 }, { fileId: 'c'.repeat(32) }, { transferId: 'd'.repeat(32) }, { size: 1 }]) expect(() => validateFrame(frame, { ...expected, ...wrong })).toThrow();
  });
  it.each([0, 1, 257, 1048577])('输出一个原文件并校验精确字节数和 SHA-256（%s 字节）', async n => {
    const source = new Uint8Array(n); for (let i = 0; i < n; i++) source[i] = (i * 73 + 29) % 256;
    const writer = new Writer(), sink = new VerifiedSink(file(n), writer);
    for (let offset = 0; offset < n; offset += 32768) await sink.frame(encodeFrame({ ...identity, offset, payload: source.subarray(offset, offset + 32768) }), identity.transferId, 1);
    await sink.finish(bytesToHex(sha256(source))); expect(writer.bytes).toEqual(source); expect(writer.closed).toBe(true);
  });
  it('SHA-256 不一致和不完整文件均不能宣布成功', async () => {
    const writer = new Writer(), sink = new VerifiedSink(file(3), writer);
    await sink.write(new Uint8Array([1, 2]), 0); await expect(sink.finish('0'.repeat(64))).rejects.toThrow('完整');
    await sink.write(new Uint8Array([3]), 2); await expect(sink.finish('0'.repeat(64))).rejects.toThrow('SHA-256'); expect(writer.closed).toBe(false); expect(writer.aborted).toBe(true);
  });
  it('模式切换从头写入时清空旧内容和哈希状态', async () => {
    const writer = new Writer(), sink = new VerifiedSink(file(3), writer), bytes = new Uint8Array([3, 2, 1]);
    await sink.write(new Uint8Array([9, 9]), 0); await sink.reset(); await sink.write(bytes, 0); await sink.finish(bytesToHex(sha256(bytes))); expect(writer.bytes).toEqual(bytes);
  });
  it('落盘失败不能进入完成状态', async () => {
    const writer = new Writer(); writer.close = async () => { throw new Error('磁盘写入失败'); };
    const sink = new VerifiedSink(file(0), writer); await expect(sink.finish(bytesToHex(sha256(new Uint8Array())))).rejects.toThrow('磁盘'); expect(writer.aborted).toBe(true);
  });
  it('R2 单次 PUT 按精确字节边界决定，预签名不越过原到期时间', () => {
    expect(SINGLE_PUT_MAX_BYTES).toBe(5363466240); expect(() => urlTtl(1999, 300, 1000)).toThrow();
  });
  it.each([[SINGLE_PUT_MAX_BYTES + 1, 2681733121, 2], [8000000000, 4000000000, 2], [10 * 1024 ** 3, 3579139414, 3]])('Multipart 用最少的大分片传输 %s 字节，不制造极小尾片', (size, expectedPartSize, expectedCount) => {
    const partSize = chooseMultipartPartSize(size, SINGLE_PUT_MAX_BYTES), count = Math.ceil(size / partSize);
    expect(count).toBe(expectedCount); expect(partSize).toBe(expectedPartSize);
    expect(partSize).toBeLessThanOrEqual(SINGLE_PUT_MAX_BYTES);
    expect(partSize).toBeGreaterThanOrEqual(MULTIPART_MIN_PART_BYTES);
    expect(size - partSize * (count - 1)).toBeGreaterThanOrEqual(MULTIPART_MIN_PART_BYTES);
    expect(partSize - (size - partSize * (count - 1))).toBeLessThan(count);
  });
  it('自定义最小分片时保留 5 MiB 非末片，拒绝请求上限和数量越界', () => {
    expect(chooseMultipartPartSize(SINGLE_PUT_MAX_BYTES + 1, MULTIPART_MIN_PART_BYTES)).toBe(MULTIPART_MIN_PART_BYTES);
    for (const cap of [MULTIPART_MIN_PART_BYTES - 1, SINGLE_PUT_MAX_BYTES + 1]) expect(() => chooseMultipartPartSize(SINGLE_PUT_MAX_BYTES + 1, cap)).toThrow();
    expect(() => chooseMultipartPartSize(SINGLE_PUT_MAX_BYTES * 10000 + 1, SINGLE_PUT_MAX_BYTES)).toThrow();
  });
  it('数 GiB 的源文件哈希只读取 8 MiB 内存块，取消后不继续读取', async () => {
    const conf = limits({}), controller = new AbortController(), reads: number[] = [];
    const source = { size: SINGLE_PUT_MAX_BYTES + 1, slice(start: number, end: number) {
      reads.push(end - start); return { async arrayBuffer() { controller.abort(new Error('test canceled')); return new ArrayBuffer(end - start); } };
    } } as Blob;
    await expect(hashFile(source, conf.hashChunkBytes, controller.signal)).rejects.toThrow('test canceled');
    expect(reads).toEqual([8 * 1024 ** 2]);
  });
  it('WS 默认完整消息预留 1 KiB 余量，RTC 和哈希保留独立缓冲', () => {
    const conf = limits({});
    expect(conf.chunkBytes).toBe(WS_DEFAULT_PAYLOAD_BYTES);
    expect(conf.chunkBytes + FRAME_HEADER_BYTES).toBe(WS_MAX_MESSAGE_BYTES - 1024);
    expect(conf.windowBytes).toBe(conf.chunkBytes);
    expect(conf.rtcWindowBytes).toBe(1024 ** 2);
    expect(conf.hashChunkBytes).toBe(8 * 1024 ** 2);
    expect(() => limits({ LIMITS: JSON.stringify({ roomBufferBytes: 128 * 1024 ** 2 }) })).toThrow();
  });
  it('大 WS 消息排队时经 HTTPS 发送心跳，并保留真实 WS 能力', async () => {
    const control = new ControlSession('a'.repeat(32), 'owner', { ws: true, webrtc: false, readable: [identity.fileId] }, limits({}));
    control.sessionToken = 'b'.repeat(64);
    const send = vi.fn(); control.socket = { readyState: WebSocket.OPEN, bufferedAmount: WS_MAX_MESSAGE_BYTES, send } as unknown as WebSocket;
    vi.mocked(fetch).mockResolvedValue(Response.json({ share: {} }));
    await control.heartbeat();
    const [path, request] = vi.mocked(fetch).mock.calls[0];
    expect(path).toBe(`${control.base}/heartbeat`); expect(request!.method).toBe('POST');
    expect(JSON.parse(request!.body as string).capabilities).toEqual({ ws: true, webrtc: false, readable: [identity.fileId] });
    expect(send).not.toHaveBeenCalled();
  });
  it('空闲 WS 继续发送 WS 心跳，无需额外 HTTPS 请求', async () => {
    const control = new ControlSession('a'.repeat(32), 'receiver', { ws: true, webrtc: false, readable: [] }, limits({}));
    const send = vi.fn(); control.socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send } as unknown as WebSocket;
    await control.heartbeat(); expect(send).toHaveBeenCalledOnce(); expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('发送缓冲清空不代表文件消息已被接收，未收到 ACK 时仍经 HTTPS 保持租约', async () => {
    const control = new ControlSession('a'.repeat(32), 'owner', { ws: true, webrtc: false, readable: [identity.fileId] }, limits({}));
    const send = vi.fn(); control.socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send } as unknown as WebSocket;
    control.binary(encodeFrame({ ...identity, offset: 0, payload: new Uint8Array([1, 2, 3]) })); send.mockClear();
    vi.mocked(fetch).mockResolvedValue(Response.json({ share: {} }));
    await control.heartbeat(); expect(vi.mocked(fetch)).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled();
  });
  it('签名仅使用剩余完整秒，拒绝到期授权', () => {
    expect(urlTtl(7200, 300, 1000)).toBe(6); expect(() => urlTtl(1999, 300, 1000)).toThrow();
  });
  it('Multipart 校验真实 parts，完成后才允许完整对象', () => {
    expect(() => validateParts([{ partNumber: 1, size: 8, etag: 'a' }], 10, 8, true)).toThrow();
    expect(() => validateParts([{ partNumber: 1, size: 8, etag: 'a' }, { partNumber: 2, size: 2, etag: 'b' }], 10, 8, true)).not.toThrow();
    expect(() => validateParts([{ partNumber: 1, size: 8, etag: 'a' }, { partNumber: 1, size: 8, etag: 'b' }], 10, 8, false)).toThrow();
  });
  it('遗失 uploadId 时按桶根路径和已登记 key 查询，绝不清理其他 key', async () => {
    const key = 'temporary/share/file/attempt';
    vi.mocked(fetch).mockImplementation(async input => {
      const request = input as Request, url = new URL(request.url);
      expect(url.pathname).toBe('/file-share-temporary/'); expect(url.searchParams.get('prefix')).toBe(key); expect(url.searchParams.has('uploads')).toBe(true);
      return new Response(`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Upload><Key>${key}</Key><UploadId>orphan-id</UploadId></Upload><Upload><Key>unrelated</Key><UploadId>other-id</UploadId></Upload></ListMultipartUploadsResult>`);
    });
    expect(await findMultipartUploads(env, key)).toEqual(['orphan-id']);
  });
  it('拒绝未知配置和不协调的窗口参数', () => { expect(() => limits({ LIMITS: '{"legacy":"x"}' })).toThrow(); expect(() => limits({ LIMITS: '{"chunkBytes":33554432}' })).toThrow(); });
});
