import type { Env } from './config';
import { limits } from './config';
import { assert, budget, checkOrigin, constantEqual, digest, errorResponse, id, json, readJson, token } from './util';
import { ID_PATTERN, validHours } from '../shared/protocol';
import { r2Configured } from './r2';
import { meteredDB } from './db';
export { ShareRoom } from './room';
export { TURNBudget } from './budget';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https: wss:; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
async function createShare(request: Request, env: Env, source: string) {
  const conf = limits(env), data = await readJson(request, conf.controlMaxBytes);
  assert(validHours(data.expiresInHours), 400, 'invalid_expiry', '有效期必须是 1–24 小时的整数');
  assert(Array.isArray(data.files) && data.files.length >= 1 && data.files.length <= conf.maxFiles, 400, 'invalid_files', `请选择 1–${conf.maxFiles} 个文件`);
  let total = 0;
  const files = data.files.map((input: unknown) => {
    assert(input && typeof input === 'object', 400, 'invalid_file', '文件元数据无效');
    const value = input as Record<string, unknown>;
    assert(typeof value.name === 'string' && value.name.length > 0 && new TextEncoder().encode(value.name).byteLength <= 1024 && !/[\x00-\x1f\x7f/\\]/.test(value.name), 400, 'invalid_filename', '文件名无效');
    assert(typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= conf.maxFileBytes, 400, 'file_too_large', '单文件大小超出限制');
    assert(typeof value.lastModified === 'number' && Number.isSafeInteger(value.lastModified) && value.lastModified >= 0, 400, 'invalid_file_identity', '文件修改时间无效');
    assert(typeof value.mime === 'string' && value.mime.length <= 128 && !/[\x00-\x1f\x7f]/.test(value.mime), 400, 'invalid_mime', '文件类型无效');
    total += value.size;
    return { id: id(), name: value.name, size: value.size, mime: value.mime || 'application/octet-stream', lastModified: value.lastModified, uploadStatus: 'none' as const };
  });
  assert(Number.isSafeInteger(total) && total <= conf.maxShareBytes, 400, 'share_too_large', '分享总大小超出限制');
  if (env.TURNSTILE_SECRET_KEY) {
    assert(typeof data.turnstileToken === 'string' && data.turnstileToken.length <= 2048, 403, 'challenge_required', '请先完成人机验证');
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: data.turnstileToken, remoteip: request.headers.get('CF-Connecting-IP') ?? '' }), signal: AbortSignal.timeout(10000) });
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
    assert(result.success && result.hostname === new URL(request.url).hostname && result.action === 'create-share', 403, 'challenge_failed', '人机验证失败，请重试');
  }
  const shareId = id(), ownerToken = token(), createdAt = Date.now(), expiresAt = createdAt + data.expiresInHours * 3600000;
  await budget(env, '/reserve', { id: `share:${shareId}`, kind: 'share', bytes: 0, source, expiresAt });
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO shares (id, owner_token_hash, source_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(shareId, digest(ownerToken), source, createdAt, expiresAt),
      ...files.map(f => env.DB.prepare('INSERT INTO files (id, share_id, name, size_bytes, mime, last_modified) VALUES (?, ?, ?, ?, ?, ?)').bind(f.id, shareId, f.name, f.size, f.mime, f.lastModified)),
    ]);
    const response = await env.ROOMS.get(env.ROOMS.idFromName(shareId)).fetch(new Request('https://room/internal/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: shareId, ownerTokenHash: digest(ownerToken), sourceHash: source, createdAt, expiresAt, status: 'active', cleanupStatus: 'pending', files, requests: [], uploads: [], pendingRevocations: [] }),
    }));
    assert(response.ok, 503, 'share_initialization_failed', '分享初始化失败，请重试');
    return json({ id: shareId, ownerToken, createdAt, expiresAt, files, url: `${new URL(request.url).origin}/s/${shareId}` }, 201);
  } catch (error) {
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(shareId).run();
    await budget(env, '/release', { id: `share:${shareId}` }); throw error;
  }
}
async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    checkOrigin(request);
    const source = digest(request.headers.get('CF-Connecting-IP') ?? 'local');
    if (url.pathname === '/api/admin/budget') {
      assert(env.ADMIN_TOKEN && constantEqual(request.headers.get('Authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`), 403, 'admin_forbidden', '管理权限不足');
      return json(await budget(env, '/snapshot', {}));
    }
    await budget(env, '/charge', { source, room: url.pathname.startsWith('/api/shares/'), create: url.pathname === '/api/shares' && request.method === 'POST', cleanup: request.method === 'DELETE' || (request.method === 'POST' && (url.pathname.endsWith('/abort') || url.pathname.endsWith('/failure'))) });
    if (url.pathname === '/api/config' && request.method === 'GET') {
      const conf = limits(env);
      return json({ limits: conf, r2Configured: r2Configured(env), turnConfigured: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN && env.CF_ANALYTICS_API_TOKEN), turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null, challengeRequired: Boolean(env.TURNSTILE_SECRET_KEY), stunServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    }
    if (url.pathname === '/api/shares' && request.method === 'POST') return createShare(request, env, source);
    const match = url.pathname.match(/^\/api\/shares\/([a-f0-9]{32})(?:\/|$)/);
    assert(match && ID_PATTERN.test(match[1]), 404, 'not_found', '接口不存在');
    return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
  }
  assert(request.method === 'GET' || request.method === 'HEAD', 405, 'method_not_allowed', '页面仅支持 GET 或 HEAD');
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    env = { ...env, DB: meteredDB(env.DB, env) };
    let response: Response;
    try { response = await handle(request, env); } catch (error) { response = errorResponse(error); }
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(securityHeaders)) secured.headers.set(name, value);
    return secured;
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    env = { ...env, DB: meteredDB(env.DB, env) };
    ctx.waitUntil((async () => {
      let cursor = '';
      while (true) {
        const rows = await env.DB.prepare("SELECT DISTINCT s.id FROM shares s LEFT JOIN cleanup_tasks c ON c.share_id = s.id WHERE s.id > ? AND ((s.expires_at <= ? AND s.cleanup_status != 'cleaned') OR s.status = 'revoked' OR c.next_retry_at <= ? OR (s.cleaned_at IS NOT NULL AND s.cleaned_at + ? <= ?)) ORDER BY s.id LIMIT 100").bind(cursor, Date.now(), Date.now(), limits(env).tombstoneMs, Date.now()).all<{ id: string }>();
        if (!rows.results.length) break;
        for (let i = 0; i < rows.results.length; i += 5) {
          const results = await Promise.allSettled(rows.results.slice(i, i + 5).map(async row => {
            const response = await env.ROOMS.get(env.ROOMS.idFromName(row.id)).fetch(new Request('https://room/internal/sweep', { method: 'POST' }));
            if (!response.ok) console.error(JSON.stringify({ type: 'cleanup-retry', shareId: row.id, status: response.status }));
          }));
          for (const result of results) if (result.status === 'rejected') console.error(JSON.stringify({ type: 'cleanup-retry', message: String(result.reason).slice(0, 200) }));
        }
        cursor = rows.results.at(-1)!.id;
      }
    })());
  },
} satisfies ExportedHandler<Env>;
