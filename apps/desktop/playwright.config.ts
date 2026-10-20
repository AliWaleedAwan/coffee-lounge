/**
 * Counter app end-to-end tests: the real Electron build against disposable shop servers
 * (apps/server/scripts/e2e-server.ts) with throwaway certificates. Windows opens briefly.
 * Run: corepack pnpm --filter @cl/desktop e2e
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
