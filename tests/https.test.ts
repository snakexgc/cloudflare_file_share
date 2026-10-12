import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { HttpsRelay, httpsBufferUsage } from '../src/worker/https-relay';
import { defaults, limits, type Env } from '../src/worker/config';
import { digest, id } from '../src/worker/util';
import type { DownloadRequest, FileInfo } from '../src/shared/types';

interface Share { id: string; ownerToken: string; expiresAt: number; files: FileInfo[] }
interface Session { sessionId: string; sessionToken: string }
const shares: Share[] = [], relays: HttpsRelay[] = [];
async function call(path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', cookie?: string) {
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
afterEach(async () => {
  vi.useRealTimers(); for (const relay of relays.splice(0)) relay.close();
  for (const share of shares.splice(0)) await call(`/api/shares/${share.id}`, share.ownerToken, undefined, 'DELETE');
});
async function fixture(size = 9, settings: Record<string, unknown> = { httpsChunkBytes: 4 }) {
  const response = await call('/api/shares', undefined, { expiresInHours: 1, files: [{ name: 'HTTPS 原文件.bin', size, mime: '', lastModified: 1 }] });
  expect(response.status).toBe(201); const share = await response.json<Share>(); shares.push(share);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
  await runInDurableObject(stub, instance => { const bindings = (instance as unknown as { env: Env }).env; bindings.LIMITS = JSON.stringify({ ...JSON.parse(bindings.LIMITS ?? '{}'), ...settings }); });
  async function session(role: 'owner' | 'receiver') {
    const response = await call(`/api/shares/${share.id}/sessions`, role === 'owner' ? share.ownerToken : undefined, { role, capabilities: { https: true, ws: false, webrtc: false, readable: role === 'owner' ? [share.files[0].id] : [] } });
    expect(response.status).toBe(201); return response.json<Session>();
  }
  const owner = await session('owner'), receiver = await session('receiver');
  const taskResponse = await call(`/api/shares/${share.id}/download-requests`, receiver.sessionToken, { fileId: share.files[0].id });
  expect(taskResponse.status).toBe(201); const task = await taskResponse.json<DownloadRequest>();
  const base = `/api/shares/${share.id}/download-requests/${task.id}`;
  const identity = (offset: number, current = task) => ({ fileId: current.fileId, transferId: current.transferId, epoch: current.epoch, offset });
  const chunk = (offset: number, body?: BodyInit, token = body === undefined ? receiver.sessionToken : owner.sessionToken, current = task) => worker.fetch(new Request(`https://share.test${base}/https/chunk?${new URLSearchParams(Object.entries(identity(offset, current)).map(([key, value]) => [key, String(value)]))}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/octet-stream' }) }, body }), env);
  const ack = (offset: number, current = task) => call(`${base}/https/ack`, receiver.sessionToken, identity(offset, current));
  return { share, stub, owner, receiver, task, base, chunk, ack, identity };
}

describe('HTTPS 中继服务与授权', () => {
  it('匿名用户完全通过 HTTP 传多块与尾片，POST 等待实际写入 ACK，最后核对整文件哈希', async () => {
    const f = await fixture(), bytes = new TextEncoder().encode('abcdefghi'); expect(f.task.mode).toBe('https');
    const received: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      let posted = false;
      const upload = f.chunk(offset, bytes.slice(offset, offset + 4)).then(response => { posted = true; return response; });
      const get = await f.chunk(offset); expect(get.status).toBe(200); received.push(...new Uint8Array(await get.arrayBuffer()));
      expect(posted).toBe(false); expect((await f.ack(Math.min(offset + 4, bytes.length))).status).toBe(200);
      expect(await (await upload).json()).toEqual({ offset: Math.min(offset + 4, bytes.length) });
    }
    expect(received).toEqual([...bytes]);
    const signal = (token: string, kind: string) => call(`/api/shares/${f.share.id}/signals`, token, { eventId: id(), requestId: f.task.id, epoch: f.task.epoch, kind, payload: { sha256: digest('abcdefghi'), size: bytes.length } });
    expect((await signal(f.owner.sessionToken, 'file-end')).status).toBe(200); expect((await signal(f.receiver.sessionToken, 'completed')).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('禁止其他会话、错误角色、旧 epoch、未来偏移、短块与长块', async () => {
    const f = await fixture();
    expect((await f.chunk(0, new Uint8Array(4), f.receiver.sessionToken)).status).toBe(403);
    expect((await f.chunk(0, undefined, f.owner.sessionToken)).status).toBe(403);
    expect((await f.chunk(0, undefined, id())).status).toBe(403);
    expect((await f.chunk(0, new Uint8Array(4), undefined, { ...f.task, epoch: 2 })).status).toBe(409);
    expect((await f.chunk(4, new Uint8Array(4))).status).toBe(409);
    expect((await f.chunk(0, new Uint8Array(3))).status).toBe(400);
    expect((await f.chunk(0, new Uint8Array(5))).status).toBe(413);
    expect((await f.ack(4)).status).toBe(409);
  });
  it('未确认块可重读，POST 与 ACK 幂等且不接收下一块', async () => {
    const f = await fixture(), bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = f.chunk(0, bytes); const first = await f.chunk(0); expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes);
    expect((await f.chunk(4, bytes)).status).toBe(409);
    expect(new Uint8Array(await (await f.chunk(0)).arrayBuffer())).toEqual(bytes);
    const duplicate = f.chunk(0, new Uint8Array([9, 9, 9, 9]));
    expect((await f.ack(4)).status).toBe(200); expect((await f.ack(4)).status).toBe(200);
    expect((await upload).status).toBe(200); expect((await duplicate).status).toBe(200);
    expect(await (await f.chunk(0, bytes)).json()).toEqual({ offset: 4 });
  });
  it('慢上传不占房间串行锁，心跳和取消可执行并停止等待中的 POST / GET', async () => {
    const f = await fixture(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const upload = f.chunk(0, stream), get = f.chunk(0);
    const heartbeat = await call(`/api/shares/${f.share.id}/heartbeat`, f.owner.sessionToken, { capabilities: { https: true, ws: false, webrtc: false, readable: [f.task.fileId] } });
    expect(heartbeat.status).toBe(200);
    expect((await call(f.base, f.receiver.sessionToken, undefined, 'DELETE')).status).toBe(200);
    expect((await upload).status).toBe(409); expect((await get).status).toBe(409);
    controller.close(); expect((await f.chunk(0, new Uint8Array(4))).status).toBe(409);
  });
  it('实例重启后拒绝旧缓冲，按实际写入进度重建并继续尾片', async () => {
    const f = await fixture(); const upload = f.chunk(0, new Uint8Array(4)); await (await f.chunk(0)).arrayBuffer(); await f.ack(4); await upload;
    await abortAllDurableObjects();
    expect((await f.chunk(4)).status).toBe(409);
    const resumed = await (await call(`${f.base}/resume`, f.receiver.sessionToken, { epoch: f.task.epoch, transferId: f.task.transferId, offset: 4 })).json<DownloadRequest>();
    expect(resumed.mode).toBe('https'); expect(resumed.epoch).toBe(2); expect(resumed.transferId).not.toBe(f.task.transferId);
    expect((await f.chunk(4, new Uint8Array(4))).status).toBe(409);
    const next = f.chunk(4, new Uint8Array([4, 5, 6, 7, 8]), undefined, resumed);
    expect(new Uint8Array(await (await f.chunk(4, undefined, undefined, resumed)).arrayBuffer())).toEqual(new Uint8Array([4, 5, 6, 7, 8]));
    expect((await f.ack(9, resumed)).status).toBe(200); expect((await next).status).toBe(200);
  });
  it('ACK 超时与分享过期释放等待者，取消后旧请求不可复活', async () => {
    const f = await fixture(); const upload = f.chunk(0, new Uint8Array(4)); await (await f.chunk(0)).arrayBuffer();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + defaults.ackTimeoutMs + 1);
    // Keep session leases valid to exercise the block deadline rather than disconnect cleanup.
    await call(`/api/shares/${f.share.id}/heartbeat`, f.owner.sessionToken, { capabilities: { https: true, readable: [f.task.fileId] } });
    await call(`/api/shares/${f.share.id}/heartbeat`, f.receiver.sessionToken, { capabilities: { https: true, readable: [] } });
    await runDurableObjectAlarm(f.stub); expect((await upload).status).toBe(409); expect((await f.ack(4)).status).toBe(409);
    vi.setSystemTime(f.share.expiresAt); expect((await f.chunk(0)).status).toBe(410);
  });
  it('共享房间窗口和 isolate 缓冲限制并发，释放后新任务可准入', async () => {
    const f = await fixture(defaults.httpsChunkBytes + 1, { roomBufferBytes: 64 * 1024 ** 2 }); expect(f.task.mode).toBe('https');
    const tasks = [f.task];
    for (let i = 0; i < 4; i++) {
      const receiver = await (await call(`/api/shares/${f.share.id}/sessions`, undefined, { role: 'receiver', capabilities: { https: true } })).json<Session>();
      const task = await (await call(`/api/shares/${f.share.id}/download-requests`, receiver.sessionToken, { fileId: f.task.fileId })).json<DownloadRequest>();
      if (i < 3) { expect(task.mode).toBe('https'); tasks.push(task); } else expect(task.status).toBe('failed');
    }
    expect(tasks).toHaveLength(4);
    await call(f.base, f.receiver.sessionToken, undefined, 'DELETE');
    const receiver = await (await call(`/api/shares/${f.share.id}/sessions`, undefined, { role: 'receiver', capabilities: { https: true } })).json<Session>();
    expect((await (await call(`/api/shares/${f.share.id}/download-requests`, receiver.sessionToken, { fileId: f.task.fileId })).json<DownloadRequest>()).mode).toBe('https');
  });
  it('强制 HTTPS 优先于其他方式，失败不会回退；匿名用户不能强制选择', async () => {
    const f = await fixture(); expect((await call(`${f.base}/switch`, f.receiver.sessionToken, { epoch: 1, offset: 0, mode: 'https' })).status).toBe(403);
    const login = await call('/api/admin/login', undefined, { password: env.ADMIN_TOKEN }), cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const switched = await (await call(`${f.base}/switch`, f.receiver.sessionToken, { epoch: 1, offset: 0, mode: 'https' }, 'POST', cookie)).json<DownloadRequest>();
    expect(switched.mode).toBe('https'); expect(switched.forcedMode).toBe('https');
    const failed = await (await call(`${f.base}/advance`, f.receiver.sessionToken, { epoch: switched.epoch, offset: 0, reason: 'network failed' })).json<DownloadRequest>();
    expect(failed.status).toBe('failed'); expect(failed.mode).toBe('https');
  });
  it('零字节文件不上传数据块，只校验完整文件与空内容哈希', async () => {
    const f = await fixture(0); expect(f.task.mode).toBe('https');
    expect((await call(`/api/shares/${f.share.id}/signals`, f.owner.sessionToken, { eventId: id(), requestId: f.task.id, epoch: 1, kind: 'file-end', payload: { size: 0, sha256: digest('') } })).status).toBe(200);
    expect((await call(`/api/shares/${f.share.id}/signals`, f.receiver.sessionToken, { eventId: id(), requestId: f.task.id, epoch: 1, kind: 'completed', payload: { size: 0, sha256: digest('') } })).status).toBe(200);
  });
  it('统计实际 GET 转发（包含重读），结算不重复；HTTP 请求不使用 WS 20:1 折算', async () => {
    const f = await fixture(); const upload = f.chunk(0, new Uint8Array(4)); await (await f.chunk(0)).arrayBuffer(); await (await f.chunk(0)).arrayBuffer();
    const login = await call('/api/admin/login', undefined, { password: env.ADMIN_TOKEN }), cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const before = await (await call('/api/admin/overview', undefined, undefined, 'GET', cookie)).json<{ ledger: Record<string, number> }>();
    expect(before.ledger.httpsBytes).toBe(8); expect(before.ledger.httpsLiveBytes).toBe(8); expect(before.ledger.httpsActiveTransfers).toBe(1); expect(before.ledger.doWsMessages).toBe(0);
    await f.ack(4); await upload; await call(f.base, f.receiver.sessionToken, undefined, 'DELETE');
    const after = await (await call('/api/admin/overview', undefined, undefined, 'GET', cookie)).json<typeof before>();
    expect(after.ledger.httpsBytes).toBe(8); expect(after.ledger.httpsLiveBytes).toBe(0); expect(after.ledger.httpsActiveTransfers).toBe(0);
  });
  it('自动选择优先 WS，WS 失败后继续 HTTPS，不需要 R2 授权', async () => {
    const f = await fixture(4), sockets: WebSocket[] = [];
    try {
      for (const session of [f.owner, f.receiver]) {
        const response = await worker.fetch(new Request(`https://share.test/api/shares/${f.share.id}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `file-share, token.${session.sessionToken}` } }), env);
        expect(response.status).toBe(101); response.webSocket!.accept(); sockets.push(response.webSocket!);
      }
      const login = await call('/api/admin/login', undefined, { password: env.ADMIN_TOKEN }), cookie = login.headers.get('Set-Cookie')!.split(';')[0];
      const ws = await (await call(`${f.base}/switch`, f.receiver.sessionToken, { epoch: 1, offset: 0, mode: 'auto' }, 'POST', cookie)).json<DownloadRequest>(); expect(ws.mode).toBe('ws');
      const https = await (await call(`${f.base}/advance`, f.receiver.sessionToken, { epoch: ws.epoch, offset: 0, reason: 'WS disconnected' })).json<DownloadRequest>();
      expect(https.mode).toBe('https'); expect(https.status).toBe('connecting'); expect(https.epoch).toBe(ws.epoch + 1);
    } finally { for (const socket of sockets) socket.close(); }
  });
  it('全局 HTTPS 并发额度耗尽时拒绝新任务，已有中继保留', async () => {
    const f = await fixture(), stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
    await runInDurableObject(stub, instance => { const bindings = (instance as unknown as { env: Env }).env; bindings.LIMITS = JSON.stringify({ ...JSON.parse(bindings.LIMITS ?? '{}'), httpsMaxConcurrent: 1 }); });
    const receiver = await (await call(`/api/shares/${f.share.id}/sessions`, undefined, { role: 'receiver', capabilities: { https: true } })).json<Session>();
    const task = await (await call(`/api/shares/${f.share.id}/download-requests`, receiver.sessionToken, { fileId: f.task.fileId })).json<DownloadRequest>(); expect(task.status).toBe('failed');
    const state = await (await call(`/api/shares/${f.share.id}/files-status`, f.receiver.sessionToken)).json<{ requests: DownloadRequest[] }>(); expect(state.requests[0].mode).toBe('https'); expect(state.requests[0].status).toBe('connecting');
  });
});

describe('HTTPS 缓冲组件与配置边界', () => {
  it('长轮询 25 秒没有块返回 204，停止后释放 isolate 预留', async () => {
    const baseline = httpsBufferUsage(), relay = new HttpsRelay(8, 0, 4, async () => {}, async () => {}); relays.push(relay);
    vi.useFakeTimers(); const response = relay.download(new Request('https://relay/chunk'), 0);
    await vi.advanceTimersByTimeAsync(25000); expect((await response).status).toBe(204); relay.close(); expect(httpsBufferUsage()).toBe(baseline);
  });
  it('超过 50 MiB、房间缓冲或错误类型的块配置均拒绝', () => {
    expect(defaults.httpsChunkBytes).toBe(16 * 1024 ** 2); expect(defaults.httpsMaxFileBytes).toBe(10 * 1024 ** 3);
    expect(limits({ LIMITS: JSON.stringify({ httpsChunkBytes: 50 * 1024 ** 2 }) }).httpsChunkBytes).toBe(50 * 1024 ** 2);
    expect(() => limits({ LIMITS: JSON.stringify({ httpsChunkBytes: 50 * 1024 ** 2 + 1 }) })).toThrow();
    expect(() => limits({ LIMITS: JSON.stringify({ httpsChunkBytes: '16777216' }) })).toThrow();
    expect(() => limits({ LIMITS: JSON.stringify({ httpsChunkBytes: 40 * 1024 ** 2, roomBufferBytes: 36 * 1024 ** 2 }) })).toThrow();
  });
});
