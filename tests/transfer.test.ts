import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ReceiveTask, SendTask } from '../src/client/transfer';
import { VerifiedSink, type FileWriter } from '../src/client/sink';
import { defaults } from '../src/worker/config';
import { encodeFrame } from '../src/shared/protocol';
import type { ControlSession } from '../src/client/control';
import type { DirectTransport } from '../src/client/peer';
import { addressFamily } from '../src/client/peer';
import type { DownloadRequest, FileInfo } from '../src/shared/types';
import { id } from '../src/worker/util';

it('IPv4、IPv6 与 mDNS 隐藏地址分别标记，不将隐藏地址误判为 IPv4', () => {
  expect(addressFamily('192.0.2.1')).toBe('IPv4'); expect(addressFamily('2001:db8::1')).toBe('IPv6'); expect(addressFamily('abcd.local')).toBe('地址隐藏');
});
describe('接收端热切换与原文件完整性', () => {
  it.each(['ws', 'r2'] as const)('%s 文件写入失败后终止任务，不把可能部分写入的文件降级续传', async mode => {
    const file: FileInfo = { id: id(), name: 'disk-full.bin', size: 4, mime: '', lastModified: 1, uploadStatus: 'none' };
    const task: DownloadRequest = { id: id(), fileId: file.id, receiverId: id(), ownerId: id(), epoch: 1, transferId: id(), mode, status: 'transferring', offset: 0, createdAt: Date.now() };
    const abort = vi.fn(async () => {}), close = vi.fn(async () => {});
    const writer: FileWriter = { write: async () => { throw new Error('disk full'); }, truncate: async () => {}, seek: async () => {}, close, abort };
    const canceled = vi.fn();
    vi.mocked(globalThis.fetch).mockImplementation(async (url, options) => {
      if (String(url).endsWith('/download')) return Response.json({ url: 'https://r2.test/object', sha256: 'a'.repeat(64), size: 4 });
      if (String(url) === 'https://r2.test/object') return new Response(new Uint8Array(4));
      expect(options?.method).toBe('DELETE'); expect(String(url)).not.toContain('/advance'); canceled(); return Response.json({ ok: true });
    });
    const control = { base: '/api/shares/test', sessionToken: 'token', relayAck: vi.fn(), signal: vi.fn() } as unknown as ControlSession;
    const receiver = new ReceiveTask(task, new VerifiedSink(file, writer), control, defaults, [], () => {}); await receiver.start();
    if (mode === 'ws') receiver.frame(encodeFrame({ fileId: file.id, transferId: task.transferId, epoch: 1, offset: 0, payload: new Uint8Array(4) }));
    await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce()); expect(receiver.done).toBe(true); expect(abort).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  });
  it('SHA-256 校验失败后取消服务端任务，不能停留在正在完成状态', async () => {
    const file: FileInfo = { id: id(), name: 'bad-hash.bin', size: 4, mime: '', lastModified: 1, uploadStatus: 'none' };
    const task: DownloadRequest = { id: id(), fileId: file.id, receiverId: id(), ownerId: id(), epoch: 1, transferId: id(), mode: 'ws', status: 'transferring', offset: 0, createdAt: Date.now() };
    const writer: FileWriter = { write: async () => {}, truncate: async () => {}, seek: async () => {}, close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ ok: true }));
    const control = { base: '/api/shares/test', sessionToken: 'token', relayAck: vi.fn(), signal: vi.fn() } as unknown as ControlSession;
    const receiver = new ReceiveTask(task, new VerifiedSink(file, writer), control, defaults, [], () => {}); await receiver.start();
    receiver.frame(encodeFrame({ fileId: file.id, transferId: task.transferId, epoch: 1, offset: 0, payload: new Uint8Array(4) }));
    await receiver.event({ seq: 1, eventId: id(), type: 'file-end', request: task, data: { sha256: 'a'.repeat(64) }, createdAt: Date.now() });
    expect(receiver.done).toBe(true); expect(writer.abort).toHaveBeenCalledOnce(); expect(writer.close).not.toHaveBeenCalled(); expect(control.signal).not.toHaveBeenCalled(); expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
  it.each(['ws', 'r2'] as const)('%s 已写入前缀后，后续分片复用热 P2P 通道，迟到旧帧无效且不关闭可复用通道', async mode => {
    const data = Uint8Array.from({ length: 256 * 1024 + 17 }, (_, i) => (i * 37 + 23) % 256), prefix = 65536;
    const file: FileInfo = { id: id(), name: 'switch.bin', size: data.length, mime: '', lastModified: 1, uploadStatus: 'none' };
    const initial: DownloadRequest = { id: id(), fileId: file.id, receiverId: id(), ownerId: id(), epoch: 1, transferId: id(), mode, status: 'transferring', offset: 0, createdAt: Date.now() };
    const next: DownloadRequest = { ...initial, epoch: 2, transferId: id(), mode: 'p2p', peerId: id(), offset: prefix, status: 'connecting' };
    const saved: Uint8Array[] = [], writer: FileWriter = { write: async chunk => { saved.push(Uint8Array.from(chunk)); }, truncate: vi.fn(async () => {}), seek: async () => {}, close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const sink = new VerifiedSink(file, writer);
    let sendMessage: ((data: string | ArrayBuffer) => void) | undefined, receiveMessage: ((data: string | ArrayBuffer) => void) | undefined;
    const close = vi.fn(), pc = { sctp: { maxMessageSize: 65536 }, close } as unknown as RTCPeerConnection;
    const receiverChannel = { readyState: 'open', bufferedAmount: 0, send: (buffer: string | ArrayBuffer) => sendMessage?.(buffer), close } as unknown as RTCDataChannel;
    const senderChannel = { readyState: 'open', bufferedAmount: 0, send: (buffer: string | ArrayBuffer) => receiveMessage?.(buffer), close } as unknown as RTCDataChannel;
    const recvDirect: DirectTransport = { pc, channel: receiverChannel, subscribe: (_id, message) => { receiveMessage = message; return () => { receiveMessage = undefined; }; } };
    const sendDirect: DirectTransport = { pc, channel: senderChannel, subscribe: (_id, message) => { sendMessage = message; return () => { sendMessage = undefined; }; } };
    let completed!: () => void; const complete = new Promise<void>(resolve => { completed = resolve; });
    const receiverControl = { base: '/api/shares/test', sessionToken: 'token', relayAck: vi.fn(), signal: vi.fn(async (_task, kind) => { if (kind === 'completed') completed(); }) } as unknown as ControlSession;
    const senderControl = { signal: vi.fn(async () => {}) } as unknown as ControlSession;
    const fetch = vi.mocked(globalThis.fetch).mockImplementation(async (url, options) => {
      if (String(url).endsWith('/download')) return Response.json({ url: 'https://r2.test/object', sha256: bytesToHex(sha256(data)), size: data.length });
      if (String(url) === 'https://r2.test/object') return new Response(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, prefix)); options!.signal!.addEventListener('abort', () => controller.error(new Error('stream aborted')), { once: true }); } }));
      expect(JSON.parse(options!.body as string).offset).toBe(prefix); return Response.json(next);
    });
    const receiver = new ReceiveTask(initial, sink, receiverControl, defaults, [], () => {}, () => recvDirect); await receiver.start();
    if (mode === 'ws') receiver.frame(encodeFrame({ fileId: file.id, transferId: initial.transferId, epoch: 1, offset: 0, payload: data.subarray(0, prefix) }));
    await vi.waitFor(() => expect(sink.offset).toBe(prefix));
    await receiver.upgrade(next.peerId!); expect(sink.offset).toBe(prefix); expect(writer.truncate).toHaveBeenCalledTimes(mode === 'r2' ? 1 : 0);
    receiver.frame(encodeFrame({ fileId: file.id, transferId: initial.transferId, epoch: 1, offset: prefix, payload: data.subarray(prefix, prefix + 10) }));
    const sender = new SendTask(next, new File([data], 'switch.bin'), senderControl, defaults, [], () => {}, sendDirect); await sender.start(); await complete;
    const actual = new Uint8Array(data.length); let offset = 0; for (const part of saved) { actual.set(part, offset); offset += part.length; }
    expect(actual).toEqual(data); expect(bytesToHex(sha256(actual))).toBe(bytesToHex(sha256(data))); expect(writer.close).toHaveBeenCalledOnce(); expect(writer.abort).not.toHaveBeenCalled();
    sender.stop(); expect(close).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(mode === 'r2' ? 3 : 1);
  });
});
