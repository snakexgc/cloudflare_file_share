import type { Env } from './config';
import { limits } from './config';
import { assert, budget, constantEqual, digest, json, readJson, token } from './util';
import { ID_PATTERN } from '../shared/protocol';

const cookieName = 'file_share_admin';
async function managedRoom(env: Env, roomId: string, request: Request) {
  await budget(env, '/do-used', { count: 1 });
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
}
async function wsUsage(env: Env, snapshot: Record<string, unknown>) {
  const ids = snapshot.wsRoomIds as string[];
  const live: { id: string; bytes: number }[] = [];
  if (ids.length) await budget(env, '/do-used', { count: ids.length });
  for (let i = 0; i < ids.length; i += 5) {
    const responses = await Promise.all(ids.slice(i, i + 5).map(async roomId => {
      const response = await env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request('https://room/internal/admin/ws-usage'));
      assert(response.ok, 503, 'room_unavailable', '无法读取在传 WS 用量'); return response.json<{ transfers: { id: string; bytes: number }[] }>();
    }));
    for (const response of responses) live.push(...response.transfers);
  }
  // 结算可能在读取房间时发生：以最新预留 ID 过滤，避免已结算和在传字节重复计数。
  const latest = ids.length ? await budget(env, '/snapshot', {}) : snapshot;
  const pending = new Set((latest.wsTransfers as { id: string }[]).map(item => item.id));
  const inFlight = live.filter(item => pending.has(item.id)).reduce((sum, item) => sum + item.bytes, 0);
  return { ...latest, wsSettledBytes: Number(latest.wsBytes), wsLiveBytes: inFlight, wsBytes: Number(latest.wsBytes) + inFlight };
}
export async function validAdmin(env: Env, hash?: string): Promise<boolean> {
  if (!env.ADMIN_TOKEN || !hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return Boolean(await env.DB.prepare('SELECT 1 FROM admin_sessions WHERE token_hash = ? AND key_hash = ? AND expires_at > ?').bind(hash, digest(env.ADMIN_TOKEN), Date.now()).first());
}
export async function adminHash(request: Request, env: Env) {
  const value = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const hash = value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : undefined;
  return await validAdmin(env, hash) ? hash : undefined;
}
function cookie(request: Request, value: string, seconds: number) {
  return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function adminApi(request: Request, env: Env, source: string, hash?: string) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/admin/session' && request.method === 'GET') return json({ authenticated: Boolean(hash), configured: Boolean(env.ADMIN_TOKEN) });
  if (path === '/api/admin/login' && request.method === 'POST') {
    await budget(env, '/admin-login', { source });
    assert(env.ADMIN_TOKEN, 503, 'admin_not_configured', '请先配置 ADMIN_TOKEN 机密变量');
    const data = await readJson(request, 4096);
    assert(typeof data.password === 'string' && data.password.length <= 1024 && constantEqual(digest(data.password), digest(env.ADMIN_TOKEN)), 403, 'invalid_password', '密码错误');
    const secret = token(), expiresAt = Date.now() + 8 * 3600000;
    await env.DB.prepare('INSERT INTO admin_sessions (token_hash, key_hash, expires_at) VALUES (?, ?, ?)').bind(digest(secret), digest(env.ADMIN_TOKEN), expiresAt).run();
    const response = json({ authenticated: true, expiresAt }); response.headers.set('Set-Cookie', cookie(request, secret, 8 * 3600)); return response;
  }
  if (path === '/api/admin/logout' && request.method === 'POST') {
    if (hash) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(hash).run();
    const response = json({ authenticated: false }); response.headers.set('Set-Cookie', cookie(request, '', 0)); return response;
  }
  // 保留原来的命令行预算查询；Bearer 密钥不能开通网页 R2 权限。
  const bearerBudget = path === '/api/admin/budget' && env.ADMIN_TOKEN && constantEqual(digest(request.headers.get('Authorization') ?? ''), digest(`Bearer ${env.ADMIN_TOKEN}`));
  assert(hash || bearerBudget, 403, 'admin_forbidden', '请先在 /admin 登录');
  if (path === '/api/admin/budget' && request.method === 'GET') return json(await budget(env, '/snapshot', {}));
  if (path === '/api/admin/overview' && request.method === 'GET') {
    const [ledger, totals, online, rooms] = await Promise.all([
      budget(env, '/snapshot', {}),
      env.DB.prepare("SELECT COUNT(*) AS shares, SUM(CASE WHEN status = 'active' AND expires_at > ? THEN 1 ELSE 0 END) AS active FROM shares").bind(Date.now()).first(),
      env.DB.prepare('SELECT id, page, last_seen AS lastSeen FROM presence WHERE last_seen > ? ORDER BY last_seen DESC LIMIT 100').bind(Date.now() - limits(env).leaseMs).all(),
      env.DB.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS bytes, SUM(CASE WHEN upload_status = \'ready\' THEN 1 ELSE 0 END) AS ready FROM files').first(),
    ]);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM presence WHERE last_seen > ?').bind(Date.now() - limits(env).leaseMs).first('n');
    return json({ ledger: await wsUsage(env, ledger), totals, files: rooms, online: online.results, onlineCount: count, limits: limits(env), at: Date.now() });
  }
  if (path === '/api/admin/shares' && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') ?? '';
    assert(!cursor || ID_PATTERN.test(cursor), 400, 'invalid_cursor', '游标无效');
    const rows = await env.DB.prepare('SELECT id FROM shares WHERE id > ? ORDER BY id LIMIT 21').bind(cursor).all<{ id: string }>();
    const shares = [];
    if (rows.results.length) await budget(env, '/do-used', { count: Math.min(rows.results.length, 20) });
    for (let i = 0; i < Math.min(rows.results.length, 20); i += 5) {
      shares.push(...await Promise.all(rows.results.slice(i, Math.min(i + 5, 20)).map(async row => {
        const response = await env.ROOMS.get(env.ROOMS.idFromName(row.id)).fetch(new Request('https://room/internal/admin/snapshot'));
        assert(response.ok, 503, 'room_unavailable', '无法读取分享状态'); return response.json();
      })));
    }
    return json({ shares, cursor: rows.results.length > 20 ? rows.results[19].id : null });
  }
  if (path === '/api/admin/objects' && request.method === 'GET') {
    await budget(env, '/r2-operation', { kind: 'A' });
    const result = await env.BUCKET.list({ prefix: 'temporary/', limit: 100, cursor: url.searchParams.get('cursor') ?? undefined });
    return json({ objects: result.objects.map(x => ({ key: x.key, size: x.size, uploaded: x.uploaded.getTime() })), cursor: result.truncated ? result.cursor : null });
  }
  const room = path.match(/^\/api\/admin\/shares\/([a-f0-9]{32})(?:\/files\/([a-f0-9]{32}))?$/);
  const mode = path.match(/^\/api\/admin\/shares\/([a-f0-9]{32})\/files\/([a-f0-9]{32})\/mode$/);
  if (mode && request.method === 'POST') {
    const data = await readJson(request, 1024);
    return managedRoom(env, mode[1], new Request(`https://room/internal/admin/files/${mode[2]}/mode`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-File-Share-Admin': hash! }, body: JSON.stringify(data) }));
  }
  if (room && request.method === 'DELETE') {
    return managedRoom(env, room[1], new Request(`https://room/internal/admin/${room[2] ? `files/${room[2]}` : 'revoke'}`, { method: 'DELETE' }));
  }
  if (path === '/api/admin/objects' && request.method === 'DELETE') {
    const data = await readJson(request, 2048);
    assert(typeof data.key === 'string' && /^temporary\/[a-f0-9]{32}\/[a-f0-9]{32}\/[a-f0-9]{32}$/.test(data.key), 400, 'invalid_key', '仅可管理本项目 temporary/ 下的文件');
    // 已登记的对象必须经过房间，取消签名与迟到上传，不能只删除桶中的当前版本。
    const match = data.key.split('/');
    const exists = await env.DB.prepare('SELECT 1 FROM files WHERE id = ? AND share_id = ?').bind(match[2], match[1]).first();
    if (exists) return managedRoom(env, match[1], new Request(`https://room/internal/admin/files/${match[2]}`, { method: 'DELETE' }));
    await budget(env, '/r2-operation', { kind: 'A', cleanup: true }); await env.BUCKET.delete(data.key); return json({ ok: true });
  }
  assert(false, 404, 'not_found', '管理接口不存在');
}
