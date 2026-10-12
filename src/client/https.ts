import type { DownloadRequest } from '../shared/types';
import { ApiError, delay } from './api';
import type { ControlSession } from './control';

export async function httpsFetch(control: ControlSession, task: DownloadRequest, operation: 'chunk' | 'ack', offset: number,
  signal: AbortSignal, timeoutMs: number, body?: Blob | Record<string, unknown>, retries = 2, onUpload?: (bytes: number) => void): Promise<Response> {
  const identity = { fileId: task.fileId, transferId: task.transferId, epoch: task.epoch, offset };
  const query = new URLSearchParams(Object.entries(identity).map(([key, value]) => [key, String(value)]));
  const path = `${control.base}/download-requests/${task.id}/https/${operation}${operation === 'chunk' ? `?${query}` : ''}`;
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = body instanceof Blob && onUpload && typeof XMLHttpRequest === 'function' ? await upload(path, control.sessionToken, body, signal, timeoutMs, onUpload) : await fetch(path, {
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
function upload(path: string, token: string, body: Blob, signal: AbortSignal, timeoutMs: number, progress: (bytes: number) => void) {
  return new Promise<Response>((resolve, reject) => {
    signal.throwIfAborted(); progress(0);
    const xhr = new XMLHttpRequest(), aborted = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', aborted);
    xhr.upload.onprogress = event => progress(Math.min(body.size, event.loaded));
    xhr.open('POST', path); xhr.timeout = timeoutMs;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onload = () => { cleanup(); if (xhr.status >= 200 && xhr.status < 300) progress(body.size); resolve(new Response(xhr.responseText, { status: xhr.status })); };
    xhr.onerror = () => { cleanup(); reject(new Error('HTTPS 上传网络中断')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('HTTPS 上传或 ACK 超时')); };
    xhr.onabort = () => { cleanup(); reject(signal.reason ?? new Error('HTTPS 上传已停止')); };
    signal.addEventListener('abort', aborted, { once: true }); xhr.send(body);
  });
}

/** Read a complete block before writing, so a truncated GET can be repeated safely. */
export async function readHttpsChunk(response: Response, length: number, signal: AbortSignal, progress?: (bytes: number) => void) {
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
      progress?.(offset);
    }
    if (offset !== length) throw new Error('HTTPS 数据块未完整收到');
    return payload;
  } finally { signal.removeEventListener('abort', aborted); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
