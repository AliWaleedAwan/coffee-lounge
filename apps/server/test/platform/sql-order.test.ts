/**
 * Guards a PostgreSQL trap: in `SELECT id::text … ORDER BY id`, the ORDER BY names the
 * output column, which is text, so "10" sorts before "9". Found in step 3.6, where it
 * would have printed a printer's jobs out of order once ids reached 10. Every query must
 * order by the table's own column instead (`ORDER BY print_jobs.id`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Every `ORDER BY name` whose name is a column the SELECT list casts to text. */
export function textOrdering(source: string): string[] {
  const problems: string[] = [];
  for (const m of source.matchAll(/[`']([^`']*\bSELECT\b[^`']*\bORDER BY\b[^`']*)[`']/gs)) {
    const sql = m[1] ?? '';
    const select = sql.slice(sql.search(/\bSELECT\b/), sql.search(/\bFROM\b/));
    const textColumns = new Set<string>();
    for (const c of select.matchAll(/(?:[a-z_]+\.)?([a-z_]+)::text(?!\s+AS)/g))
      textColumns.add(c[1] ?? '');
    for (const c of select.matchAll(/::text\s+AS\s+([a-z_]+)/g)) textColumns.add(c[1] ?? '');
    const order =
      sql
        .slice(sql.search(/\bORDER BY\b/) + 'ORDER BY'.length)
        .split(/\b(?:LIMIT|OFFSET|FOR UPDATE)\b/)[0] ?? '';
    for (const term of order.split(',')) {
      const name = term.trim().split(/\s+/)[0] ?? '';
      if (name !== '' && !name.includes('.') && textColumns.has(name)) {
        problems.push(
          `line ${String(source.slice(0, m.index).split('\n').length)}: ORDER BY ${name}`,
        );
      }
    }
  }
  return problems;
}

describe('SQL ordering', () => {
  it('finds the trap', () => {
    expect(textOrdering('`SELECT id::text FROM cl.print_jobs ORDER BY id LIMIT 1`')).toEqual([
      'line 1: ORDER BY id',
    ]);
    expect(textOrdering('`SELECT id::text FROM cl.print_jobs ORDER BY print_jobs.id`')).toEqual([]);
    expect(textOrdering("'SELECT a.b::text AS c FROM t ORDER BY c'")).toEqual([
      'line 1: ORDER BY c',
    ]);
  });

  it('no query orders by a column it casts to text', () => {
    const found = ['src', 'scripts', 'test'].flatMap((dir) =>
      files(join(ROOT, dir))
        .filter((f) => !f.endsWith('sql-order.test.ts'))
        .flatMap((f) =>
          textOrdering(readFileSync(f, 'utf8')).map((p) => `${f.slice(ROOT.length)} ${p}`),
        ),
    );
    expect(found).toEqual([]);
  });
});
