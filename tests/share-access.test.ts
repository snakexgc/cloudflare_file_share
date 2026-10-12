import { env } from 'cloudflare:workers';
import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import { id } from '../src/worker/util';
import type { FileInfo, DownloadRequest } from '../src/shared/types';

interface Created { id: string; shortCode?: string; ownerToken: string; passwordProtected: boolean; expiresAt: number; files: FileInfo[]; url: string }
async function call(path: string, body?: unknown, token?: string, cookie?: string, method = body === undefined ? 'GET' : 'POST') {
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function create(options: Record<string, unknown> = {}) {
  return call('/api/shares', { expiresInHours: 1, files: [{ name: '私有文件.txt', size: 4, mime: 'text/plain', lastModified: 1 }], ...options });
}
it('自定义短链接和原始 ID 定位同一分享，未设置密码仍公开读取', async () => {
  const result = await create({ shortCode: 'my-files' }); expect(result.status).toBe(201); const share = await result.json<Created>();
  expect(share.url).toBe('https://share.test/s/my-files'); expect(share.shortCode).toBe('my-files');
  expect((await (await call('/api/shares/my-files')).json<Created>()).id).toBe(share.id);
  expect((await call(`/api/shares/${share.id}`)).status).toBe(200);
});
it.each(['ABCD', 'a', 'aa', 'bad/path', 'a'.repeat(33), '提取码', 'a'.repeat(32)])('拒绝非法或与分享 ID 混淆的短链接 %s', async shortCode => {
  expect((await create({ shortCode })).status).toBe(400);
});
it('短链接冲突返回 409，保留已有分享，原子释放失败创建的预算和记录', async () => {
  const first = await (await create({ shortCode: 'same-link' })).json<Created>();
  const duplicate = await create({ shortCode: 'same-link' }); expect(duplicate.status).toBe(409); expect(await duplicate.json()).toMatchObject({ error: 'short_code_taken' });
  expect((await (await call('/api/shares/same-link')).json<Created>()).id).toBe(first.id);
  expect(await env.DB.prepare('SELECT COUNT(*) FROM shares').first('COUNT(*)')).toBe(1);
});
it('密码在服务端保护文件列表和新会话，链接 ID 和短链接均不能绕过', async () => {
  const share = await (await create({ shortCode: 'secret-files', password: '1234' })).json<Created>();
  for (const reference of [share.id, 'secret-files']) {
    const metadata = await call(`/api/shares/${reference}`); expect(metadata.status).toBe(401); expect(await metadata.text()).not.toContain('私有文件');
    expect((await call(`/api/shares/${reference}/sessions`, { role: 'receiver', capabilities: { https: true } })).status).toBe(401);
  }
  expect((await call('/api/shares/secret-files', undefined, share.ownerToken)).status).toBe(200);
  expect((await call('/api/shares/secret-files/unlock', { password: 'wrong' })).status).toBe(403);
  const unlocked = await call('/api/shares/secret-files/unlock', { password: '1234' }); expect(unlocked.status).toBe(200);
  const cookie = unlocked.headers.get('Set-Cookie')!; expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Secure');
  const credential = cookie.split(';')[0]; expect((await call('/api/shares/secret-files', undefined, undefined, credential)).status).toBe(200);
  const response = await call(`/api/shares/${share.id}/sessions`, { role: 'receiver', capabilities: { https: true } }, undefined, credential); expect(response.status).toBe(201);
  const session = await response.json<{ sessionToken: string }>(); expect((await call(`/api/shares/${share.id}/files-status`, undefined, session.sessionToken)).status).toBe(200);
  const stored = await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(share.id)), async (_instance, ctx) => ctx.storage.get('room'));
  expect(stored).toHaveProperty('passwordHash.hash'); expect(stored).not.toHaveProperty('password'); expect((stored as { passwordHash: { hash: string } }).passwordHash.hash).not.toBe('1234');
  expect((await (await call('/api/shares/secret-files', undefined, undefined, credential)).text())).not.toContain('passwordHash');
});
it('访问 Cookie 不能用于其他分享、伪造或到期后解锁，也不会泄露过期文件名', async () => {
  const first = await (await create({ password: '1234' })).json<Created>(), second = await (await create({ password: '5678' })).json<Created>();
  const cookie = (await call(`/api/shares/${first.id}/unlock`, { password: '1234' })).headers.get('Set-Cookie')!.split(';')[0];
  expect((await call(`/api/shares/${second.id}`, undefined, undefined, cookie)).status).toBe(401);
  expect((await call(`/api/shares/${first.id}`, undefined, undefined, `file_share_access_${first.id}=${'a'.repeat(64)}`)).status).toBe(401);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(first.expiresAt + 1);
  const response = await call(`/api/shares/${first.id}`, undefined, undefined, cookie); expect(response.status).toBe(410); expect(await response.text()).not.toContain('私有文件');
});
it('解锁授权和密码哈希在 DO 重启后保留，正确密码不授予源端管理权限', async () => {
  const share = await (await create({ shortCode: 'restart-code', password: 'abcd' })).json<Created>();
  const cookie = (await call('/api/shares/restart-code/unlock', { password: 'abcd' })).headers.get('Set-Cookie')!.split(';')[0];
  await abortAllDurableObjects(); expect((await call('/api/shares/restart-code', undefined, undefined, cookie)).status).toBe(200);
  expect((await call(`/api/shares/${share.id}/sessions`, { role: 'owner' }, undefined, cookie)).status).toBe(403);
  expect((await call(`/api/shares/${share.id}`, undefined, undefined, cookie, 'DELETE')).status).toBe(403);
});
it('提取密码尝试限制隔离分享，五次后限流，15 分钟后恢复', async () => {
  const first = await (await create({ password: 'abcd' })).json<Created>(), second = await (await create({ password: 'abcd' })).json<Created>();
  for (let i = 0; i < 5; i++) expect((await call(`/api/shares/${first.id}/unlock`, { password: 'wrong' })).status).toBe(403);
  expect((await call(`/api/shares/${first.id}/unlock`, { password: 'abcd' })).status).toBe(429);
  expect((await call(`/api/shares/${second.id}/unlock`, { password: 'abcd' })).status).toBe(200);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 900001);
  expect((await call(`/api/shares/${first.id}/unlock`, { password: 'abcd' })).status).toBe(200);
});
it('受保护分享可以通过授权会话进行纯 HTTPS 下载，密码本身不授予 R2', async () => {
  const share = await (await create({ password: 'abcd' })).json<Created>();
  const cookie = (await call(`/api/shares/${share.id}/unlock`, { password: 'abcd' })).headers.get('Set-Cookie')!.split(';')[0];
  const owner = await (await call(`/api/shares/${share.id}/sessions`, { role: 'owner', capabilities: { https: true, readable: [share.files[0].id] } }, share.ownerToken)).json<{ sessionToken: string }>();
  const receiver = await (await call(`/api/shares/${share.id}/sessions`, { role: 'receiver', capabilities: { https: true } }, undefined, cookie)).json<{ sessionToken: string }>();
  const task = await (await call(`/api/shares/${share.id}/download-requests`, { fileId: share.files[0].id }, receiver.sessionToken)).json<DownloadRequest>(); expect(task.mode).toBe('https');
  expect((await call(`/api/shares/${share.id}/files/${share.files[0].id}/uploads`, {}, owner.sessionToken)).status).toBe(403);
  await call(`/api/shares/${share.id}`, undefined, share.ownerToken, undefined, 'DELETE');
});
it.each(['', '123', 'a'.repeat(65), 'abcd\n', 1234])('拒绝不符合规则的密码 %s', async password => { expect((await create({ password })).status).toBe(400); });
it('管理员可检查受保护分享，但源端管理令牌不授予全站权限', async () => {
  const share = await (await create({ password: 'abcd' })).json<Created>();
  const login = await call('/api/admin/login', { password: env.ADMIN_TOKEN }); const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  expect((await call(`/api/shares/${share.id}`, undefined, undefined, cookie)).status).toBe(200);
  expect((await call('/api/admin/bulk', { action: 'revoke-shares', targets: [{ shareId: share.id }] }, share.ownerToken)).status).toBe(403);
  expect((await call(`/api/shares/${share.id}/unlock`, { password: 'abcd' }, id())).status).toBe(200);
});
it('撤销完成后清除密码哈希与访问凭据，短链接仍明确表示已结束', async () => {
  const share = await (await create({ shortCode: 'cleaned-password', password: 'abcd' })).json<Created>();
  await call('/api/shares/cleaned-password/unlock', { password: 'abcd' }); await call(`/api/shares/${share.id}`, undefined, share.ownerToken, undefined, 'DELETE');
  const stored = await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(share.id)), async (_instance, ctx) => ctx.storage.get('room'));
  expect(stored).not.toHaveProperty('passwordHash'); expect(stored).toHaveProperty('accessGrants', []); expect((await call('/api/shares/cleaned-password')).status).toBe(410);
});
