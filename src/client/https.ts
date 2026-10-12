import type { DownloadRequest } from '../shared/types';
import { ApiError, delay } from './api';
import type { ControlSession } from './control';

export async function httpsFetch(control: ControlSession, task: DownloadRequest, operation: 'chunk' | 'ack', offset: number,
  signal: AbortSignal, timeoutMs: number, body?: Blob | Record<string, unknown>, retries = 2): Promise<Response> {
  const identity = { fileId: task.fileId, transferId: task.transferId, epoch: task.epoch, offset };
  const query = new URLSearchParams(Object.entries(identity).map(([key, value]) => [key, String(value)]));
  const path = `${control.base}/download-requests/${task.id}/https/${operation}${operation === 'chunk' ? `?${query}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
        headers: { Authorization: `Bearer ${control.sessionToken}`, ...(body === undefined ? {} : { 'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json' }) },
        body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(identity),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string; message?: string };
        throw new ApiError(response.status, data.error ?? 'https_failed', data.message ?? `HTTPS 请求失败 (${response.status})`);
      }
      if (body !== undefined) await response.clone().json();
      return response;
    } catch (error) {
      if (signal.aborted || attempt >= retries || error instanceof ApiError && error.status < 500) throw error;
      await delay(250 * 2 ** attempt, signal);
    }
  }
}

/** Read a complete block before writing, so a truncated GET can be repeated safely. */
export async function readHttpsChunk(response: Response, length: number, signal: AbortSignal) {
  if (response.headers.has('Content-Length') && Number(response.headers.get('Content-Length')) !== length) throw new Error('HTTPS 数据块声明长度不一致');
  if (!response.body) throw new Error('HTTPS 数据块缺少响应体');
  const reader = response.body.getReader(), payload = new Uint8Array(length);
  const aborted = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  let offset = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      if (offset + next.value.byteLength > length) throw new Error('HTTPS 数据块越界');
      payload.set(next.value, offset); offset += next.value.byteLength;
    }
    if (offset !== length) throw new Error('HTTPS 数据块未完整收到');
    return payload;
  } finally { signal.removeEventListener('abort', aborted); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
