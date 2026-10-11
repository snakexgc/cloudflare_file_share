import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { DownloadRequest, FileInfo, PeerLink, UploadAuthorization } from '../src/shared/types';
import { id } from '../src/worker/util';

interface Share { id: string; ownerToken: string; expiresAt: number; files: FileInfo[] }
interface Session { sessionId: string; sessionToken: string }
async function call(path: string, body?: unknown, token?: string, cookie?: string, method = body === undefined ? 'GET' : 'POST', extra: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function login() { const response = await call('/api/admin/login', { password: env.ADMIN_TOKEN }); expect(response.status).toBe(200); return response.headers.get('Set-Cookie')!.split(';')[0]; }
async function create(): Promise<Share> { return (await call('/api/shares', { expiresInHours: 6, files: [{ name: '<script>.bin', size: 128, mime: '', lastModified: 123 }] })).json(); }
async function session(s: Share, role: 'owner' | 'receiver', cookie?: string, webrtc = false): Promise<Session> {
  return (await call(`/api/shares/${s.id}/sessions`, { role, capabilities: { webrtc, ws: false, readable: role === 'owner' ? [s.files[0].id] : [] } }, role === 'owner' ? s.ownerToken : undefined, cookie)).json();
}
async function download(s: Share, receiver: Session, cookie?: string, mode?: string): Promise<DownloadRequest> { return (await call(`/api/shares/${s.id}/download-requests`, { fileId: s.files[0].id, mode }, receiver.sessionToken, cookie)).json(); }
describe('管理员与匿名 R2 边界', () => {
  it('密码登录为 HttpOnly / Secure / SameSite Cookie，退出后服务端撤销', async () => {
    expect((await call('/api/admin/login', { password: 'wrong' })).status).toBe(403);
    const response = await call('/api/admin/login', { password: env.ADMIN_TOKEN });
    const cookie = response.headers.get('Set-Cookie')!; expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain(env.ADMIN_TOKEN!);
    expect((await call('/api/admin/budget', undefined, undefined, cookie)).status).toBe(200);
    await call('/api/admin/logout', {}, undefined, cookie);
    expect((await call('/api/admin/budget', undefined, undefined, cookie)).status).toBe(403);
  });
  it('错误密码有独立限速，跨站登录被拒绝', async () => {
    for (let i = 0; i < 5; i++) expect((await call('/api/admin/login', { password: 'wrong' })).status).toBe(403);
    expect((await call('/api/admin/login', { password: env.ADMIN_TOKEN })).status).toBe(429);
    expect((await call('/api/admin/login', { password: env.ADMIN_TOKEN }, undefined, undefined, 'POST', { Origin: 'https://evil.test' })).status).toBe(403);
  });
  it('匿名配置关闭 R2，客户端伪造管理员头和指定 R2 均无效', async () => {
    const conf = await (await call('/api/config')).json() as { admin: boolean; limits: { r2Enabled: boolean }; r2Configured: boolean };
    expect(conf.admin).toBe(false); expect(conf.r2Configured).toBe(false); expect(conf.limits.r2Enabled).toBe(false);
    const s = await create(), owner = await session(s, 'owner'), receiver = await session(s, 'receiver');
    const task = await download(s, receiver); expect(task.status).toBe('failed'); expect(task.mode).not.toBe('r2');
    const forced = await call(`/api/shares/${s.id}/download-requests`, { fileId: s.files[0].id, mode: 'r2' }, receiver.sessionToken, undefined, 'POST', { 'X-File-Share-Admin': 'a'.repeat(64) }); expect(forced.status).toBe(403);
    expect((await call(`/api/shares/${s.id}/files/${s.files[0].id}/uploads`, {}, owner.sessionToken)).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM upload_attempts').first('COUNT(*)')).toBe(0);
  });
  it('源端管理员允许本次分享使用 R2，退出后不再签发 URL', async () => {
    const cookie = await login(), s = await create(), owner = await session(s, 'owner', cookie), receiver = await session(s, 'receiver');
    const task = await download(s, receiver); expect(task.mode).toBe('r2');
    expect((await call(`/api/shares/${s.id}/files/${s.files[0].id}/uploads`, {}, owner.sessionToken)).status).toBe(200);
    await call('/api/admin/logout', {}, undefined, cookie);
    expect((await call(`/api/shares/${s.id}/files/${s.files[0].id}/uploads`, {}, owner.sessionToken)).status).toBe(403);
    const other = await create(); await session(other, 'owner'); const otherReceiver = await session(other, 'receiver'); expect((await download(other, otherReceiver)).mode).not.toBe('r2');
  });
  it('强制 R2 优先于两端 P2P 能力，强制方式失败不降级', async () => {
    const cookie = await login(), s = await create(); await session(s, 'owner', undefined, true); const receiver = await session(s, 'receiver', cookie, true);
    const task = await download(s, receiver, cookie, 'r2'); expect(task.mode).toBe('r2'); expect(task.forcedMode).toBe('r2');
    const next = await (await call(`/api/shares/${s.id}/download-requests/${task.id}/advance`, { epoch: task.epoch, offset: 0 }, receiver.sessionToken)).json() as DownloadRequest;
    expect(next.status).toBe('failed'); expect(next.mode).toBe('r2');
  });
  it('管理台指定普通用户文件方式无需增加伪接收会话', async () => {
    const cookie = await login(), s = await create(); await session(s, 'owner', undefined, true); const receiver = await session(s, 'receiver', undefined, true);
    expect((await call(`/api/admin/shares/${s.id}/files/${s.files[0].id}/mode`, { mode: 'r2' }, undefined, cookie)).status).toBe(200);
    expect((await download(s, receiver)).mode).toBe('r2');
    const data = await (await call('/api/admin/shares', undefined, undefined, cookie)).json() as { shares: { sessions: unknown[] }[] }; expect(data.shares[0].sessions).toHaveLength(2);
  });
  it('文件删除取消下载、删除 R2，并清理签名到期前的迟到 PUT', async () => {
    const cookie = await login(), s = await create(), owner = await session(s, 'owner', cookie), receiver = await session(s, 'receiver'); await download(s, receiver);
    const auth = await (await call(`/api/shares/${s.id}/files/${s.files[0].id}/uploads`, {}, owner.sessionToken)).json() as UploadAuthorization;
    const key = new URL(auth.url!).pathname.split('/').slice(2).join('/');
    await env.BUCKET.put(key, new Uint8Array(128));
    expect((await call(`/api/admin/shares/${s.id}/files/${s.files[0].id}`, undefined, undefined, cookie, 'DELETE')).status).toBe(200);
    expect(await env.BUCKET.head(key)).toBeNull();
    await env.BUCKET.put(key, new Uint8Array(128));
    await env.ROOMS.get(env.ROOMS.idFromName(s.id)).fetch(new Request('https://room/internal/sweep', { method: 'POST' }));
    expect(await env.BUCKET.head(key)).toBeNull();
    expect((await call(`/api/shares/${s.id}/download-requests`, { fileId: s.files[0].id }, receiver.sessionToken)).status).toBe(404);
  });
  it('管理统计包含在线页面，匿名不能列举分享、对象或删除文件', async () => {
    const cookie = await login(), s = await create();
    await call('/api/presence', { id: id(), page: `/s/${s.id}` });
    const result = await (await call('/api/admin/overview', undefined, undefined, cookie)).json() as { onlineCount: number; totals: { shares: number } }; expect(result.onlineCount).toBe(1); expect(result.totals.shares).toBe(1);
    expect((await call('/api/admin/shares')).status).toBe(403); expect((await call('/api/admin/objects')).status).toBe(403);
    expect((await call(`/api/admin/shares/${s.id}/files/${s.files[0].id}`, undefined, undefined, undefined, 'DELETE')).status).toBe(403);
  });
  it('强制 P2P 而浏览器不支持时直接失败；管理员会话不能用在其他来源或已轮换的密码下', async () => {
    const cookie = await login(), s = await create(); await session(s, 'owner'); const receiver = await session(s, 'receiver', cookie);
    const task = await download(s, receiver, cookie, 'p2p'); expect(task.status).toBe('failed'); expect(task.mode).toBe('p2p');
    const rotated = await worker.fetch(new Request('https://share.test/api/admin/session', { headers: { Cookie: cookie } }), { ...env, ADMIN_TOKEN: 'rotated-admin-secret' });
    expect((await rotated.json() as { authenticated: boolean }).authenticated).toBe(false);
    expect((await call('/api/admin/overview', undefined, undefined, cookie, 'GET', { Origin: 'https://evil.test' })).status).toBe(403);
  });
});
describe('持续 ICE 直连与恢复授权', () => {
  it('无下载请求时也可打洞；只有同一对端双方 ready 后才可在后续分片升级', async () => {
    const cookie = await login(), s = await create(), owner = await session(s, 'owner', cookie, true), receiver = await session(s, 'receiver', undefined, true), stranger = await session(s, 'receiver', undefined, true);
    const peers = await (await call(`/api/shares/${s.id}/peers`, {}, receiver.sessionToken)).json() as { peers: PeerLink[] }; const peer = peers.peers[0];
    expect(await env.DB.prepare('SELECT COUNT(*) FROM upload_attempts').first('COUNT(*)')).toBe(0);
    const signal = (actor: Session, kind: string, generation = 1) => call(`/api/shares/${s.id}/peer-signals`, { peerId: peer.id, generation, kind, payload: { description: { type: 'offer', sdp: 'candidate:1 1 UDP 1 2001:db8::1 123 typ host' } } }, actor.sessionToken);
    expect((await signal(stranger, 'ready')).status).toBe(403); expect((await signal(owner, 'offer')).status).toBe(200);
    const task = await download(s, receiver);
    // 跳过 TURN（此用例不允许外部网络），降级到管理员授权 R2 后测试热升级。
    const fallback = await (await call(`/api/shares/${s.id}/download-requests/${task.id}/advance`, { epoch: task.epoch, offset: 0 }, receiver.sessionToken)).json() as DownloadRequest; expect(fallback.mode).toBe('r2');
    const upgrade = () => call(`/api/shares/${s.id}/download-requests/${task.id}/upgrade`, { epoch: fallback.epoch, offset: 64, peerId: peer.id }, receiver.sessionToken);
    await signal(owner, 'ready'); expect((await upgrade()).status).toBe(409); await signal(receiver, 'ready');
    const upgraded = await (await upgrade()).json() as DownloadRequest; expect(upgraded.mode).toBe('p2p'); expect(upgraded.offset).toBe(64); expect(upgraded.epoch).toBe(fallback.epoch + 1); expect(upgraded.transferId).not.toBe(task.transferId); expect(upgraded.peerId).toBe(peer.id);
    expect((await signal(owner, 'ice', 0)).status).toBe(409);
    const another = await session(s, 'receiver', undefined, true); expect((await call(`/api/shares/${s.id}/download-requests/${task.id}/upgrade`, { epoch: upgraded.epoch, offset: 64, peerId: peer.id }, another.sessionToken)).status).toBe(403);
  });
  it('管理员强制 R2 时拒绝后台 P2P 升级', async () => {
    const cookie = await login(), s = await create(); await session(s, 'owner', cookie, true); const receiver = await session(s, 'receiver', cookie, true), task = await download(s, receiver, cookie, 'r2');
    expect((await call(`/api/shares/${s.id}/download-requests/${task.id}/upgrade`, { epoch: task.epoch, offset: 0, peerId: id() }, receiver.sessionToken)).status).toBe(409);
  });
  it('传输中管理员改为 R2 时发送切换通知，只有指定方式可通过源端授权切换', async () => {
    const cookie = await login(), s = await create(); await session(s, 'owner', undefined, true); const receiver = await session(s, 'receiver', undefined, true), task = await download(s, receiver);
    expect(task.mode).toBe('p2p');
    await call(`/api/admin/shares/${s.id}/files/${s.files[0].id}/mode`, { mode: 'r2' }, undefined, cookie);
    const events = await (await call(`/api/shares/${s.id}/events?cursor=0`, undefined, receiver.sessionToken)).json() as { events: { type: string }[] }; expect(events.events.some(e => e.type === 'mode-change')).toBe(true);
    expect((await call(`/api/shares/${s.id}/download-requests/${task.id}/switch`, { epoch: task.epoch, offset: 32, mode: 'ws' }, receiver.sessionToken)).status).toBe(403);
    const switched = await (await call(`/api/shares/${s.id}/download-requests/${task.id}/switch`, { epoch: task.epoch, offset: 32, mode: 'r2' }, receiver.sessionToken)).json() as DownloadRequest;
    expect(switched.mode).toBe('r2'); expect(switched.forcedMode).toBe('r2'); expect(switched.epoch).toBe(task.epoch + 1); expect(switched.offset).toBe(0);
    await call('/api/admin/logout', {}, undefined, cookie);
    expect((await call(`/api/shares/${s.id}/files/${s.files[0].id}/uploads`, {}, s.ownerToken)).status).toBe(403);
  });
});
