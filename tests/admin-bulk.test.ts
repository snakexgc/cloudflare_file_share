import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/worker/index';
import { id } from '../src/worker/util';
import type { DownloadRequest, FileInfo } from '../src/shared/types';
interface Share { id: string; ownerToken: string; files: FileInfo[] }
async function call(path: string, body?: unknown, cookie?: string, token?: string, method = body === undefined ? 'GET' : 'POST') {
  return worker.fetch(new Request(`https://share.test${path}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function fixture() {
  const login = await call('/api/admin/login', { password: env.ADMIN_TOKEN }), cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const share = await (await call('/api/shares', { expiresInHours: 1, files: [{ name: 'a.bin', size: 3, mime: '', lastModified: 1 }, { name: 'b.bin', size: 3, mime: '', lastModified: 1 }] })).json<Share>();
  return { cookie, share };
}
it('分享管理令牌与匿名用户均不能执行全站批量操作', async () => {
  const f = await fixture(), body = { action: 'revoke-shares', targets: [{ shareId: f.share.id }] };
  expect((await call('/api/admin/bulk', body)).status).toBe(403); expect((await call('/api/admin/bulk', body, undefined, f.share.ownerToken)).status).toBe(403);
});
it('批量指定方式应用每个文件，后续快照显示 HTTPS 和自动选择', async () => {
  const f = await fixture(), targets = f.share.files.map(file => ({ shareId: f.share.id, fileId: file.id }));
  const response = await call('/api/admin/bulk', { action: 'set-mode', mode: 'https', targets }, f.cookie); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ succeeded: 2, failed: 0 });
  const data = await (await call('/api/admin/shares', undefined, f.cookie)).json<{ shares: { files: FileInfo[] }[] }>(); expect(data.shares[0].files.every(file => file.forcedMode === 'https')).toBe(true);
  expect((await call('/api/admin/bulk', { action: 'set-mode', mode: 'auto', targets }, f.cookie)).status).toBe(200);
});
it('混合成功与失败逐项返回结果，单个失败不会阻止另一个文件删除', async () => {
  const f = await fixture(), response = await call('/api/admin/bulk', { action: 'delete-files', targets: [{ shareId: f.share.id, fileId: f.share.files[0].id }, { shareId: f.share.id, fileId: id() }] }, f.cookie);
  const result = await response.json<{ succeeded: number; failed: number; results: { ok: boolean; status: number }[] }>(); expect(result.succeeded).toBe(1); expect(result.failed).toBe(1); expect(result.results.map(item => item.status)).toEqual([200, 404]);
  expect(await env.DB.prepare('SELECT deleted_at FROM files WHERE id = ?').bind(f.share.files[0].id).first('deleted_at')).not.toBeNull();
});
it('批量取消传输任务支持不同接收者，重复取消幂等且释放中继', async () => {
  const f = await fixture(), base = `/api/shares/${f.share.id}`;
  await call(base + '/sessions', { role: 'owner', capabilities: { https: true, readable: f.share.files.map(file => file.id) } }, undefined, f.share.ownerToken);
  const tasks: DownloadRequest[] = [];
  for (const file of f.share.files) {
    const receiver = await (await call(base + '/sessions', { role: 'receiver', capabilities: { https: true } })).json<{ sessionToken: string }>();
    const task = await (await call(base + '/download-requests', { fileId: file.id }, undefined, receiver.sessionToken)).json<DownloadRequest>(); expect(task.mode).toBe('https'); tasks.push(task);
  }
  const targets = tasks.map(task => ({ shareId: f.share.id, requestId: task.id }));
  expect(await (await call('/api/admin/bulk', { action: 'cancel-requests', targets }, f.cookie)).json()).toMatchObject({ succeeded: 2, failed: 0 });
  expect(await (await call('/api/admin/bulk', { action: 'cancel-requests', targets }, f.cookie)).json()).toMatchObject({ succeeded: 2, failed: 0 });
  const data = await (await call('/api/admin/shares', undefined, f.cookie)).json<{ shares: { requests: DownloadRequest[] }[] }>(); expect(data.shares[0].requests.every(task => task.status === 'canceled')).toBe(true);
});
it('批量撤销分享，之后公开访问终止', async () => {
  const f = await fixture(), response = await call('/api/admin/bulk', { action: 'revoke-shares', targets: [{ shareId: f.share.id }] }, f.cookie);
  expect(await response.json()).toMatchObject({ succeeded: 1, failed: 0 }); expect((await call(`/api/shares/${f.share.id}`)).status).toBe(410);
});
it('输入错误和重复对象在执行前拒绝，不产生部分修改', async () => {
  const f = await fixture(), target = { shareId: f.share.id, fileId: f.share.files[0].id };
  for (const body of [{ action: 'unknown', targets: [target] }, { action: 'delete-files', targets: [] }, { action: 'delete-files', targets: [target, target] }, { action: 'delete-files', targets: [{ shareId: 'bad' }] }, { action: 'set-mode', mode: 'bad', targets: [target] }, { action: 'revoke-shares', targets: Array.from({ length: 51 }, () => ({ shareId: id() })) }]) expect((await call('/api/admin/bulk', body, f.cookie)).status).toBe(400);
  expect(await env.DB.prepare('SELECT deleted_at FROM files WHERE id = ?').bind(target.fileId).first('deleted_at')).toBeNull();
});
