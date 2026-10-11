import type { ShareRoom } from './room';
import type { TURNBudget } from './budget';
import { FRAME_HEADER_BYTES, SINGLE_PUT_MAX_BYTES, WS_MAX_MESSAGE_BYTES } from '../shared/protocol';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<ShareRoom>;
  BUDGET: DurableObjectNamespace<TURNBudget>;
  LIMITS?: string;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_API_TOKEN?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_TOKEN?: string;
}
export const defaults = {
  maxFileBytes: 10 * 1024 ** 3,
  maxShareBytes: 20 * 1024 ** 3,
  maxFiles: 32,
  maxSessions: 32,
  maxRequests: 16,
  maxSharesPerSource: 5,
  createsPerMinute: 3,
  apiRequestsPerMinute: 180,
  apiRequestsPerDay: 25000,
  doRequestsPerDay: 40000,
  d1RowsReadPerDay: 3000000,
  d1RowsWrittenPerDay: 80000,
  controlMaxBytes: 65536,
  eventQueueSize: 128,
  eventQueueBytes: 65536,
  eventTtlMs: 120000,
  leaseMs: 60000,
  pollMinMs: 2000,
  wsHandshakeMs: 5000,
  connectTimeoutMs: 12000,
  ackTimeoutMs: 20000,
  chunkBytes: 256 * 1024,
  rtcChunkBytes: 32 * 1024,
  windowBytes: 1024 * 1024,
  roomBufferBytes: 8 * 1024 * 1024,
  memoryDownloadBytes: 32 * 1024 * 1024,
  wsEnabled: true,
  wsMaxFileBytes: 512 * 1024 * 1024,
  wsMaxConcurrent: 32,
  wsMonthlyBytes: 10 * 1024 ** 3,
  wsMonthlyMessages: 500000,
  turnEnabled: false,
  turnMonthlyBytes: 850 * 1000 ** 3,
  turnSafetyBytes: 50 * 1000 ** 3,
  turnExternalReserveBytes: 100 * 1000 ** 3,
  turnMaxFileBytes: 256 * 1024 * 1024,
  turnMaxConcurrent: 16,
  turnCredentialSeconds: 600,
  turnStatsMaxAgeMs: 300000,
  r2Enabled: true,
  r2MaxBytes: 8 * 1000 ** 3,
  r2MaxUploads: 16,
  r2ClassAMonthly: 800000,
  r2ClassBMonthly: 8000000,
  uploadUrlSeconds: 300,
  downloadUrlSeconds: 60,
  multipartPartBytes: 64 * 1024 * 1024,
  multipartPauseMs: 300000,
  lateCleanupGraceMs: 3600000,
  tombstoneMs: 86400000,
};
export type Limits = typeof defaults;
export function limits(env: Pick<Env, 'LIMITS'>): Limits {
  const input: unknown = JSON.parse(env.LIMITS ?? '{}');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('LIMITS 必须是 JSON 对象');
  const result = { ...defaults };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`未知配置项 ${key}`);
    const name = key as keyof Limits;
    if (typeof defaults[name] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (['turnSafetyBytes', 'turnExternalReserveBytes'].includes(key) ? 0 : 1)) throw new Error(`${key} 必须是有效整数`);
    Object.assign(result, { [key]: value });
  }
  if (result.chunkBytes + FRAME_HEADER_BYTES > WS_MAX_MESSAGE_BYTES || result.chunkBytes > result.windowBytes || result.windowBytes > result.roomBufferBytes || result.rtcChunkBytes + FRAME_HEADER_BYTES > 65536) throw new Error('数据块、窗口与缓冲配置不一致');
  if (result.multipartPartBytes < 5 * 1024 ** 2 || result.multipartPartBytes > SINGLE_PUT_MAX_BYTES || result.maxFileBytes > 10000 * result.multipartPartBytes) throw new Error('Multipart 参数超出 R2 限制');
  return result;
}
