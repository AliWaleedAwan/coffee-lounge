/** The Updates card's routes: what the updater saw, Check now, and Update now (owner only). */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cl-update-dir-'));
  process.env['UPDATE_DIR'] = dir;
  fx = await identityFixture();
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
});
afterAll(async () => {
  delete process.env['UPDATE_DIR'];
  await fx.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', url: string) =>
  owner.call({
    method,
    url: `/api/staff/v1${url}`,
    ...(method === 'POST' ? { payload: {}, headers: { 'idempotency-key': randomUUID() } } : {}),
  });

describe('updates on the health page', () => {
  it('shows what the updater saw: the version downloaded and when it last looked', async () => {
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({
        current: '1.0.8',
        available: '1.0.9',
        downloaded: '1.0.9',
        checkedAt: Date.parse('2026-11-27T10:00:00Z'),
        checkError: null,
        state: 'idle',
      }),
    );
    expect((await call('GET', '/system/update')).json()).toMatchObject({
      supported: true,
      current: '1.0.8',
      available: '1.0.9',
      downloaded: '1.0.9',
      checkedAt: '2026-11-27T10:00:00.000Z',
      checking: false,
      state: 'idle',
    });
  });

  it('Check now asks the updater to look at once, and says it is checking', async () => {
    expect((await call('POST', '/system/update/check')).statusCode).toBe(202);
    expect(existsSync(join(dir, 'check'))).toBe(true);
    expect((await call('GET', '/system/update')).json()).toMatchObject({ checking: true });
  });

  it('Update now leaves the request for the updater', async () => {
    expect((await call('POST', '/system/update')).statusCode).toBe(202);
    expect(existsSync(join(dir, 'request'))).toBe(true);
    expect((await call('GET', '/system/update')).json()).toMatchObject({ state: 'requested' });
  });
});
