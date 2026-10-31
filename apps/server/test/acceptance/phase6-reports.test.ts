/**
 * Phase 6 acceptance (step 6.7): synthetic trading on the sample menu (test/support/synthetic.ts),
 * then every report checked across the whole period and each month in it (AC-RPT-1): its
 * totals are the sums of its rows, its CSV says the same to the rupee, the reports that count
 * the same money agree, the overview's tiles are their reports' totals, and each day's stored
 * day-end matches its day. With CL_SYNTH_DAYS=365 it is the year AC-PERF-4 is measured on:
 * each month-range owner report is timed (CL_PERF=<file> writes progress and the table there).
 *
 *   CL_SYNTH_DAYS=365 CL_SYNTH_BILLS=60 CL_PERF=.local/perf.md npx vitest run --project server apps/server/test/acceptance/phase6-reports.test.ts
 */
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/modules/reports/index.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import {
  checkAgreement,
  checkEveryReport,
  dec,
  getOk,
  reportOf,
} from '../support/report-checks.ts';
import { SyntheticShop, type SyntheticSummary } from '../support/synthetic.ts';

const DAYS = Number(process.env['CL_SYNTH_DAYS'] ?? 10);
const BILLS = Number(process.env['CL_SYNTH_BILLS'] ?? 12);
const PERF_LIMIT_MS = 3_000;
const PERF = process.env['CL_PERF'];
const note = (line: string) => {
  if (PERF) appendFileSync(PERF, `${line}\n`);
};

let fx: IdentityFixture;
let owner: Client;
let clock = new Date();
let from = '';
let to = '';
let summary: SyntheticSummary;

type Body = Record<string, unknown>;
const get = (url: string) => getOk(owner, url);
const report = (key: string, f: string, t: string) => reportOf(owner, key, f, t);

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app', now: () => clock });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('sy-cash', ['cashier']);
  await fx.addUser('sy-partner', ['owner'], { pin: '1357' });
  const cashier = await fx.loggedIn('sy-cash');
  // The days traded end yesterday, so every one of them is complete.
  const today = await businessDateOf(fx.pool, new Date());
  to = addDays(today, -1);
  from = addDays(to, -(DAYS - 1));
  const shop = new SyntheticShop(fx, owner, cashier, { username: 'sy-partner', pin: '1357' });
  await shop.setUp();
  const started = performance.now();
  summary = await shop.trade({
    from,
    to,
    billsPerDay: BILLS,
    seed: 20261031,
    setClock: (at) => {
      clock = at;
    },
    ...(PERF
      ? {
          onDay: (date: string) => {
            if (date.endsWith('-01') || date === to)
              note(`traded to ${date} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
          },
        }
      : {}),
  });
  clock = new Date();
}, 24 * 3600_000);
afterAll(async () => {
  await fx.close();
});

const months = () => {
  const out: { from: string; to: string }[] = [];
  for (let m = `${from.slice(0, 7)}-01`; m <= to;) {
    const next = new Date(`${m}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const end = addDays(next.toISOString().slice(0, 10), -1);
    out.push({ from: m < from ? from : m, to: end > to ? to : end });
    m = next.toISOString().slice(0, 10);
  }
  return out;
};

describe(`Phase 6 acceptance on synthetic trading (${String(DAYS)} days)`, () => {
  it('traded what it set out to', () => {
    expect(summary.days).toBe(DAYS);
    expect(summary.bills).toBeGreaterThan(DAYS * BILLS * 0.6);
  });

  it('AC-RPT-1: every report adds up, its CSV says the same, and they agree, for the period and each month', async () => {
    for (const p of [{ from, to }, ...months()]) {
      await checkEveryReport(owner, p.from, p.to);
      await checkAgreement(owner, p.from, p.to);
    }
  }, 3600_000);

  it('the overview’s tiles are its reports’ totals; each day-end is its day', async () => {
    const overview = (await get(`/reports/overview?from=${from}&to=${to}`)).json<{
      tiles: { key: string; value: unknown }[];
    }>();
    const day = (await report('sales-by-day', from, to)).totals;
    for (const t of overview.tiles) expect(t.value, t.key).toEqual(day[t.key] ?? null);
    const days = (await report('sales-by-day', from, to)).rows;
    for (const d of days.slice(-7)) {
      const end = (await get(`/reports/day-end?date=${String(d['date'])}`)).json<{
        report: { sales: Body };
      }>();
      expect(dec(end.report.sales['net_sales']).toString(), String(d['date'])).toBe(
        dec(d['net_sales']).toString(),
      );
      expect(end.report.sales['orders']).toBe(d['orders']);
    }
  }, 600_000);

  it('AC-PERF-4: month-range owner reports', async () => {
    const month = months().at(-2) ?? months().at(-1) ?? { from, to };
    const catalog = (await get('/reports')).json<{
      items: { key: string; drillOnly: boolean }[];
    }>();
    const timings: [string, number][] = [];
    const time = async (name: string, url: string) => {
      await get(url); // warm
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        await get(url);
        runs.push(performance.now() - t0);
      }
      timings.push([name, Math.max(...runs)]);
    };
    await time('overview', `/reports/overview?from=${month.from}&to=${month.to}`);
    for (const r of catalog.items.filter((x) => !x.drillOnly))
      await time(r.key, `/reports/${r.key}?from=${month.from}&to=${month.to}`);
    await time(
      'sales-by-day PDF',
      `/reports/sales-by-day/export?format=pdf&from=${month.from}&to=${month.to}`,
    );
    note(
      `month ${month.from} to ${month.to}; ${String(summary.bills)} bills in ${String(DAYS)} days`,
    );
    for (const [name, ms] of timings) note(`| ${name} | ${ms.toFixed(0)} ms |`);
    for (const [name, ms] of timings) expect(ms, name).toBeLessThanOrEqual(PERF_LIMIT_MS);
  }, 600_000);
});
