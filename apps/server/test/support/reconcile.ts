/**
 * AC-RPT-1 (TEST_PLAN.md): every total of a report equals the sum of its rows, to the rupee
 * and at full precision. Step 6.5 extends this to the CSV and the PDF of the same report.
 */
import { Decimal } from '@cl/shared';
import { expect } from 'vitest';
import type { Report } from '../../src/modules/reports/index.ts';

const NUMERIC = ['int', 'money', 'cost', 'pct'];

export function expectReconciled(report: Report): void {
  for (const c of report.columns) {
    if (!NUMERIC.includes(c.kind) || c.total === 'derived' || c.total === 'none') continue;
    const values = report.rows.map((r) => r[c.key]).filter((v) => v !== null && v !== undefined);
    const total = report.totals[c.key];
    if (values.length === 0) {
      expect(total, `${report.key}.${c.key}`).toBeNull();
      continue;
    }
    const sum = values.reduce<Decimal>((s, v) => s.plus(new Decimal(v)), new Decimal(0));
    expect(new Decimal(String(total)).toString(), `${report.key}.${c.key}: total = Σ rows`).toBe(
      sum.toString(),
    );
  }
}
