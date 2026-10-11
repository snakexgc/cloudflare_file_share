import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from '../src/worker/index';
import type { Capabilities, DownloadRequest, FileInfo, ShareInfo, UploadAuthorization } from '../src/shared/types';
import { digest, id } from '../src/worker/util';
import { encodeFrame, SINGLE_PUT_MAX_BYTES } from '../src/shared/protocol';
import type { Env } from '../src/worker/config';

interface Created { id: string; ownerToken: string; createdAt: number; expiresAt: number; files: FileInfo[] }
interface Session { sessionId: string; sessionToken: string }
const liveSockets: WebSocket[] = [];
afterEach(() => { for (const socket of liveSockets.splice(0)) socket.close(1000, 'test complete'); });
async function request(path: string, secret?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const headers: Record<string, string> = {};
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function create(size = 3): Promise<Created> {
  const response = await request('/api/shares', undefined, { expiresInHours: 6, files: [{ name: '原文件.bin', size, mime: 'application/octet-stream', lastModified: 123 }] });
  expect(response.status).toBe(201); return response.json();
}
async function session(share: Created, role: 'owner' | 'receiver', caps: Partial<Capabilities> = {}): Promise<Session> {
  const response = await request(`/api/shares/${share.id}/sessions`, role === 'owner' ? share.ownerToken : undefined, { role, capabilities: { ws: false, webrtc: false, readable: role === 'owner' ? share.files.map(f => f.id) : [], ...caps } });
  expect(response.status).toBe(201); return response.json();
}
async function download(share: Created, receiver: Session): Promise<DownloadRequest> {
  const response = await request(`/api/shares/${share.id}/download-requests`, receiver.sessionToken, { fileId: share.files[0].id }); expect(response.status).toBe(201); return response.json();
}
async function upload(share: Created, owner: Session): Promise<UploadAuthorization> {
  const response = await request(`/api/shares/${share.id}/files/${share.files[0].id}/uploads`, owner.sessionToken, {}); expect(response.status).toBe(200); return response.json();
}
async function websocket(share: Created, session: Session) {
  const response = await worker.fetch(new Request(`https://share.test/api/shares/${share.id}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `file-share, token.${session.sessionToken}` } }), env);
  expect(response.status).toBe(101); response.webSocket!.accept(); response.webSocket!.binaryType = 'arraybuffer'; liveSockets.push(response.webSocket!); return response.webSocket!;
}
function nextMessage(socket: WebSocket, predicate: (data: string | ArrayBuffer) => boolean) {
  return new Promise<string | ArrayBuffer>((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', handler); reject(new Error('等待 WebSocket 消息超时')); }, 3000);
    const handler = (event: MessageEvent) => { if (predicate(event.data as string | ArrayBuffer)) { clearTimeout(timer); socket.removeEventListener('message', handler); resolve(event.data as string | ArrayBuffer); } };
    socket.addEventListener('message', handler);
  });
}
function kind(type: string) { return (data: string | ArrayBuffer) => typeof data === 'string' && JSON.parse(data).type === type; }
function mockTurn(usage = 0) {
  return vi.mocked(fetch).mockImplementation(async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/graphql')) return Response.json({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: usage } }] }] } } });
    if (url.endsWith('generate-ice-servers')) return Response.json({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'short-lived-user', credential: 'short-lived-password' }] }, { status: 201 });
    if (url.endsWith('/revoke')) return new Response(null, { status: 204 });
    throw new Error(`非预期外部请求 ${url}`);
  });
}
describe('分享与 HTTP 控制层', () => {
  it.each([0, 25, 6.5, '6'])('服务端拒绝有效期 %s', async expiresInHours => {
    const response = await request('/api/shares', undefined, { expiresInHours, files: [{ name: 'a', size: 0, mime: '', lastModified: 0 }] }); expect(response.status).toBe(400);
  });
  it('创建和浏览不会创建数据任务、读取文件或上传', async () => {
    const share = await create();
    for (let i = 0; i < 3; i++) expect((await request(`/api/shares/${share.id}`)).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(0);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    expect(await runInDurableObject(stub, async (_instance, ctx) => { const room = await ctx.storage.get<{ requests: unknown[] }>('room'); return room!.requests.length; })).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('禁用 WS 后仍能创建、心跳、查看状态、请求下载并通知分享者', async () => {
    const share = await create(), owner = await session(share, 'owner', { webrtc: true }), receiver = await session(share, 'receiver', { webrtc: true });
    const task = await download(share, receiver); expect(task.mode).toBe('p2p');
    const state = await (await request(`/api/shares/${share.id}/heartbeat`, owner.sessionToken, { capabilities: { ws: false, webrtc: true, readable: [share.files[0].id] } })).json() as { share: ShareInfo };
    expect(state.share.ownerStatus).toBe('online'); expect(state.share.expiresAt).toBe(share.expiresAt);
    const signals = await request(`/api/shares/${share.id}/signals`, owner.sessionToken, { eventId: id(), requestId: task.id, epoch: task.epoch, kind: 'rtc-offer', payload: { description: { type: 'offer', sdp: 'test-sdp' } } }); expect(signals.status).toBe(200);
    const events = await (await request(`/api/shares/${share.id}/events?cursor=0`, receiver.sessionToken)).json() as { events: { type: string }[] };
    expect(events.events.some(x => x.type === 'rtc-offer')).toBe(true); expect(events.events.some(x => x.type === 'attempt')).toBe(true);
  });
  it('公开链接和接收会话不能上传、撤销或取消别人的下载', async () => {
    const share = await create(), receiver = await session(share, 'receiver'), stranger = await session(share, 'receiver'), task = await download(share, receiver);
    expect((await request(`/api/shares/${share.id}`, receiver.sessionToken, undefined, 'DELETE')).status).toBe(403);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/uploads`, receiver.sessionToken, {})).status).toBe(403);
    expect((await request(`/api/shares/${share.id}/download-requests/${task.id}`, stranger.sessionToken, undefined, 'DELETE')).status).toBe(403);
    expect((await request(`/api/shares/${share.id}/sessions`, undefined, { role: 'owner' })).status).toBe(403);
  });
  it('分享者离线时只等待，不连续尝试中继', async () => {
    const share = await create(), receiver = await session(share, 'receiver', { webrtc: true, ws: true }), task = await download(share, receiver);
    expect(task.status).toBe('requested'); expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(0);
  });
  it('过期检查不依赖 Alarm；过期后管理取消仍可执行', async () => {
    const share = await create(), receiver = await session(share, 'receiver'), task = await download(share, receiver);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(share.expiresAt);
    expect((await request(`/api/shares/${share.id}`)).status).toBe(410);
    expect((await request(`/api/shares/${share.id}/sessions`, undefined, { role: 'receiver' })).status).toBe(410);
    expect((await request(`/api/shares/${share.id}/download-requests/${task.id}`, receiver.sessionToken, undefined, 'DELETE')).status).toBe(200);
  });
  it('错误 Content-Type 和控制层文件载荷被拒绝', async () => {
    const response = await worker.fetch(new Request('https://share.test/api/shares', { method: 'POST', body: 'file bytes', headers: { 'Content-Type': 'application/octet-stream' } }), env); expect(response.status).toBe(400);
    const huge = await request('/api/shares', undefined, { garbage: 'x'.repeat(70000) }); expect(huge.status).toBe(413);
  });
  it('跨站写入在访问 DO 前被拒绝', async () => {
    const response = await worker.fetch(new Request('https://share.test/api/shares', { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' }), env); expect(response.status).toBe(403);
  });
  it('事件队列有字节上限，过期 cursor 要求重新同步；消息重试去重', async () => {
    const share = await create(), owner = await session(share, 'owner', { webrtc: true }), receiver = await session(share, 'receiver', { webrtc: true }), task = await download(share, receiver);
    const eventId = id(), body = { eventId, requestId: task.id, epoch: task.epoch, kind: 'rtc-offer', payload: { description: { type: 'offer', sdp: 'x'.repeat(20000) } } };
    for (let i = 0; i < 5; i++) expect((await request(`/api/shares/${share.id}/signals`, owner.sessionToken, { ...body, eventId: i === 0 ? eventId : id() })).status).toBe(200);
    await request(`/api/shares/${share.id}/signals`, owner.sessionToken, body);
    const response = await request(`/api/shares/${share.id}/events?cursor=0`, receiver.sessionToken); expect(response.status).toBe(409);
    const data = await response.json() as { error: string; details: { cursor: number } }; expect(data.error).toBe('resync_required'); expect(data.details.cursor).toBe(6);
    const snapshot = await (await request(`/api/shares/${share.id}/files-status`, receiver.sessionToken)).json() as { cursor: number }; expect(snapshot.cursor).toBe(6);
  });
  it('D1 实际行使用量计入预算；耗尽后仍允许已授权的撤销清理', async () => {
    const share = await create(), stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
    const snapshot = await (await stub.fetch(new Request('https://budget/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).json() as { d1RowsWritten: number };
    expect(snapshot.d1RowsWritten).toBeGreaterThanOrEqual(2);
    const previous = await runInDurableObject(stub, instance => { const bindings = (instance as unknown as { env: Env }).env; const previous = bindings.LIMITS; bindings.LIMITS = JSON.stringify({ d1RowsWrittenPerDay: 1 }); return previous; });
    try {
      expect((await request(`/api/shares/${share.id}`)).status).toBe(429);
      expect((await request(`/api/shares/${share.id}`, share.ownerToken, undefined, 'DELETE')).status).toBe(200);
    } finally { await runInDurableObject(stub, instance => { (instance as unknown as { env: Env }).env.LIMITS = previous; }); }
  });
});
describe('R2 控制与补偿清理', () => {
  it('未获得上传授权时的失败仍通知所有等待者；源文件不可读进入等待恢复', async () => {
    const share = await create(), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/failure`, owner.sessionToken, { reason: 'R2 未配置' })).status).toBe(200);
    const events = await (await request(`/api/shares/${share.id}/events?cursor=0`, receiver.sessionToken)).json() as { events: { type: string }[] }; expect(events.events.some(event => event.type === 'r2-error')).toBe(true);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/failure`, owner.sessionToken, { reason: '文件不可读', sourceUnavailable: true })).status).toBe(200);
    const details = await (await request(`/api/shares/${share.id}/files-status`, receiver.sessionToken)).json() as { requests: DownloadRequest[] }; expect(details.requests[0].status).toBe('requested');
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/failure`, receiver.sessionToken, { reason: '恶意请求' })).status).toBe(403);
  });
  it('整文件单次 PUT、签名绑定长度、共享上传及离线下载授权', async () => {
    const share = await create(), owner = await session(share, 'owner'), first = await session(share, 'receiver'), second = await session(share, 'receiver');
    const one = await download(share, first), two = await download(share, second), authorization = await upload(share, owner), reused = await upload(share, owner);
    expect(authorization.mode).toBe('put'); expect(authorization.attemptId).toBe(reused.attemptId);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(1);
    const url = new URL(authorization.url!); expect(url.host).toBe('test-account.r2.cloudflarestorage.com'); expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    const row = await env.DB.prepare('SELECT r2_key FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first<{ r2_key: string }>();
    await env.BUCKET.put(row!.r2_key, new Uint8Array([1, 2, 3]));
    const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/complete`, owner.sessionToken, { attemptId: authorization.attemptId, sha256 })).status).toBe(200);
    expect((await request(`/api/shares/${share.id}/download-requests/${one.id}`, first.sessionToken, undefined, 'DELETE')).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 70000);
    const state = await (await request(`/api/shares/${share.id}`)).json() as ShareInfo; expect(state.ownerStatus).toBe('offline'); expect(state.files[0].uploadStatus).toBe('ready'); expect(state.expiresAt).toBe(share.expiresAt);
    const downloadUrl = await request(`/api/shares/${share.id}/files/${share.files[0].id}/download`, second.sessionToken, { requestId: two.id, epoch: two.epoch }); expect(downloadUrl.status).toBe(200);
    expect(new URL((await downloadUrl.json() as { url: string }).url).host).toBe('test-account.r2.cloudflarestorage.com');
  });
  it('一个下载者取消不会终止共享上传；最后一个取消保留清理记录', async () => {
    const share = await create(), owner = await session(share, 'owner'), first = await session(share, 'receiver'), second = await session(share, 'receiver');
    const one = await download(share, first), two = await download(share, second), authorization = await upload(share, owner);
    await request(`/api/shares/${share.id}/download-requests/${one.id}`, first.sessionToken, undefined, 'DELETE');
    expect(await env.DB.prepare('SELECT status FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first('status')).toBe('uploading');
    await request(`/api/shares/${share.id}/download-requests/${two.id}`, second.sessionToken, undefined, 'DELETE');
    expect(await env.DB.prepare('SELECT status FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first('status')).toBe('canceled');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM cleanup_tasks').first('n')).toBe(1);
    const row = await env.DB.prepare('SELECT r2_key FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first<{ r2_key: string }>();
    await env.BUCKET.put(row!.r2_key, new Uint8Array([1, 2, 3])); // 模拟取消后迟到的直传
    await env.ROOMS.get(env.ROOMS.idFromName(share.id)).fetch(new Request('https://room/internal/sweep', { method: 'POST' }));
    expect(await env.BUCKET.head(row!.r2_key)).toBeNull();
  });
  it('对象大小不符、未完成对象和过期确认都不能发布 ready', async () => {
    const share = await create(), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'), task = await download(share, receiver), authorization = await upload(share, owner);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/download`, receiver.sessionToken, { requestId: task.id, epoch: task.epoch })).status).toBe(409);
    const row = await env.DB.prepare('SELECT r2_key FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first<{ r2_key: string }>(); await env.BUCKET.put(row!.r2_key, new Uint8Array([1]));
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/complete`, owner.sessionToken, { attemptId: authorization.attemptId, sha256: digest('test') })).status).toBe(409);
    expect(await env.BUCKET.head(row!.r2_key)).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(share.expiresAt + 1);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/complete`, owner.sessionToken, { attemptId: authorization.attemptId, sha256: digest('test') })).status).toBe(410);
  });
  it.each([SINGLE_PUT_MAX_BYTES - 1, SINGLE_PUT_MAX_BYTES])('R2 的 %s 字节文件完整 PUT，不创建 Multipart 或签发多个请求', async size => {
    const share = await create(size), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver);
    const authorization = await upload(share, owner);
    expect(authorization.mode).toBe('put'); expect(authorization.url).toBeTruthy();
    expect(await env.DB.prepare('SELECT upload_id FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first('upload_id')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
  it('超过单次 PUT 上限才创建 Multipart；浏览器只得到具体 part 授权', async () => {
    const share = await create(5363466241), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver);
    vi.mocked(fetch).mockImplementation(async () => new Response('<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>'));
    const authorization = await upload(share, owner); expect(authorization.mode).toBe('multipart'); expect(authorization.url).toBeUndefined(); expect(authorization.partSize).toBe(2681733121);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/parts/1/sign`, owner.sessionToken, { attemptId: authorization.attemptId })).status).toBe(409);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/identity`, owner.sessionToken, { attemptId: authorization.attemptId, sha256: digest('large-test-file') })).status).toBe(200);
    const response = await request(`/api/shares/${share.id}/files/${share.files[0].id}/parts/1/sign`, owner.sessionToken, { attemptId: authorization.attemptId }); expect(response.status).toBe(200);
    const signed = new URL((await response.json() as { url: string }).url); expect(signed.searchParams.get('partNumber')).toBe('1'); expect(signed.searchParams.get('uploadId')).toBeTruthy();
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/parts/2/sign`, owner.sessionToken, { attemptId: authorization.attemptId })).status).toBe(200);
    const impossible = await request(`/api/shares/${share.id}/files/${share.files[0].id}/parts/3/sign`, owner.sessionToken, { attemptId: authorization.attemptId }); expect(impossible.status).toBe(400);
  });
  it('8 GB 只需两片，配置变更和 DO 重启均不改变已创建上传的分片边界', async () => {
    const share = await create(8000000000), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver);
    vi.mocked(fetch).mockImplementation(async () => new Response('<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>'));
    const authorization = await upload(share, owner); expect(authorization.partSize).toBe(4000000000);
    await request(`/api/shares/${share.id}/files/${share.files[0].id}/identity`, owner.sessionToken, { attemptId: authorization.attemptId, sha256: digest('large-test-file') });
    vi.mocked(fetch).mockImplementation(async () => new Response('<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>first-part</ETag><Size>4000000000</Size></Part></ListPartsResult>'));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    await runInDurableObject(stub, async instance => {
      const instanceEnv = (instance as unknown as { env: Env }).env;
      instanceEnv.LIMITS = JSON.stringify({ ...JSON.parse(instanceEnv.LIMITS ?? '{}'), multipartPartBytes: 64 * 1024 ** 2 });
    });
    const resumed = await upload(share, owner); expect(resumed.partSize).toBe(4000000000); expect(resumed.uploadedParts[0].size).toBe(4000000000);
    expect((await request(`/api/shares/${share.id}/files/${share.files[0].id}/parts/3/sign`, owner.sessionToken, { attemptId: authorization.attemptId })).status).toBe(400);
    await abortAllDurableObjects();
    const restored = await upload(share, owner); expect(restored.partSize).toBe(4000000000); expect(restored.attemptId).toBe(authorization.attemptId);
  });
  it('首次升级已有的 v1 Multipart 状态时保留 64 MiB 边界，不套用新分片大小', async () => {
    const share = await create(SINGLE_PUT_MAX_BYTES + 1), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver);
    vi.mocked(fetch).mockImplementation(async () => new Response('<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>'));
    const authorization = await upload(share, owner), stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    await runInDurableObject(stub, async (_instance, ctx) => {
      const stored = await ctx.storage.get<{ uploads: { partSize?: number }[] }>('room'); delete stored!.uploads[0].partSize; await ctx.storage.put('room', stored);
    });
    await abortAllDurableObjects();
    const restored = await upload(share, owner); expect(restored.partSize).toBe(64 * 1024 ** 2); expect(restored.attemptId).toBe(authorization.attemptId);
    await abortAllDurableObjects();
    expect((await upload(share, owner)).partSize).toBe(64 * 1024 ** 2);
  });
  it('到期清理幂等，按原截止时间删除，并保留 tombstone', async () => {
    const share = await create(), owner = await session(share, 'owner'), receiver = await session(share, 'receiver'); await download(share, receiver); const authorization = await upload(share, owner);
    const row = await env.DB.prepare('SELECT r2_key FROM upload_attempts WHERE id = ?').bind(authorization.attemptId).first<{ r2_key: string }>(); await env.BUCKET.put(row!.r2_key, new Uint8Array([1, 2, 3]));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(share.expiresAt + 3600001);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(share.id)); await runDurableObjectAlarm(stub); await stub.fetch(new Request('https://room/internal/sweep', { method: 'POST' }));
    expect(await env.BUCKET.head(row!.r2_key)).toBeNull();
    expect(await env.DB.prepare('SELECT cleanup_status FROM shares WHERE id = ?').bind(share.id).first('cleanup_status')).toBe('cleaned');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first('n')).toBe(0);
    const remainingMetadata = await runInDurableObject(stub, async (_instance, ctx) => JSON.stringify(Array.from((await ctx.storage.list()).values())));
    expect(remainingMetadata).not.toContain('原文件.bin');
    expect((await request(`/api/shares/${share.id}`)).status).toBe(410);
    vi.setSystemTime(share.expiresAt + 3600001 + 86400001); await stub.fetch(new Request('https://room/internal/sweep', { method: 'POST' }));
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM shares').first('n')).toBe(0);
  });
});
describe('WS 中继、流控与隔离', () => {
  it('只在活跃中继期间保留 ACK 定时器，取消最后一个任务后允许正常休眠', async () => {
    const share = await create(), owner = await session(share, 'owner', { ws: true }), receiver = await session(share, 'receiver', { ws: true });
    await websocket(share, owner); await websocket(share, receiver);
    const task = await download(share, receiver), stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
    expect(await runInDurableObject(stub, instance => Boolean((instance as unknown as { relayTimer?: unknown }).relayTimer))).toBe(true);
    await request(`/api/shares/${share.id}/download-requests/${task.id}`, receiver.sessionToken, undefined, 'DELETE');
    expect(await runInDurableObject(stub, instance => Boolean((instance as unknown as { relayTimer?: unknown }).relayTimer))).toBe(false);
  });
  it('实际 WS 只向获准接收者转发原始二进制；ACK 后完成', async () => {
    const share = await create(), owner = await session(share, 'owner', { webrtc: true, ws: true }), receiver = await session(share, 'receiver', { webrtc: true, ws: true }), visitor = await session(share, 'receiver', { ws: true });
    const sender = await websocket(share, owner), target = await websocket(share, receiver), observer = await websocket(share, visitor);
    let observedBytes = 0; observer.addEventListener('message', event => { if (typeof event.data !== 'string') observedBytes++; });
    let task = await download(share, receiver);
    const advanced = await request(`/api/shares/${share.id}/download-requests/${task.id}/advance`, receiver.sessionToken, { epoch: task.epoch, offset: 0, reason: '测试直连失败' }); expect(advanced.status).toBe(200); task = await advanced.json(); expect(task.mode).toBe('ws');
    const credited = nextMessage(sender, kind('relay-credit')); target.send(JSON.stringify({ type: 'relay-ack', transferId: task.transferId, epoch: task.epoch, offset: 0 })); await credited;
    const frame = encodeFrame({ transferId: task.transferId, fileId: task.fileId, epoch: task.epoch, offset: 0, payload: new Uint8Array([1, 2, 3]) });
    const received = nextMessage(target, data => typeof data !== 'string'); sender.send(frame); expect(new Uint8Array(await received as ArrayBuffer)).toEqual(new Uint8Array(frame));
    const finalCredit = nextMessage(sender, kind('relay-credit')); target.send(JSON.stringify({ type: 'relay-ack', transferId: task.transferId, epoch: task.epoch, offset: 3 })); await finalCredit;
    const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
    expect((await request(`/api/shares/${share.id}/signals`, owner.sessionToken, { eventId: id(), requestId: task.id, epoch: task.epoch, kind: 'file-end', payload: { sha256, size: 3 } })).status).toBe(200);
    expect((await request(`/api/shares/${share.id}/signals`, receiver.sessionToken, { eventId: id(), requestId: task.id, epoch: task.epoch, kind: 'completed', payload: { sha256, size: 3 } })).status).toBe(200);
    expect(observedBytes).toBe(0); expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM upload_attempts').first('n')).toBe(0);
  });
  it('信令 WS 不授予文件权限，未授权二进制消息关闭连接', async () => {
    const share = await create(), viewer = await session(share, 'receiver', { ws: true }), socket = await websocket(share, viewer);
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
    socket.send(encodeFrame({ transferId: id(), fileId: share.files[0].id, epoch: 1, offset: 0, payload: new Uint8Array([1]) })); expect(await closed).toBe(1008);
  });
  it('缺少任一端的真实 WS 连接时跳过 WS；R2 失败不会循环回 P2P', async () => {
    const share = await create(), owner = await session(share, 'owner', { webrtc: true, ws: true }), receiver = await session(share, 'receiver', { webrtc: true, ws: true }); await websocket(share, owner);
    let task = await download(share, receiver);
    const response = await request(`/api/shares/${share.id}/download-requests/${task.id}/advance`, receiver.sessionToken, { epoch: task.epoch, offset: 0, reason: 'P2P 失败' }); task = await response.json(); expect(task.mode).toBe('r2');
    const failed = await request(`/api/shares/${share.id}/download-requests/${task.id}/advance`, receiver.sessionToken, { epoch: task.epoch, offset: 0, reason: 'R2 失败' }); expect((await failed.json() as DownloadRequest).status).toBe('failed');
  });
  it('DO 重启保留文件身份与任务，旧中继窗口不能继续发送', async () => {
    const share = await create(), owner = await session(share, 'owner', { webrtc: true, ws: true }), receiver = await session(share, 'receiver', { webrtc: true, ws: true });
    const sender = await websocket(share, owner), target = await websocket(share, receiver); let task = await download(share, receiver);
    task = await (await request(`/api/shares/${share.id}/download-requests/${task.id}/advance`, receiver.sessionToken, { epoch: task.epoch, offset: 0, reason: 'P2P 失败' })).json();
    const credit = nextMessage(sender, kind('relay-credit')); target.send(JSON.stringify({ type: 'relay-ack', transferId: task.transferId, epoch: task.epoch, offset: 0 })); await credit;
    await abortAllDurableObjects();
    const restoredSender = await websocket(share, owner); await websocket(share, receiver);
    const failure = nextMessage(restoredSender, data => typeof data === 'string' && JSON.parse(data).type === 'error');
    restoredSender.send(encodeFrame({ transferId: task.transferId, fileId: task.fileId, epoch: task.epoch, offset: 0, payload: new Uint8Array([1]) }));
    expect(JSON.parse(await failure as string).error).toBe('relay_not_ready');
  });
  it('慢接收者不能扩大窗口，其超限不会终止另一接收者', async () => {
    const share = await create(1048577), owner = await session(share, 'owner', { ws: true }), one = await session(share, 'receiver', { ws: true }), two = await session(share, 'receiver', { ws: true });
    await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(share.id)), async instance => {
      const instanceEnv = (instance as unknown as { env: Env }).env;
      instanceEnv.LIMITS = JSON.stringify({ ...JSON.parse(instanceEnv.LIMITS ?? '{}'), chunkBytes: 262144, windowBytes: 1048576 });
    });
    const sender = await websocket(share, owner), slow = await websocket(share, one), fast = await websocket(share, two), a = await download(share, one), b = await download(share, two);
    let credit = nextMessage(sender, kind('relay-credit')); slow.send(JSON.stringify({ type: 'relay-ack', transferId: a.transferId, epoch: a.epoch, offset: 0 })); await credit;
    credit = nextMessage(sender, kind('relay-credit')); fast.send(JSON.stringify({ type: 'relay-ack', transferId: b.transferId, epoch: b.epoch, offset: 0 })); await credit;
    let receivedBytes = 0;
    const fullWindow = new Promise<void>(resolve => slow.addEventListener('message', event => { if (typeof event.data !== 'string') { receivedBytes += (event.data as ArrayBuffer).byteLength - 52; if (receivedBytes === 1048576) resolve(); } }));
    for (let offset = 0; offset < 1048576; offset += 262144) sender.send(encodeFrame({ transferId: a.transferId, fileId: a.fileId, epoch: a.epoch, offset, payload: new Uint8Array(262144) }));
    await fullWindow;
    const limited = nextMessage(sender, data => typeof data === 'string' && JSON.parse(data).error === 'relay_window');
    sender.send(encodeFrame({ transferId: a.transferId, fileId: a.fileId, epoch: a.epoch, offset: 1048576, payload: new Uint8Array([1]) })); await limited;
    const continued = nextMessage(fast, data => typeof data !== 'string');
    sender.send(encodeFrame({ transferId: b.transferId, fileId: b.fileId, epoch: b.epoch, offset: 0, payload: new Uint8Array([7]) })); expect((await continued as ArrayBuffer).byteLength).toBe(53); expect(receivedBytes).toBe(1048576);
  });
  it('取消后已排入发送窗口的迟到数据被丢弃，不关闭其他接收者的中继', async () => {
    const share = await create(), owner = await session(share, 'owner', { ws: true }), first = await session(share, 'receiver', { ws: true }), second = await session(share, 'receiver', { ws: true });
    const sender = await websocket(share, owner); await websocket(share, first); const other = await websocket(share, second);
    const a = await download(share, first), b = await download(share, second);
    await request(`/api/shares/${share.id}/download-requests/${a.id}`, first.sessionToken, undefined, 'DELETE');
    sender.send(encodeFrame({ transferId: a.transferId, fileId: a.fileId, epoch: a.epoch, offset: 0, payload: new Uint8Array([1]) }));
    const credit = nextMessage(sender, kind('relay-credit')); other.send(JSON.stringify({ type: 'relay-ack', transferId: b.transferId, epoch: b.epoch, offset: 0 })); await credit;
    const received = nextMessage(other, data => typeof data !== 'string'); sender.send(encodeFrame({ transferId: b.transferId, fileId: b.fileId, epoch: b.epoch, offset: 0, payload: new Uint8Array([1, 2, 3]) }));
    expect((await received as ArrayBuffer).byteLength).toBe(55);
  });
});
describe('TURN 保守预算与短期凭证', () => {
  it('并发预留原子化，结算重复执行不释放已消费的预算', async () => {
    mockTurn(100000000000); const stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
    const reserve = (key: string) => stub.fetch(new Request('https://budget/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, kind: 'turn', bytes: 500000000000, expiresAt: Date.now() + 60000 }) }));
    const results = await Promise.all([reserve('one'), reserve('two')]); expect(results.map(response => response.status).sort()).toEqual([200, 429]);
    const settledId = results[0].ok ? 'one' : 'two';
    for (let i = 0; i < 2; i++) await stub.fetch(new Request('https://budget/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: settledId }) }));
    const snapshot = await (await stub.fetch(new Request('https://budget/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).json() as { turnCommitted: number; turnReserved: number };
    expect(snapshot.turnCommitted).toBe(500000000000); expect(snapshot.turnReserved).toBe(0);
  });
  it('只有 P2P 失败后才签发凭证，TTL 不超过分享剩余时间', async () => {
    const mocked = mockTurn(); const share = await create(); await session(share, 'owner', { webrtc: true }); const receiver = await session(share, 'receiver', { webrtc: true });
    const task = await download(share, receiver); expect(mocked).not.toHaveBeenCalled();
    const response = await request(`/api/shares/${share.id}/download-requests/${task.id}/advance`, receiver.sessionToken, { epoch: task.epoch, offset: 0, reason: 'P2P 连接失败' }); const turn = await response.json() as DownloadRequest;
    expect(turn.mode).toBe('turn'); expect(turn.iceServers?.[0].username).toBe('short-lived-user'); expect(turn.turnExpiresAt!).toBeLessThanOrEqual(share.expiresAt);
    expect((await request(`/api/shares/${share.id}/download-requests/${turn.id}`, receiver.sessionToken, undefined, 'DELETE')).status).toBe(200);
    expect(mocked.mock.calls.some(call => String(call[0]).includes('/revoke'))).toBe(true);
  });
  it('统计失败或过旧时拒绝新凭证', async () => {
    const stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
    const response = await stub.fetch(new Request('https://budget/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'no-stats', kind: 'turn', bytes: 1000, expiresAt: Date.now() + 60000 }) })); expect(response.status).toBe(503);
  });
});
