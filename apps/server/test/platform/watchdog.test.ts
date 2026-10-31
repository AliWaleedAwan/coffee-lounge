/**
 * The database watchdog's log on the health page (W-1, step 7.4): each restart is a line that
 * starts with its time; the page shows the last one and how many in the last 7 days.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { watchdogRestarts } from '../../src/platform/health.ts';

const dir = mkdtempSync(join(tmpdir(), 'cl-watchdog-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('database restarts by the watchdog', () => {
  it('counts the last 7 days and names the last restart; nothing when there is no log', () => {
    const file = join(dir, 'pg-watchdog.log');
    writeFileSync(
      file,
      [
        '2026-10-20T03:00:00.000Z PostgreSQL had stopped; the watchdog started it again',
        '2026-10-30T09:15:00.000Z PostgreSQL had stopped; the watchdog started it again',
        '2026-10-31T01:02:00.000Z PostgreSQL had stopped and could not be started: access denied',
        '2026-10-31T07:45:00.000Z PostgreSQL had stopped; the watchdog started it again',
        '',
      ].join('\r\n'),
    );
    expect(watchdogRestarts(file, new Date('2026-10-31T12:00:00Z'))).toEqual({
      last: '2026-10-31T07:45:00.000Z',
      lastWeek: 2,
    });
    expect(watchdogRestarts(join(dir, 'none.log'), new Date())).toEqual({
      last: null,
      lastWeek: 0,
    });
    expect(watchdogRestarts(undefined, new Date())).toEqual({ last: null, lastWeek: 0 });
  });
});
