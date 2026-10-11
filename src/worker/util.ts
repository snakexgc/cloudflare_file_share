import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Env } from './config';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition { if (!condition) throw new HttpError(status, code, message); }
export function id() { return crypto.randomUUID().replaceAll('-', ''); }
export function token() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export function digest(value: string) { return bytesToHex(sha256(new TextEncoder().encode(value))); }
export function constantEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return n === 0;
}
export function bearer(request: Request) { return request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? ''; }
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json({ error: error.code, message: error.message, details: error.details }, error.status);
  console.error(JSON.stringify({ type: 'server-error', message: error instanceof Error ? error.message : 'unknown' }));
  return json({ error: 'service_unavailable', message: '服务暂时不可用，请稍后重试' }, 503);
}
export async function readJson<T extends object = Record<string, unknown>>(request: Request, maxBytes = 65536): Promise<T> {
  assert(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 400, 'json_required', '接口仅接受 JSON 控制数据');
  assert(!request.headers.has('Content-Encoding'), 400, 'encoding_not_supported', '不接受压缩控制数据');
  const reader = request.body?.getReader();
  assert(reader, 400, 'body_required', '缺少请求数据');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new HttpError(413, 'control_too_large', '控制消息超限，不得发送文件内容'); }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const data: unknown = JSON.parse(text);
    assert(data && typeof data === 'object' && !Array.isArray(data), 400, 'invalid_json', 'JSON 必须是对象');
    return data as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_json', '无法解析 JSON 控制数据');
  } finally { reader.releaseLock(); }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  assert(!origin || origin === new URL(request.url).origin, 403, 'origin_forbidden', '不允许跨站操作');
  assert(request.headers.get('Sec-Fetch-Site') !== 'cross-site', 403, 'origin_forbidden', '不允许跨站操作');
}
export async function budget(env: Env, path: string, data: object): Promise<Record<string, unknown>> {
  const response = await env.BUDGET.get(env.BUDGET.idFromName('global')).fetch(new Request(`https://budget${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }));
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new HttpError(response.status, String(body.error), String(body.message));
  return body;
}
export function safeCapabilities(data: unknown, fileIds: string[]) {
  const value = data as Record<string, unknown> | undefined;
  return { webrtc: value?.webrtc === true, ws: value?.ws === true, readable: Array.isArray(value?.readable) ? value.readable.filter((x): x is string => typeof x === 'string' && fileIds.includes(x)).slice(0, fileIds.length) : [] };
}
