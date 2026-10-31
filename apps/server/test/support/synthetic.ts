/**
 * Synthetic trading on the sample menu (Phase 6 step 6.7; AC-PERF-4, AC-RPT-1). Day by day
 * on the fixture clock, through the real API: a cash shift from 10:00 to midnight; bills at
 * tables and at the counter, spread over the day, of 1–3 random menu sizes (their required
 * choices taken), picked up so their stock is used, some at 10 % off, paid by cash, card or a
 * transfer; a few refunded; milk received weekly, an ingredient wasted, supplies and the
 * rent paid. Deterministic for a seed. A year of it is the data AC-PERF-4 is measured on.
 */
import { randomUUID } from 'node:crypto';
import { readSampleShop, loadSampleShop } from '../../scripts/sample-shop.ts';
import type { Client, IdentityFixture } from './identity.ts';
import { Random } from './random.ts';

type Body = Record<string, unknown>;

export interface SyntheticOptions {
  /** The first and last business dates to trade (inclusive). */
  from: string;
  to: string;
  billsPerDay: number;
  seed: number;
  /** Sets the fixture clock. */
  setClock: (at: Date) => void;
  /** Called after each day (progress). */
  onDay?: (date: string, bills: number) => void;
}

export interface SyntheticSummary {
  days: number;
  bills: number;
  refunds: number;
  expenses: number;
}

interface Sellable {
  variantId: string;
  required: string[];
  takeaway: boolean;
}

const karachi = (date: string, minutes: number) =>
  new Date(
    `${date}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00+05:00`,
  );
const nextDay = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

export class SyntheticShop {
  private readonly fx: IdentityFixture;
  private readonly owner: Client;
  private readonly cashier: Client;
  private readonly approver: { username: string; pin: string };
  private menu: Sellable[] = [];
  private tables: string[] = [];
  private milkId = '';
  private beansId = '';
  private categories: Record<string, string> = {};

  constructor(
    fx: IdentityFixture,
    owner: Client,
    cashier: Client,
    approver: { username: string; pin: string },
  ) {
    this.fx = fx;
    this.owner = owner;
    this.cashier = cashier;
    this.approver = approver;
  }

  private async call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
    const res = await client.call({
      method,
      url: `/api/staff/v1${path}`,
      ...(payload ? { payload } : {}),
      ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
  }
  private async ok(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
    const res = await this.call(client, method, path, payload);
    if (res.status >= 300)
      throw new Error(`${method} ${path}: ${String(res.status)} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  /** The sample menu, with stock enough for the whole run, 12 tables and the lists. */
  async setUp(): Promise<void> {
    const sample = readSampleShop();
    // A year of sales: open with plenty of every ingredient (receipts come on top).
    for (const i of sample.ingredients) i.opening = String(Number(i.opening) * 1000);
    await loadSampleShop(this.fx.pool, this.fx.ownerId, sample);
    const menu = await this.ok(this.owner, 'GET', '/menu');
    for (const c of menu['categories'] as Body[]) {
      for (const item of c['items'] as Body[]) {
        // Required choices: the first options of each group that needs some.
        const required = ((item['modifierGroups'] as Body[] | undefined) ?? []).flatMap((g) =>
          ((g['options'] as { id: string }[] | undefined) ?? [])
            .slice(0, Number(g['minSelect'] ?? 0))
            .map((o) => o.id),
        );
        for (const v of item['variants'] as Body[]) {
          if (v['available'] === false) continue;
          this.menu.push({
            variantId: String(v['id']),
            required,
            takeaway: item['allowTakeaway'] !== false,
          });
        }
      }
    }
    if (this.menu.length === 0) throw new Error('the sample menu has nothing to sell');
    for (let t = 1; t <= 12; t++) {
      const table = await this.ok(this.owner, 'POST', '/tables', {
        code: `S${String(t)}`,
        name: `Table ${String(t)}`,
      });
      this.tables.push(String(table['id']));
    }
    const { rows } = await this.fx.pool.query<{ sku: string; id: string }>(
      `SELECT sku, id::text FROM cl.inventory_items WHERE sku IN ('MILK','BEANS')`,
    );
    this.milkId = rows.find((r) => r.sku === 'MILK')?.id ?? rows[0]?.id ?? '';
    this.beansId = rows.find((r) => r.sku === 'BEANS')?.id ?? this.milkId;
    const cats = await this.ok(this.owner, 'GET', '/expense-categories');
    for (const c of cats['items'] as { id: string; name: string }[]) this.categories[c.name] = c.id;
  }

  private async bill(
    r: Random,
    takeaway: boolean,
    table: string,
  ): Promise<{ invoiceId: string; total: string; lockVersion: unknown }> {
    const session = takeaway
      ? await this.ok(this.cashier, 'POST', '/sessions/takeaway', {})
      : await this.ok(this.owner, 'POST', `/tables/${table}/sessions`, {});
    const sessionId = String(session['id']);
    const offered = takeaway ? this.menu.filter((m) => m.takeaway) : this.menu;
    const lines = Array.from({ length: r.int(1, 3) }, () => {
      const s = offered[r.int(0, offered.length - 1)] as Sellable;
      return { variantId: s.variantId, qty: r.int(1, 2), modifierOptionIds: s.required };
    });
    await this.ok(takeaway ? this.cashier : this.owner, 'POST', `/sessions/${sessionId}/rounds`, {
      lines,
    });
    const { rows } = await this.fx.pool.query<{ id: string; qty: number }>(
      'SELECT id::text, qty FROM cl.order_lines WHERE session_id = $1 ORDER BY order_lines.id',
      [sessionId],
    );
    for (const l of rows)
      await this.ok(this.owner, 'POST', `/lines/${l.id}/pickup`, { qty: l.qty });
    const bill = (await this.ok(this.owner, 'GET', `/sessions/${sessionId}/bill`)) as {
      invoice: { id: string };
    };
    if (r.chance(0.05)) {
      await this.ok(this.owner, 'POST', `/invoices/${bill.invoice.id}/discounts`, {
        orderLineId: null,
        kind: 'percent',
        value: '10',
        reason: 'Regular guest',
      });
    }
    const locked = await this.ok(this.owner, 'POST', `/invoices/${bill.invoice.id}/lock`, {});
    return {
      invoiceId: bill.invoice.id,
      total: String(locked['total']),
      lockVersion: locked['lockVersion'],
    };
  }

  private async pay(r: Random, invoiceId: string, total: string, lockVersion: unknown) {
    const roll = r.int(1, 100);
    const method = roll <= 50 ? 'cash' : roll <= 75 ? 'card_manual' : 'transfer';
    const providers = ['jazzcash', 'easypaisa', 'bank'];
    const paid = await this.ok(this.cashier, 'POST', `/invoices/${invoiceId}/payments`, {
      lockVersion,
      method,
      amount: total,
      ...(method === 'cash' ? { tendered: total } : {}),
      ...(method === 'transfer'
        ? {
            provider: providers[r.int(0, 2)],
            reference: `TX${randomUUID().slice(0, 6)}`,
            confirmed: true,
          }
        : {}),
    });
    return { paymentId: String(paid['paymentId']), method };
  }

  /** Trades every business date from `from` to `to`. */
  async trade(o: SyntheticOptions): Promise<SyntheticSummary> {
    const r = new Random(o.seed);
    const summary: SyntheticSummary = { days: 0, bills: 0, refunds: 0, expenses: 0 };
    for (let date = o.from; date <= o.to; date = nextDay(date)) {
      o.setClock(karachi(date, 10 * 60));
      const shift = await this.ok(this.cashier, 'POST', '/cash-shifts', { openingFloat: '5000' });
      const n = Math.max(1, Math.round(o.billsPerDay * (0.7 + r.next() * 0.6)));
      // Bill times spread over the day, busier at lunch and in the evening.
      const times = Array.from({ length: n }, () => {
        const peak = r.chance(0.5) ? r.int(12 * 60, 15 * 60) : r.int(18 * 60, 23 * 60);
        return r.chance(0.7) ? peak : r.int(10 * 60 + 5, 23 * 60 + 30);
      }).sort((a, b) => a - b);
      for (const [i, minutes] of times.entries()) {
        o.setClock(karachi(date, minutes));
        const takeaway = r.chance(0.3);
        const { invoiceId, total, lockVersion } = await this.bill(
          r,
          takeaway,
          this.tables[i % this.tables.length] ?? '',
        );
        const { paymentId, method } = await this.pay(r, invoiceId, total, lockVersion);
        summary.bills += 1;
        if (r.chance(0.01) && Number(total) >= 200) {
          const step = await this.ok(this.cashier, 'POST', '/auth/step-up', {
            action: 'refund.approve',
            entityType: 'invoice',
            entityId: invoiceId,
            approverUsername: this.approver.username,
            approverPin: this.approver.pin,
            reason: 'Checked by the owner',
          });
          const done = await this.call(this.cashier, 'POST', `/invoices/${invoiceId}/refunds`, {
            kind: 'refund',
            paymentId,
            amount: String(Math.round(Number(total) / 2)),
            reason: 'Quality',
            ...(method === 'transfer' ? { reference: `RV${randomUUID().slice(0, 6)}` } : {}),
            stepUpId: step['stepUpId'],
          });
          if (done.status < 300) summary.refunds += 1;
        }
      }
      o.setClock(karachi(date, 23 * 60 + 40));
      const day = new Date(`${date}T00:00:00Z`);
      if (day.getUTCDay() === 1) {
        await this.ok(this.owner, 'POST', '/purchase-receipts', {
          paidNow: true,
          paymentChannel: 'card',
          lines: [{ itemId: this.milkId, qty: '24', uom: 'l', lineCost: '6600' }],
        });
        await this.ok(this.owner, 'POST', '/inventory/waste', {
          itemId: this.beansId,
          qty: '50',
          reasonCode: 'spilled',
        });
        await this.ok(this.owner, 'POST', '/expenses', {
          categoryId: this.categories['Supplies'],
          amount: String(r.int(800, 2500)),
          paidVia: 'card',
          payee: 'Cash and carry',
        });
        summary.expenses += 1;
      }
      if (date.endsWith('-01')) {
        await this.ok(this.owner, 'POST', '/expenses', {
          categoryId: this.categories['Rent'],
          amount: '120000',
          paidVia: 'transfer',
          provider: 'bank',
          payee: 'Landlord',
        });
        summary.expenses += 1;
      }
      const current = await this.ok(this.cashier, 'GET', '/cash-shifts/current');
      const expected = String((current['shift'] as Body)['expectedCash']);
      await this.ok(this.cashier, 'POST', `/cash-shifts/${String(shift['shiftId'])}/close`, {
        countedCash: expected,
      });
      summary.days += 1;
      o.onDay?.(date, n);
    }
    return summary;
  }
}
