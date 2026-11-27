/** Logs never pile up (owner's request, Nov 2026): an age limit, and a size limit on the folder. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneLogs } from '../../src/worker/maintenance.ts';

const now = new Date('2026-11-27T12:00:00Z');
let dir: string;
const file = (name: string, kb: number, hoursAgo: number) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(kb * 1024));
  const at = new Date(now.getTime() - hoursAgo * 3_600_000);
  utimesSync(path, at, at);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-logs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('log housekeeping', () => {
  it('removes logs older than the age limit', async () => {
    file('old.log', 1, 31 * 24);
    file('new.log', 1, 2);
    expect(await pruneLogs(dir, now)).toBe(1);
    expect(readdirSync(dir)).toEqual(['new.log']);
  });

  it('removes the oldest until the folder is under the size limit', async () => {
    file('a.log', 400, 10);
    file('b.log', 400, 5);
    file('c.log', 400, 3);
    expect(await pruneLogs(dir, now, 30, 900 * 1024)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['b.log', 'c.log']);
  });

  it('never removes a log written in the last hour, even over the limit', async () => {
    file('live.log', 800, 0);
    expect(await pruneLogs(dir, now, 30, 100 * 1024)).toBe(0);
    expect(readdirSync(dir)).toEqual(['live.log']);
  });

  it('leaves folders alone', async () => {
    mkdirSync(join(dir, 'keep'));
    file('x.log', 1, 40 * 24);
    await pruneLogs(dir, now);
    expect(readdirSync(dir)).toEqual(['keep']);
  });
});
