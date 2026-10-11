import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';
import type { Env } from './config';
import { limits } from './config';
import { urlTtl } from '../shared/protocol';
import { assert, budget } from './util';

export function r2Configured(env: Env) { return Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && (env.R2_ACCOUNT_ID || env.R2_ENDPOINT)); }
function client(env: Env) {
  assert(r2Configured(env), 503, 'r2_not_configured', 'R2 直传尚未配置，请联系服务管理员');
  return new AwsClient({ service: 's3', region: 'auto', accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! });
}
function objectUrl(env: Env, key: string) {
  const endpoint = env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = new URL(`${endpoint.replace(/\/$/, '')}/${encodeURIComponent(env.R2_BUCKET_NAME)}/${key.split('/').map(encodeURIComponent).join('/')}`);
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)), 503, 'r2_endpoint', 'R2 endpoint 必须使用 HTTPS');
  return url;
}
export async function presign(env: Env, key: string, method: 'PUT' | 'GET', expiresAt: number, options: { mime?: string; size?: number; uploadId?: string; partNumber?: number; filename?: string } = {}) {
  const conf = limits(env), now = Date.now();
  assert(Math.floor((expiresAt - now) / 1000) >= 1, 410, 'share_expired', '分享已过期，不能再签发链接');
  const ttl = urlTtl(expiresAt, method === 'PUT' ? conf.uploadUrlSeconds : conf.downloadUrlSeconds, now);
  const url = objectUrl(env, key);
  url.searchParams.set('X-Amz-Expires', String(ttl));
  if (options.uploadId) { url.searchParams.set('uploadId', options.uploadId); url.searchParams.set('partNumber', String(options.partNumber)); }
  if (options.filename) {
    const ascii = options.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    url.searchParams.set('response-content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(options.filename).replace(/'/g, '%27')}`);
  }
  const headers: Record<string, string> = {};
  if (method === 'PUT') { headers['Content-Type'] = options.mime ?? 'application/octet-stream'; headers['Content-Length'] = String(options.size); }
  const signed = await client(env).sign(new Request(url, { method, headers }), { aws: { signQuery: true, allHeaders: true } });
  // Content-Length 由浏览器发送 File / Blob 时自动生成，前端不能手动设置该禁用头。
  return { url: signed.url, headers: method === 'PUT' ? { 'Content-Type': headers['Content-Type'] } : {}, signedUntil: now + ttl * 1000 };
}
export interface Part { partNumber: number; etag: string; size: number }
export async function listParts(env: Env, key: string, uploadId: string): Promise<Part[]> {
  const aws = client(env), parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false }), parts: Part[] = [];
  let marker = '';
  do {
    const url = objectUrl(env, key);
    url.searchParams.set('uploadId', uploadId);
    if (marker) url.searchParams.set('part-number-marker', marker);
    await budget(env, '/r2-operation', { kind: 'A' });
    const response = await aws.fetch(url, { signal: AbortSignal.timeout(10000) });
    assert(response.ok, 503, 'multipart_list_failed', '无法查询 R2 分片，请稍后重试');
    const text = await response.text();
    assert(text.length <= 2 * 1024 * 1024, 503, 'multipart_list_invalid', 'R2 分片清单异常');
    const root = parser.parse(text).ListPartsResult;
    assert(root, 503, 'multipart_list_invalid', 'R2 分片清单异常');
    const rows = root.Part ? (Array.isArray(root.Part) ? root.Part : [root.Part]) : [];
    for (const part of rows) parts.push({ partNumber: Number(part.PartNumber), etag: String(part.ETag).replaceAll('"', ''), size: Number(part.Size) });
    assert(parts.length <= 10000 && parts.every(p => Number.isInteger(p.partNumber) && p.partNumber >= 1 && p.partNumber <= 10000 && Number.isSafeInteger(p.size) && p.size >= 0 && p.etag.length > 0), 503, 'multipart_list_invalid', 'R2 分片清单异常');
    const next = root.IsTruncated === 'true' ? String(root.NextPartNumberMarker ?? '') : '';
    assert(!next || (Number(next) > Number(marker || 0)), 503, 'multipart_list_invalid', 'R2 分片分页异常');
    marker = next;
  } while (marker);
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}
export function validateParts(parts: Part[], size: number, partSize: number, complete: boolean) {
  const count = Math.ceil(size / partSize);
  assert(!complete || parts.length === count, 409, 'multipart_incomplete', 'R2 分片尚未全部上传');
  const numbers = new Set<number>();
  for (const part of parts) {
    const expected = Math.min(partSize, size - (part.partNumber - 1) * partSize);
    assert(!numbers.has(part.partNumber) && part.partNumber <= count && part.size === expected, 409, 'multipart_invalid', 'R2 实际分片编号或大小不匹配');
    numbers.add(part.partNumber);
  }
}
/** CreateMultipartUpload 成功而 uploadId 尚未持久化时，只匹配已登记的唯一 key。 */
export async function findMultipartUploads(env: Env, key: string): Promise<string[]> {
  const url = objectUrl(env, ''); url.searchParams.set('uploads', ''); url.searchParams.set('prefix', key); url.searchParams.set('max-uploads', '1000');
  await budget(env, '/r2-operation', { kind: 'A', cleanup: true });
  const response = await client(env).fetch(url, { signal: AbortSignal.timeout(10000) });
  assert(response.ok, 503, 'multipart_cleanup_failed', '无法查询待清理的 Multipart 会话');
  const text = await response.text(); assert(text.length < 2 * 1024 * 1024, 503, 'multipart_cleanup_invalid', '待清理的 Multipart 清单异常');
  const root = new XMLParser({ parseTagValue: false }).parse(text).ListMultipartUploadsResult;
  assert(root && root.IsTruncated !== 'true', 503, 'multipart_cleanup_invalid', '待清理的 Multipart 清单异常');
  const uploads = root.Upload ? (Array.isArray(root.Upload) ? root.Upload : [root.Upload]) : [];
  return uploads.filter((upload: { Key?: string; UploadId?: string }) => upload.Key === key && typeof upload.UploadId === 'string').map((upload: { UploadId: string }) => upload.UploadId);
}
