import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          include: ['packages/*/src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
        },
      },
      {
        test: {
          name: 'server',
          include: ['apps/server/src/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
          globalSetup: ['apps/server/test/global-setup.ts'],
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
