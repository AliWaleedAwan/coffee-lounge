/** The continuous local copy keeps only the newest finished segments, and the one in progress. */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneLiveWal } from '../../src/modules/backup/index.ts';

describe('live copy pruning', () => {
  it('removes the oldest finished segments only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-live-'));
    const name = (n: number) => n.toString(16).toUpperCase().padStart(24, '0');
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, name(i)), 'x');
    writeFileSync(join(dir, `${name(6)}.partial`), 'x');
    expect(pruneLiveWal(dir, 2)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([name(4), name(5), `${name(6)}.partial`]);
  });
});
