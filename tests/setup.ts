import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, afterEach, vi } from 'vitest';
beforeEach(async () => {
  await reset(); await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试禁止未显式替代的外部网络请求'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
