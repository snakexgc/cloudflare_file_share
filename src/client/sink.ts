import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { FileInfo } from '../shared/types';
import { decodeFrame, validateFrame } from '../shared/protocol';

export interface FileWriter {
  write(data: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export class VerifiedSink {
  offset = 0;
  closed = false;
  private hash = sha256.create();
  constructor(public file: FileInfo, private writer: FileWriter, public native = true) {}
  async reset() {
    if (this.closed) throw new Error('文件写入器已关闭');
    await this.writer.truncate(0); await this.writer.seek(0); this.offset = 0; this.hash = sha256.create();
  }
  async write(payload: Uint8Array, offset: number) {
    if (this.closed || offset !== this.offset || this.offset + payload.byteLength > this.file.size) throw new Error('文件块重复、乱序或越界');
    await this.writer.write(payload); this.hash.update(payload); this.offset += payload.byteLength;
  }
  async frame(buffer: ArrayBuffer, transferId: string, epoch: number) {
    const frame = decodeFrame(buffer);
    validateFrame(frame, { transferId, fileId: this.file.id, epoch, offset: this.offset, size: this.file.size });
    await this.write(frame.payload, frame.offset);
  }
  async finish(expectedHash: string) {
    if (this.closed || this.offset !== this.file.size) throw new Error('尚未收到完整文件');
    const actual = bytesToHex(this.hash.digest());
    if (actual !== expectedHash || (this.file.sha256 && this.file.sha256 !== actual)) { await this.abort(); throw new Error('SHA-256 不匹配，文件未完成'); }
    try { await this.writer.close(); this.closed = true; }
    catch (error) { await this.abort(); throw error; }
    return actual;
  }
  async abort() { if (!this.closed) { this.closed = true; await this.writer.abort(); } }
}
class MemoryWriter implements FileWriter {
  private parts: Uint8Array[] = [];
  private total = 0;
  constructor(private name: string, private mime: string, private maximum: number) {}
  async write(bytes: Uint8Array) {
    if (this.total + bytes.byteLength > this.maximum) throw new Error('此浏览器的内存下载上限已达到，请使用支持文件流的浏览器');
    this.parts.push(Uint8Array.from(bytes)); this.total += bytes.byteLength;
  }
  async truncate(size: number) { if (size !== 0) throw new Error('此写入器只支持从头重试'); this.parts = []; this.total = 0; }
  async seek(position: number) { if (position !== 0) throw new Error('此写入器不支持随机定位'); }
  async close() {
    const blob = new Blob(this.parts as BlobPart[], { type: this.mime });
    this.parts = [];
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = this.name; anchor.hidden = true; (document.body as unknown as HTMLDivElement).appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async abort() { this.parts = []; this.total = 0; }
}
export interface SaveHandle { createWritable(): Promise<FileWriter> }
export async function chooseSink(file: FileInfo, memoryLimit: number) {
  const picker = (window as unknown as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle> }).showSaveFilePicker;
  if (picker) {
    const handle = await picker({ suggestedName: file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') });
    const writer = await handle.createWritable(); await writer.truncate(0); await writer.seek(0);
    return new VerifiedSink(file, writer);
  }
  if (file.size > memoryLimit) throw new Error(`此浏览器不支持大文件流式保存。请使用桌面 Chrome / Edge；当前内存下载上限为 ${Math.floor(memoryLimit / 1024 ** 2)} MiB。`);
  return new VerifiedSink(file, new MemoryWriter(file.name, file.mime, memoryLimit), false);
}
export async function hashFile(file: Blob, chunkBytes: number, signal?: AbortSignal, end = file.size) {
  const hash = sha256.create();
  for (let offset = 0; offset < end; offset += chunkBytes) {
    signal?.throwIfAborted(); const chunk = new Uint8Array(await file.slice(offset, Math.min(end, offset + chunkBytes)).arrayBuffer()); hash.update(chunk);
  }
  signal?.throwIfAborted(); return hash;
}
