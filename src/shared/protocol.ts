export const WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const FRAME_HEADER_BYTES = 52;
export const WS_MAX_PAYLOAD_BYTES = WS_MAX_MESSAGE_BYTES - FRAME_HEADER_BYTES;
// 避免把实际网络消息顶在平台极值上；云端链路验证使用 1 KiB 余量。
export const WS_DEFAULT_PAYLOAD_BYTES = WS_MAX_PAYLOAD_BYTES - 1024;
export const SINGLE_PUT_MAX_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 ** 2;
export const MULTIPART_MAX_PARTS = 10000;
export const FRAME_MAGIC = 0x46534831;
export const ID_PATTERN = /^[a-f0-9]{32}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export interface Frame {
  transferId: string;
  fileId: string;
  epoch: number;
  offset: number;
  payload: Uint8Array;
}
function writeId(view: Uint8Array, at: number, id: string) {
  if (!ID_PATTERN.test(id)) throw new Error('无效任务标识');
  for (let i = 0; i < 16; i++) view[at + i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
}
function readId(view: Uint8Array, at: number) {
  return Array.from(view.subarray(at, at + 16), b => b.toString(16).padStart(2, '0')).join('');
}
export function encodeFrame(frame: Frame, maxBytes = WS_MAX_MESSAGE_BYTES): ArrayBuffer {
  if (!Number.isSafeInteger(frame.offset) || frame.offset < 0 || !Number.isInteger(frame.epoch) || frame.epoch < 1 || frame.epoch > 0xffffffff) throw new Error('无效偏移或 epoch');
  if (!frame.payload.byteLength || FRAME_HEADER_BYTES + frame.payload.byteLength > maxBytes) throw new Error('消息大小超限');
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const data = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  data.setUint32(0, FRAME_MAGIC);
  data.setUint32(4, frame.epoch);
  writeId(bytes, 8, frame.transferId);
  data.setBigUint64(24, BigInt(frame.offset));
  data.setUint32(32, frame.payload.byteLength);
  writeId(bytes, 36, frame.fileId);
  bytes.set(frame.payload, FRAME_HEADER_BYTES);
  return buffer;
}
export function decodeFrame(buffer: ArrayBuffer, maxBytes = WS_MAX_MESSAGE_BYTES): Frame {
  if (buffer.byteLength < FRAME_HEADER_BYTES || buffer.byteLength > maxBytes) throw new Error('消息大小超限');
  const data = new DataView(buffer);
  if (data.getUint32(0) !== FRAME_MAGIC || data.getUint32(4) === 0) throw new Error('无效协议头');
  const offset = Number(data.getBigUint64(24));
  const length = data.getUint32(32);
  if (!Number.isSafeInteger(offset) || !length || length !== buffer.byteLength - FRAME_HEADER_BYTES) throw new Error('无效块长度或偏移');
  const bytes = new Uint8Array(buffer);
  return { transferId: readId(bytes, 8), fileId: readId(bytes, 36), epoch: data.getUint32(4), offset, payload: bytes.subarray(FRAME_HEADER_BYTES) };
}
export function validateFrame(frame: Frame, expected: { transferId: string; fileId: string; epoch: number; offset: number; size: number }) {
  if (frame.transferId !== expected.transferId || frame.fileId !== expected.fileId || frame.epoch !== expected.epoch) throw new Error('迟到数据或任务身份不一致');
  if (frame.offset !== expected.offset || frame.offset + frame.payload.byteLength > expected.size) throw new Error('块乱序、重复或越界');
}
export function validHours(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 24; }
/** 用最少的请求均衡分片；同一上传的非末片保持同样大小。 */
export function chooseMultipartPartSize(size: number, maxPartBytes: number) {
  if (!Number.isSafeInteger(size) || size <= SINGLE_PUT_MAX_BYTES || !Number.isSafeInteger(maxPartBytes) || maxPartBytes < MULTIPART_MIN_PART_BYTES || maxPartBytes > SINGLE_PUT_MAX_BYTES) throw new Error('Multipart 文件或分片大小无效');
  const count = Math.ceil(size / maxPartBytes);
  if (count > MULTIPART_MAX_PARTS) throw new Error('Multipart 分片数量超出 R2 限制');
  const balanced = Math.ceil(size / count);
  return balanced >= MULTIPART_MIN_PART_BYTES ? balanced : maxPartBytes;
}
export function urlTtl(expiresAt: number, configured: number, now = Date.now()) {
  const remaining = Math.floor((expiresAt - now) / 1000);
  if (remaining < 1) throw new Error('分享已过期');
  return Math.min(configured, remaining);
}
