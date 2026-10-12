import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { httpsBufferUsage } from '../src/worker/https-relay';
import type { DownloadRequest, FileInfo, ShareInfo, UploadAuthorization } from '../src/shared/types';

interface Created { id: string; ownerToken: string; createdAt: number; expiresAt: number; files: FileInfo[] }
interface Session { sessionId: string; sessionToken: string }
const sockets: WebSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(1000, 'test complete'); });
async function call(path: string, token?: string, body?: unknown, cookie?: string) {
  return worker.fetch(new Request(`https://share.test${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function fixture(hours?: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const response = await call('/api/shares', undefined, { ...(hours === undefined ? {} : { expiresInHours: hours }), files: [{ name: 'idle-test.bin', size: 3, mime: '', lastModified: 1 }] });
  expect(response.status).toBe(201); const share = await response.json<Created>(), base = `/api/shares/${share.id}`, stub = env.ROOMS.get(env.ROOMS.idFromName(share.id));
  const at = (minutes: number) => vi.setSystemTime(share.createdAt + minutes * 60000);
  async function session(role: 'owner' | 'receiver', cookie?: string, https = true) {
    const response = await call(base + '/sessions', role === 'owner' ? share.ownerToken : undefined, { role, capabilities: { ws: false, webrtc: false, https, readable: role === 'owner' ? [share.files[0].id] : [] } }, cookie);
    expect(response.status).toBe(201); return response.json<Session>();
  }
  return { share, base, stub, at, session };
}
it('省略有效期默认 2 小时，首次 Alarm 在 30 分钟不活跃截止时间', async () => {
  const f = await fixture(); expect(f.share.expiresAt - f.share.createdAt).toBe(2 * 3600000);
  expect(await runInDurableObject(f.stub, (_, ctx) => ctx.storage.getAlarm())).toBe(f.share.createdAt + 30 * 60000);
});
it('公开读取和接收者心跳不延长分享，30 分钟边界销毁且不能重新连接', async () => {
  const f = await fixture(), receiver = await f.session('receiver');
  f.at(29); expect((await call(f.base)).status).toBe(200); expect((await call(f.base + '/heartbeat', receiver.sessionToken, {})).status).toBe(200);
  f.at(30); const response = await call(f.base); expect(response.status).toBe(410);
  expect(await response.json()).toMatchObject({ details: { share: { status: 'expired', expiredReason: 'owner_inactive', cleanupStatus: 'cleaned', files: [] } } });
  expect((await call(f.base + '/sessions', f.share.ownerToken, { role: 'owner' })).status).toBe(410);
  expect(await env.DB.prepare('SELECT status FROM shares WHERE id = ?').bind(f.share.id).first('status')).toBe('expired');
  expect(await env.DB.prepare('SELECT COUNT(*) FROM files WHERE share_id = ?').bind(f.share.id).first('COUNT(*)')).toBe(0);
});
it('分享者有效心跳延后不活跃截止时间，但不会延长原有效期', async () => {
  const f = await fixture(), owner = await f.session('owner'); f.at(29);
  expect((await call(f.base + '/heartbeat', owner.sessionToken, {})).status).toBe(200);
  expect(await runInDurableObject(f.stub, (_, ctx) => ctx.storage.getAlarm())).toBe(f.share.createdAt + 59 * 60000);
  f.at(58); expect((await call(f.base)).status).toBe(200); f.at(59); await runDurableObjectAlarm(f.stub);
  expect((await call(f.base)).status).toBe(410);
  expect(await env.DB.prepare('SELECT expires_at FROM shares WHERE id = ?').bind(f.share.id).first('expires_at')).toBe(f.share.expiresAt);
});
it('原到期时间先到时仍停止，持续活跃不越过 1 小时有效期', async () => {
  const f = await fixture(1), owner = await f.session('owner');
  for (const minute of [20, 40, 59]) { f.at(minute); expect((await call(f.base + '/heartbeat', owner.sessionToken, {})).status).toBe(200); }
  expect(await runInDurableObject(f.stub, (_, ctx) => ctx.storage.getAlarm())).toBe(f.share.expiresAt);
  f.at(60); expect((await call(f.base)).status).toBe(410);
});
it('多源端以最后有效活动计时，剪除会话并重启后仍保留该时间', async () => {
  const f = await fixture(); await f.session('owner'); f.at(10); await f.session('owner'); f.at(20); await f.session('receiver');
  expect(await runInDurableObject(f.stub, async (_, ctx) => (await ctx.storage.list({ prefix: 'session:' })).size)).toBe(1);
  await abortAllDurableObjects(); f.at(39); expect((await call(f.base)).status).toBe(200); f.at(40); expect((await call(f.base)).status).toBe(410);
});
it('有效源端状态查询和管理令牌读取计为活动，伪造令牌不计', async () => {
  const f = await fixture(), owner = await f.session('owner'); f.at(20); expect((await call(f.base + '/files-status', owner.sessionToken)).status).toBe(200);
  await abortAllDurableObjects(); f.at(49); expect((await call(f.base, f.share.ownerToken)).status).toBe(200);
  f.at(78); expect((await call(f.base + '/sessions', 'f'.repeat(64), { role: 'owner' })).status).toBe(403);
  f.at(79); expect((await call(f.base)).status).toBe(410);
});
it('已有房间状态升级采用持久化源端时间，不在重启时重置 30 分钟', async () => {
  const f = await fixture(), owner = await f.session('owner'); f.at(10); await call(f.base + '/heartbeat', owner.sessionToken, {});
  await runInDurableObject(f.stub, async (_, ctx) => { const state = await ctx.storage.get<{ lastOwnerActiveAt?: number }>('room'); delete state!.lastOwnerActiveAt; await ctx.storage.put('room', state); await ctx.storage.setAlarm(f.share.expiresAt); });
  await abortAllDurableObjects(); f.at(20); expect((await call(f.base)).status).toBe(200);
  const restarted = env.ROOMS.get(env.ROOMS.idFromName(f.share.id)); expect(await runInDurableObject(restarted, (_, ctx) => ctx.storage.getAlarm())).toBe(f.share.createdAt + 40 * 60000);
  f.at(40); await runDurableObjectAlarm(restarted); expect((await call(f.base)).status).toBe(410);
});
it('WS 休眠自动心跳时间有效，Alarm 不会把仍活跃的源端销毁', async () => {
  const f = await fixture(), owner = await f.session('owner');
  const response = await worker.fetch(new Request(`https://share.test${f.base}/ws`, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `file-share, token.${owner.sessionToken}` } }), env);
  expect(response.status).toBe(101); response.webSocket!.accept(); sockets.push(response.webSocket!);
  // Advance application time while supplying the runtime's separate auto-response clock.
  await runInDurableObject(f.stub, (_, ctx) => vi.spyOn(ctx, 'getWebSocketAutoResponseTimestamp').mockReturnValue(new Date(f.share.createdAt + 29 * 60000)));
  f.at(31); await runDurableObjectAlarm(f.stub); expect((await call(f.base)).status).toBe(200);
  expect(await runInDurableObject(f.stub, (_, ctx) => ctx.storage.getAlarm())).toBe(f.share.createdAt + 59 * 60000);
});
it('不活跃销毁释放 HTTPS 未确认块和等待上传响应', async () => {
  const f = await fixture(), owner = await f.session('owner'), receiver = await f.session('receiver');
  const task = await (await call(f.base + '/download-requests', receiver.sessionToken, { fileId: f.share.files[0].id })).json<DownloadRequest>(); expect(task.mode).toBe('https');
  const path = `${f.base}/download-requests/${task.id}/https/chunk?${new URLSearchParams({ fileId: task.fileId, transferId: task.transferId, epoch: String(task.epoch), offset: '0' })}`;
  const baseline = httpsBufferUsage() - 3;
  const posted = worker.fetch(new Request(`https://share.test${path}`, { method: 'POST', headers: { Authorization: `Bearer ${owner.sessionToken}`, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) }), env);
  expect((await call(path, receiver.sessionToken)).status).toBe(200);
  f.at(30); expect((await call(f.base)).status).toBe(410); expect((await posted).status).toBe(409); expect(httpsBufferUsage()).toBe(baseline);
});
it('云端 ready 文件也在源端不活跃时删除，迟到 PUT 仍持续复核', async () => {
  const f = await fixture(), login = await call('/api/admin/login', undefined, { password: env.ADMIN_TOKEN }), cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const owner = await f.session('owner', cookie, false), receiver = await f.session('receiver', undefined, false);
  const task = await (await call(f.base + '/download-requests', receiver.sessionToken, { fileId: f.share.files[0].id })).json<DownloadRequest>(); expect(task.mode).toBe('r2');
  const upload = await (await call(`${f.base}/files/${task.fileId}/uploads`, owner.sessionToken, {})).json<UploadAuthorization>();
  const key = await env.DB.prepare('SELECT r2_key FROM upload_attempts WHERE id = ?').bind(upload.attemptId).first<string>('r2_key');
  await env.BUCKET.put(key!, new Uint8Array([1, 2, 3]));
  expect((await call(`${f.base}/files/${task.fileId}/complete`, owner.sessionToken, { attemptId: upload.attemptId, sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' })).status).toBe(200);
  f.at(29); const ready = await (await call(f.base)).json<ShareInfo>(); expect(ready.files[0].uploadStatus).toBe('ready');
  f.at(30); await runDurableObjectAlarm(f.stub); expect((await call(f.base)).status).toBe(410); expect(await env.BUCKET.head(key!)).toBeNull();
  expect((await call(`${f.base}/files/${task.fileId}/download`, receiver.sessionToken, { requestId: task.id, epoch: task.epoch })).status).toBe(410);
  await env.BUCKET.put(key!, new Uint8Array([1, 2, 3])); f.at(31); await runDurableObjectAlarm(f.stub); expect(await env.BUCKET.head(key!)).toBeNull();
  f.at(91); await runDurableObjectAlarm(f.stub); expect(await env.DB.prepare('SELECT cleanup_status FROM shares WHERE id = ?').bind(f.share.id).first('cleanup_status')).toBe('cleaned');
});
