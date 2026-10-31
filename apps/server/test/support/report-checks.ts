/**
 * The AC-RPT-1 oracle shared by the Phase 6 acceptance run and the reports property test:
 * for a period, every report's totals are the sums of its rows and its CSV says the same,
 * and the reports that count the same money agree with each other.
 */
import { Decimal } from '@cl/shared';
import { expect } from 'vitest';
import type { Client } from './identity.ts';
import { expectReconciled } from './reconcile.ts';

type Body = Record<string, unknown>;
type Report = Body & {
  rows: Body[];
  totals: Body;
  columns: { key: string; label: string; kind: string }[];
};
export const dec = (v: unknown) =>
  new Decimal(typeof v === 'string' || typeof v === 'number' ? v : 0);

export async function getOk(client: Client, url: string) {
  const res = await client.call({ method: 'GET', url: `/api/staff/v1${url}` });
  expect(res.statusCode, `${url}: ${res.body.slice(0, 300)}`).toBe(200);
  return res;
}

export const reportOf = async (client: Client, key: string, from: string, to: string) =>
  (await getOk(client, `/reports/${key}?from=${from}&to=${to}`)).json<Report>();

/** Every report the caller may open: totals = Σ rows, and the CSV has the same rows and totals. */
export async function checkEveryReport(client: Client, from: string, to: string): Promise<void> {
  const catalog = (await getOk(client, '/reports')).json<{
    items: { key: string; drillOnly: boolean; formats: string[] }[];
  }>();
  for (const r of catalog.items.filter((x) => !x.drillOnly)) {
    const json = await reportOf(client, r.key, from, to);
    expectReconciled(json as never);
    if (!r.formats.includes('csv')) continue;
    const csv = (
      await getOk(client, `/reports/${r.key}/export?format=csv&from=${from}&to=${to}`)
    ).body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    const hasTotals = json.rows.length > 0 && json.columns.some((c) => json.totals[c.key] !== null);
    expect(csv.length, `${r.key}: CSV rows`).toBe(1 + json.rows.length + (hasTotals ? 1 : 0));
    if (!hasTotals) continue;
    const last = csv.at(-1) ?? '';
    for (const c of json.columns) {
      const v = json.totals[c.key];
      if ((typeof v === 'string' || typeof v === 'number') && c.kind !== 'text')
        expect(last, `${r.key}: CSV total ${c.key}`).toContain(String(v));
    }
  }
}

/** The reports that count the same money agree (FINANCE_REPORTING.md §6, AC-RPT-1). */
export async function checkAgreement(client: Client, from: string, to: string): Promise<void> {
  const of = (key: string) => reportOf(client, key, from, to);
  const day = (await of('sales-by-day')).totals;
  const items = (await of('sales-by-item')).totals;
  const cats = (await of('sales-by-category')).totals;
  const bills = (await of('bills')).totals;
  const mix = (await of('payment-mix')).totals;
  const usage = (await of('inventory-usage')).totals;
  const staff = (await of('staff-activity')).totals;
  const expenses = (await of('expenses')).totals;
  const disc = await of('discounts');
  for (const k of ['gross', 'discounts']) {
    expect(dec(items[k]).toString(), `items ${k}`).toBe(dec(day[k]).toString());
    expect(dec(cats[k]).toString(), `categories ${k}`).toBe(dec(day[k]).toString());
    expect(dec(bills[k]).toString(), `bills ${k}`).toBe(dec(day[k]).toString());
  }
  expect(dec(mix['collected']).toString(), 'collected').toBe(dec(day['collected']).toString());
  expect(dec(bills['total']).toString(), 'bills = taken').toBe(dec(mix['taken']).toString());
  expect(dec(staff['taken']).toString(), 'staff taken').toBe(dec(mix['taken']).toString());
  expect(dec(usage['used_value']).toString(), 'used = COGS').toBe(dec(day['cogs']).toString());
  expect(dec(usage['waste_value']).toString(), 'waste').toBe(dec(day['waste']).toString());
  expect(dec(expenses['amount']).toString(), 'expenses').toBe(dec(day['expenses']).toString());
  const refunds = disc.rows
    .filter((r) => r['kind'] === 'refund')
    .reduce((s, r) => s.plus(dec(r['amount'])), new Decimal(0));
  expect(refunds.toString(), 'refunds').toBe(dec(day['refunds']).toString());
  const overview = (await getOk(client, `/reports/overview?from=${from}&to=${to}`)).json<{
    tiles: { key: string; value: unknown }[];
  }>();
  for (const t of overview.tiles) expect(t.value, `tile ${t.key}`).toEqual(day[t.key] ?? null);
}
