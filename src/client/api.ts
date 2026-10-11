export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export async function api<T>(path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), cache: 'no-store' });
  const data = await response.json() as { error?: string; message?: string; details?: unknown };
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'request_failed', data.message ?? `请求失败 (${response.status})`, data.details);
  return data as T;
}
export function makeId() { return crypto.randomUUID().replaceAll('-', ''); }
export function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('传输已取消')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
