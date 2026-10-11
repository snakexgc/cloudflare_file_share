import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeFrame, encodeFrame, FRAME_HEADER_BYTES, SINGLE_PUT_MAX_BYTES, urlTtl, validHours, validateFrame, WS_MAX_MESSAGE_BYTES } from '../src/shared/protocol';
import { VerifiedSink, type FileWriter } from '../src/client/sink';
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
