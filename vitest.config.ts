import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        LIMITS: JSON.stringify({ createsPerMinute: 100, maxSharesPerSource: 100, apiRequestsPerMinute: 2000, turnEnabled: true }),
        R2_ACCOUNT_ID: 'test-account', R2_ACCESS_KEY_ID: 'test-access', R2_SECRET_ACCESS_KEY: 'test-secret',
        TURN_KEY_ID: 'test-turn-key', TURN_KEY_API_TOKEN: 'test-turn-token', CF_ACCOUNT_ID: 'test-account', CF_ANALYTICS_API_TOKEN: 'test-analytics',
        ADMIN_TOKEN: 'test-admin-password',
      },
    },
  })],
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['./tests/setup.ts'], testTimeout: 10000, fileParallelism: false },
}));
