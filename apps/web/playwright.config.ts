/**
 * Browser end-to-end tests (TEST_PLAN.md §2 level E2E, AT-86). They drive the installed
 * Google Chrome (no browser download) against a disposable shop started by
 * apps/server/scripts/e2e-server.ts. Run: corepack pnpm --filter @cl/web e2e
 */
import { defineConfig } from '@playwright/test';

const PORT = 18443;

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    channel: 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --env-file=../../.env scripts/e2e-server.ts',
    cwd: '../server',
    url: `http://127.0.0.1:${String(PORT)}/health/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
  },
});
