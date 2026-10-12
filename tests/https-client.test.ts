import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ControlSession } from '../src/client/control';
import { ReceiveTask, SendTask } from '../src/client/transfer';
import { VerifiedSink, type FileWriter } from '../src/client/sink';
import { HttpsRelay } from '../src/worker/https-relay';
import { httpsFetch } from '../src/client/https';
import { defaults } from '../src/worker/config';
import type { DownloadRequest, FileInfo } from '../src/shared/types';
import { id } from '../src/worker/util';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });
function objects(size: number) {
  const file: FileInfo = { id: id(), name: '纯 HTTPS.bin', size, mime: '', lastModified: 1, uploadStatus: 'none' };
  const task: DownloadRequest = { id: id(), fileId: file.id, ownerId: id(), receiverId: id(), mode: 'https', epoch: 1, transferId: id(), status: 'connecting', offset: 0, createdAt: Date.now(), httpsChunkBytes: 16 };
  const saved: Uint8Array[] = [];
  const writer: FileWriter = { write: vi.fn(async value => { saved.push(Uint8Array.from(value)); }), truncate: vi.fn(async () => {}), seek: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const control = { base: '/api/shares/test', sessionToken: 'token', track: vi.fn(), signal: vi.fn() } as unknown as ControlSession;
  return { file, task, saved, writer, control };
}
it('HTTPS 上传使用真实字节进度，上传完成仍等待服务器写入 ACK', async () => {
  let request!: FakeRequest;
  class FakeRequest {
    upload: { onprogress?: (event: { loaded: number }) => void } = {};
    status = 200; responseText = '{"offset":4}'; timeout = 0;
    onload?: () => void; onerror?: () => void; onabort?: () => void; ontimeout?: () => void;
    open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn(); abort = vi.fn();
    constructor() { request = this; }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest);
  const f = objects(4), progress = vi.fn(), signal = new AbortController().signal; let settled = false;
  const result = httpsFetch(f.control, f.task, 'chunk', 0, signal, 300000, new Blob([new Uint8Array(4)]), 2, progress).then(response => { settled = true; return response; });
  request.upload.onprogress?.({ loaded: 2 }); request.upload.onprogress?.({ loaded: 4 });
  expect(progress.mock.calls.map(call => call[0])).toEqual([0, 2, 4]); expect(settled).toBe(false); expect(request.open).toHaveBeenCalledWith('POST', expect.stringContaining('/https/chunk'));
  request.onload?.(); expect(await (await result).json()).toEqual({ offset: 4 }); expect(settled).toBe(true); expect(fetch).not.toHaveBeenCalled();
});
it.each([0, 49])('没有 WebSocket / WebRTC 时仍输出完整 %s 字节源文件，ACK 响应丢失不会重复写入', async size => {
  vi.stubGlobal('WebSocket', undefined); vi.stubGlobal('RTCPeerConnection', undefined);
  const f = objects(size), data = Uint8Array.from({ length: size }, (_, i) => i * 17 % 256), source = new File([data], f.file.name);
  const relay = new HttpsRelay(size, 0, 16, async () => {}, async () => {}); cleanups.push(() => relay.close());
  let lostAck = false, requests = 0;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    requests++; const url = new URL(String(input), 'https://test'), request = new Request(url, options);
    if (url.pathname.endsWith('/chunk')) return options?.method === 'POST' ? relay.upload(request, Number(url.searchParams.get('offset'))) : relay.download(request, Number(url.searchParams.get('offset')));
    if (url.pathname.endsWith('/ack')) { const body = await request.json<{ offset: number }>(), response = relay.acknowledge(body.offset); if (!lostAck) { lostAck = true; throw new TypeError('ACK response lost'); } return response; }
    throw new Error(`unexpected ${url}`);
  });
  let complete!: () => void; const done = new Promise<void>(resolve => { complete = resolve; });
  const receiverControl = { ...f.control, signal: vi.fn(async (_task, kind) => { expect(kind).toBe('completed'); complete(); }) } as unknown as ControlSession;
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), receiverControl, { ...defaults, httpsChunkBytes: 16 }, [], () => {});
  const senderControl = { ...f.control, signal: vi.fn(async (task, kind, payload) => { expect(kind).toBe('file-end'); await receiver.event({ seq: 1, eventId: id(), type: kind, request: task, data: payload, createdAt: Date.now() }); }) } as unknown as ControlSession;
  const sender = new SendTask(f.task, source, senderControl, { ...defaults, httpsChunkBytes: 16 }, [], () => {});
  cleanups.push(() => sender.stop()); await receiver.start(); await sender.start(); await done;
  expect(f.writer.close).toHaveBeenCalledOnce(); expect(f.writer.abort).not.toHaveBeenCalled();
  expect(f.writer.write).toHaveBeenCalledTimes(Math.ceil(size / 16));
  const actual = new Uint8Array(size); let offset = 0; for (const part of f.saved) { actual.set(part, offset); offset += part.length; }
  expect(actual).toEqual(data); expect(bytesToHex(sha256(actual))).toBe(bytesToHex(sha256(data)));
  if (size === 0) expect(requests).toBe(0); else expect(lostAck).toBe(true);
});
it('GET 中断后重读完整块，写入前不保留未完成内容', async () => {
  const f = objects(4), bytes = new Uint8Array([1, 2, 3, 4]); let gets = 0;
  vi.mocked(fetch).mockImplementation(async (input, options) => {
    if (String(input).includes('/chunk')) {
      gets++;
      return new Response(gets === 1 ? new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 2)); controller.close(); } }) : bytes, { headers: { 'X-File-Offset': '0' } });
    }
    expect(options?.method).toBe('POST'); return Response.json({ offset: 4 });
  });
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), f.control, defaults, [], () => {});
  await receiver.start(); await vi.waitFor(() => expect(f.writer.write).toHaveBeenCalledOnce());
  await receiver.event({ seq: 1, eventId: id(), type: 'file-end', request: f.task, data: { sha256: bytesToHex(sha256(bytes)) }, createdAt: Date.now() });
  expect(gets).toBe(2); expect(f.saved).toEqual([bytes]); expect(f.writer.close).toHaveBeenCalledOnce();
});
it('HTTPS 哈希不匹配终止文件和服务端任务', async () => {
  const f = objects(4);
  vi.mocked(fetch).mockImplementation(async (input, options) => String(input).includes('/chunk') ? new Response(new Uint8Array(4), { headers: { 'X-File-Offset': '0' } }) : Response.json(options?.method === 'DELETE' ? { ok: true } : { offset: 4 }));
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), f.control, defaults, [], () => {}); await receiver.start();
  await vi.waitFor(() => expect(f.writer.write).toHaveBeenCalledOnce());
  await receiver.event({ seq: 1, eventId: id(), type: 'file-end', request: f.task, data: { sha256: 'a'.repeat(64) }, createdAt: Date.now() });
  expect(receiver.done).toBe(true); expect(f.writer.abort).toHaveBeenCalledOnce(); expect(f.writer.close).not.toHaveBeenCalled();
  expect(vi.mocked(fetch).mock.calls.some(([url, options]) => options?.method === 'DELETE' && !String(url).includes('/advance'))).toBe(true);
});
it('内存缓冲丢失时最多重建一次 HTTPS，保留写入偏移；再次失败进入后续路径', async () => {
  const f = objects(4), next = { ...f.task, epoch: 2, transferId: id() }; let resumes = 0, advances = 0;
  vi.mocked(fetch).mockImplementation(async input => {
    if (String(input).includes('/chunk')) return Response.json({ error: 'relay_restarted', message: 'restart' }, { status: 409 });
    if (String(input).endsWith('/resume')) { resumes++; return Response.json(next); }
    if (String(input).endsWith('/advance')) { advances++; return Response.json({ ...next, status: 'failed' }); }
    return Response.json({ ok: true });
  });
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), f.control, defaults, [], () => {}); await receiver.start();
  await vi.waitFor(() => expect(receiver.done).toBe(true)); expect(resumes).toBe(1); expect(advances).toBe(1); expect(f.writer.write).not.toHaveBeenCalled();
});
it('纯 HTTP 控制会话在 WebSocket 不存在时启动，心跳、信令与事件均使用 Fetch', async () => {
  vi.stubGlobal('WebSocket', undefined); vi.useFakeTimers();
  const f = objects(0);
  vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/sessions') ? Response.json({ sessionId: id(), sessionToken: id() }) : String(input).includes('/events?') ? Response.json({ events: [], cursor: 0 }) : Response.json({ share: {} }));
  const control = new ControlSession(id(), 'receiver', { ws: false, webrtc: false, https: true, readable: [] }, defaults);
  control.preferHttp(); await control.start(); await control.signal(f.task, 'completed', {}); expect(control.ws).toBe(false); control.stop(); await vi.advanceTimersByTimeAsync(15000);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).some(url => url.endsWith('/ws'))).toBe(false);
});
it('每个 HTTPS 尝试的同块 GET 最多三次，不叠加嵌套重试', async () => {
  const f = objects(4), next = { ...f.task, epoch: 2, transferId: id() }; let gets = 0;
  vi.mocked(fetch).mockImplementation(async input => {
    if (String(input).includes('/chunk')) { gets++; throw new TypeError('network lost'); }
    if (String(input).endsWith('/resume')) return Response.json(next);
    if (String(input).endsWith('/advance')) return Response.json({ ...next, status: 'failed' });
    return Response.json({ ok: true });
  });
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), f.control, defaults, [], () => {}); await receiver.start();
  await vi.waitFor(() => expect(receiver.done).toBe(true), { timeout: 5000 }); expect(gets).toBe(6); expect(f.writer.write).not.toHaveBeenCalled();
});
it('事件重同步返回相同任务和源哈希时，完整已写入文件仍可完成校验', async () => {
  const f = objects(4), bytes = new Uint8Array([1, 2, 3, 4]);
  vi.mocked(fetch).mockImplementation(async input => String(input).includes('/chunk') ? new Response(bytes, { headers: { 'X-File-Offset': '0' } }) : Response.json({ offset: 4 }));
  const receiver = new ReceiveTask(f.task, new VerifiedSink(f.file, f.writer), f.control, defaults, [], () => {}); await receiver.start();
  await vi.waitFor(() => expect(f.writer.write).toHaveBeenCalledOnce()); await receiver.start({ ...f.task, sourceHash: bytesToHex(sha256(bytes)) });
  expect(receiver.done).toBe(true); expect(f.writer.close).toHaveBeenCalledOnce();
});
it('HTTPS 会话可为另一个 WS 任务显式建连，HTTPS 完成信令继续只走 HTTP', async () => {
  vi.useFakeTimers(); vi.stubGlobal('location', { href: 'https://test/', protocol: 'https:' });
  const sends = vi.fn(), opened = vi.fn();
  class Socket {
    readyState = 1; bufferedAmount = 0; binaryType = ''; onopen?: () => void;
    constructor() { opened(); setTimeout(() => this.onopen?.(), 0); }
    send = sends; close() { this.readyState = 3; }
  }
  vi.stubGlobal('WebSocket', Socket);
  vi.mocked(fetch).mockImplementation(async input => String(input).includes('/events?') ? Response.json({ events: [], cursor: 0 }) : Response.json({ share: {} }));
  const f = objects(0), control = new ControlSession(id(), 'receiver', { ws: false, webrtc: false, https: true, readable: [] }, defaults);
  control.preferHttp(); control.sessionToken = id(); control.track(f.task);
  const connect = control.ensureWs(); await vi.advanceTimersByTimeAsync(1); await connect;
  expect(control.ws).toBe(true); expect(opened).toHaveBeenCalledOnce();
  await control.signal(f.task, 'completed', {}); expect(sends).not.toHaveBeenCalled();
  control.relayAck({ ...f.task, mode: 'ws' }, 0); expect(sends).toHaveBeenCalledOnce();
  control.stop(); await vi.advanceTimersByTimeAsync(15000);
});
