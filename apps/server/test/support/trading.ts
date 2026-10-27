/**
 * A shop that trades through the real staff API (Phase 5 acceptance): sales by every
 * method, refunds and method corrections approved by a second owner, cash paid in and
 * out, purchases paid at receipt and reversed, supplier refunds, expenses (from the till
 * too) voided and corrected, and owner ledger entries reversed. Alongside, it keeps its
 * own model of what each channel should hold, from the amounts it sent, so tests can
 * compare the ledger with an oracle that does not read the ledger.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Client, IdentityFixture } from './identity.ts';

type Body = Record<string, unknown>;
export type Method = 'cash' | 'card_manual' | 'transfer';
export type Provider = 'bank' | 'jazzcash' | 'easypaisa';
type Channel = 'cash' | 'card' | 'transfer' | 'other';

interface Payment {
  id: string;
  invoiceId: string;
  amount: number;
  refunded: number;
  method: Method;
  provider: Provider | null;
  /** Taken while the current cash shift was open (corrections to or from cash allowed). */
  thisShift: boolean;
}
interface Receipt {
  id: string;
  lineId: string;
  cost: number;
  channel: 'cash' | 'card' | 'transfer' | null;
  returned: boolean;
}
interface ExpenseRec {
  id: string;
  amount: number;
  channel: Channel;
  provider: Provider | null;
  fromTill: boolean;
}

const channelOf = (m: Method): Channel => (m === 'card_manual' ? 'card' : m);
const key = (c: Channel, p: Provider | null) => `${c}|${p ?? ''}`;

export class TradingShop {
  /** Expected balance per channel|provider, in paisa. */
  readonly model = new Map<string, number>();
  readonly payments: Payment[] = [];
  readonly receipts: Receipt[] = [];
  readonly expenses: ExpenseRec[] = [];
  readonly adjustments: {
    id: string;
    reversed: boolean;
    amount: number;
    dir: 'in' | 'out';
    channel: Channel;
    provider: Provider | null;
  }[] = [];
  shiftId: string | null = null;
  private table = 0;
  private coffee = '';
  private milk = { id: '', packId: '' };
  private categories: Record<string, string> = {};

  private readonly fx: IdentityFixture;
  private readonly owner: Client;
  private readonly cashier: Client;
  private readonly approver: { username: string; pin: string };
  private readonly prefix: string;

  constructor(
    fx: IdentityFixture,
    owner: Client,
    cashier: Client,
    approver: { username: string; pin: string },
    prefix: string,
  ) {
    this.fx = fx;
    this.owner = owner;
    this.cashier = cashier;
    this.approver = approver;
    this.prefix = prefix;
  }

  private add(channel: Channel, provider: Provider | null, paisa: number): void {
    const k = key(channel, provider);
    this.model.set(k, (this.model.get(k) ?? 0) + paisa);
  }

  async call(client: Client, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) {
    const res = await client.call({
      method,
      url: `/api/staff/v1${path}`,
      ...(payload ? { payload } : {}),
      ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
    });
    return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
  }
  private async ok(client: Client, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) {
    const res = await this.call(client, method, path, payload);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body;
  }

  /** A command the till may refuse (more cash out than it should hold): false when refused. */
  private async tillMay(client: Client, path: string, payload: object): Promise<Body | false> {
    const res = await this.call(client, 'POST', path, payload);
    if (res.status === 400 && String(res.body['detail']).includes('should be in the till'))
      return false;
    expect(res.status, `POST ${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
    return res.body;
  }

  /** A read as the owner. */
  async read(path: string): Promise<Body> {
    return this.ok(this.owner, 'GET', path);
  }

  /** Coffee sold with a recipe (18 g beans at Rs 0.50): its sales carry costs once picked up. */
  private recipe = false;

  async setUp(options: { recipe?: boolean } = {}): Promise<void> {
    const cat = await this.ok(this.owner, 'POST', '/menu/categories', {
      name: `${this.prefix} menu`,
    });
    const item = await this.ok(this.owner, 'POST', '/menu/items', {
      categoryId: cat['id'],
      name: `${this.prefix} coffee`,
      variants: [{ name: 'Regular', price: '450' }],
    });
    this.coffee = (item['variantIds'] as string[])[0] ?? '';
    const inv = await this.ok(this.owner, 'POST', '/inventory/items', {
      sku: `${this.prefix}-MILK`,
      name: `${this.prefix} milk`,
      baseUom: 'ml',
    });
    const pack = await this.ok(
      this.owner,
      'POST',
      `/inventory/items/${String(inv['id'])}/pack-sizes`,
      {
        name: '1 L carton',
        qty: '1',
        uom: 'l',
      },
    );
    this.milk = { id: String(inv['id']), packId: String(pack['id']) };
    const cats = (await this.ok(this.owner, 'GET', '/expense-categories'))['items'] as {
      id: string;
      name: string;
    }[];
    for (const c of cats) this.categories[c.name] = c.id;
    if (options.recipe) {
      this.recipe = true;
      const beans = await this.ok(this.owner, 'POST', '/inventory/items', {
        sku: `${this.prefix}-BEANS`,
        name: `${this.prefix} beans`,
        baseUom: 'g',
      });
      // Counted at Rs 0.50 a gram through the opening-stock import.
      await this.ok(this.owner, 'POST', '/imports/opening/apply', {
        csv: `sku,lot_code,expiry_date,quantity,uom,total_value\n${this.prefix}-BEANS,,,100,kg,50000\n`,
      });
      const variant = this.coffee;
      const draft = String(
        (await this.ok(this.owner, 'POST', `/recipes/variants/${variant}/draft`, {}))['id'],
      );
      const versions = (await this.ok(this.owner, 'GET', `/recipes/variants/${variant}`))[
        'versions'
      ] as Body[];
      await this.ok(this.owner, 'PUT', `/recipes/versions/${draft}`, {
        expectedVersion: versions.find((v) => v['id'] === draft)?.['version'],
        components: [
          { itemId: beans['id'], qty: '18', forDineIn: true, forTakeaway: true, forDelivery: true },
        ],
      });
      await this.ok(this.owner, 'POST', `/recipes/versions/${draft}/activate`, {});
      await this.ok(this.owner, 'POST', `/recipes/variants/${variant}/stock-mode`, {
        mode: 'recipe',
      });
    }
  }

  async openShift(float = 5000): Promise<void> {
    const res = await this.ok(this.cashier, 'POST', '/cash-shifts', {
      openingFloat: String(float),
    });
    this.shiftId = String(res['shiftId']);
    for (const p of this.payments) p.thisShift = false;
  }

  async closeShift(): Promise<void> {
    if (!this.shiftId) return;
    const current = await this.ok(this.cashier, 'GET', '/cash-shifts/current');
    const expected = String((current['shift'] as Body)['expectedCash']);
    await this.ok(this.cashier, 'POST', `/cash-shifts/${this.shiftId}/close`, {
      countedCash: expected,
    });
    this.shiftId = null;
  }

  /** A table with `qty` coffees (Rs 450 each), paid in full by `method`. */
  async sale(
    qty: number,
    method: Method,
    provider: Provider = 'jazzcash',
    options: { discountPercent?: number } = {},
  ): Promise<Payment> {
    if (method === 'cash' && !this.shiftId) throw new Error('cash sale needs the shift');
    this.table += 1;
    const t = await this.ok(this.owner, 'POST', '/tables', {
      code: `${this.prefix}${String(this.table)}`,
      name: `${this.prefix} table ${String(this.table)}`,
    });
    const s = await this.ok(this.owner, 'POST', `/tables/${String(t['id'])}/sessions`, {});
    await this.ok(this.owner, 'POST', `/sessions/${String(s['id'])}/rounds`, {
      lines: [{ variantId: this.coffee, qty, modifierOptionIds: [] }],
    });
    if (this.recipe) {
      const { rows } = await this.fx.pool.query<{ id: string; qty: number }>(
        'SELECT id::text, qty FROM cl.order_lines WHERE session_id = $1 ORDER BY order_lines.id',
        [s['id']],
      );
      for (const l of rows)
        await this.ok(this.owner, 'POST', `/lines/${l.id}/pickup`, { qty: l.qty });
    }
    const bill = (await this.ok(this.owner, 'GET', `/sessions/${String(s['id'])}/bill`)) as {
      invoice: { id: string };
    };
    if (options.discountPercent) {
      await this.ok(this.owner, 'POST', `/invoices/${bill.invoice.id}/discounts`, {
        orderLineId: null,
        kind: 'percent',
        value: String(options.discountPercent),
        reason: 'Regular guest',
      });
    }
    const locked = await this.ok(this.owner, 'POST', `/invoices/${bill.invoice.id}/lock`, {});
    const amount = Number(locked['total']);
    const paid = await this.ok(this.cashier, 'POST', `/invoices/${bill.invoice.id}/payments`, {
      lockVersion: locked['lockVersion'],
      method,
      amount: String(amount),
      ...(method === 'cash' ? { tendered: String(amount) } : {}),
      ...(method === 'transfer'
        ? { provider, reference: `TX${randomUUID().slice(0, 6)}`, confirmed: true }
        : {}),
    });
    const payment: Payment = {
      id: String(paid['paymentId']),
      invoiceId: bill.invoice.id,
      amount: Math.round(amount * 100),
      refunded: 0,
      method,
      provider: method === 'transfer' ? provider : null,
      thisShift: this.shiftId !== null,
    };
    this.payments.push(payment);
    this.add(channelOf(method), payment.provider, payment.amount);
    return payment;
  }

  private async approval(invoiceId: string, action: string): Promise<string> {
    const res = await this.ok(this.cashier, 'POST', '/auth/step-up', {
      action,
      entityType: 'invoice',
      entityId: invoiceId,
      approverUsername: this.approver.username,
      approverPin: this.approver.pin,
      reason: 'Checked by the owner',
    });
    return String(res['stepUpId']);
  }

  /** Part or all of what is left of a payment, back by its method; null if none can be. */
  async refund(p: Payment, fraction: number): Promise<number | null> {
    const left = p.amount - p.refunded;
    if (left <= 0 || (p.method === 'cash' && !this.shiftId)) return null;
    // `fraction` per cent of what is left, in whole rupees.
    const paisa = Math.max(100, Math.round((left * fraction) / 100 / 100) * 100);
    const amount = Math.min(paisa, left);
    const done = await this.tillMay(this.cashier, `/invoices/${p.invoiceId}/refunds`, {
      kind: 'refund',
      paymentId: p.id,
      amount: (amount / 100).toFixed(2),
      reason: 'Quality',
      ...(p.method === 'transfer' ? { reference: `RV${randomUUID().slice(0, 6)}` } : {}),
      stepUpId: await this.approval(p.invoiceId, 'refund.approve'),
    });
    if (done === false) return null;
    p.refunded += amount;
    this.add(channelOf(p.method), p.provider, -amount);
    return amount;
  }

  /** Says the payment was really taken another way; null when the rules do not allow it now. */
  async correct(p: Payment, method: Method, provider: Provider = 'easypaisa'): Promise<boolean> {
    const next = method === 'transfer' ? provider : null;
    if (p.refunded > 0 || (p.method === method && p.provider === next)) return false;
    if ((method === 'cash' || p.method === 'cash') && (!this.shiftId || !p.thisShift)) return false;
    await this.ok(this.cashier, 'POST', `/invoices/${p.invoiceId}/refunds`, {
      kind: 'method_correction',
      paymentId: p.id,
      method,
      ...(method === 'transfer' ? { provider, reference: `TC${randomUUID().slice(0, 6)}` } : {}),
      reason: 'Taken another way',
      stepUpId: await this.approval(p.invoiceId, 'payment.correct'),
    });
    this.add(channelOf(p.method), p.provider, -p.amount);
    this.add(channelOf(method), next, p.amount);
    p.method = method;
    p.provider = next;
    return true;
  }

  async cashMovement(kind: 'paid_in' | 'paid_out', rupees: number): Promise<boolean> {
    if (!this.shiftId) return false;
    const done = await this.tillMay(this.cashier, `/cash-shifts/${this.shiftId}/movements`, {
      kind,
      amount: String(rupees),
      reason: kind === 'paid_in' ? 'Change from the bank' : 'Small purchase',
    });
    if (done === false) return false;
    this.add('cash', null, (kind === 'paid_in' ? 1 : -1) * rupees * 100);
    return true;
  }

  async receive(
    cartons: number,
    rupees: number,
    channel: 'cash' | 'card' | 'transfer' | null,
  ): Promise<Receipt> {
    const res = await this.ok(this.owner, 'POST', '/purchase-receipts', {
      startStockControl: [this.milk.id],
      ...(channel ? { paidNow: true, paymentChannel: channel } : { paidNow: false }),
      lines: [
        {
          itemId: this.milk.id,
          packSizeId: this.milk.packId,
          packQty: String(cartons),
          lineCost: String(rupees),
        },
      ],
    });
    const receipt: Receipt = {
      id: String(res['receiptId']),
      lineId: String((res['lines'] as { lineId: string }[])[0]?.lineId),
      cost: rupees * 100,
      channel,
      returned: false,
    };
    this.receipts.push(receipt);
    if (channel) this.add(channel, null, -receipt.cost);
    return receipt;
  }

  /** Reverses a receipt if the stock it brought is still there and nothing went back. */
  async reverseReceipt(r: Receipt): Promise<boolean> {
    if (r.returned) return false;
    const res = await this.call(this.owner, 'POST', `/purchase-receipts/${r.id}/reverse`, {
      reason: 'Entered by mistake',
    });
    if (res.status !== 200) return false;
    if (r.channel) this.add(r.channel, null, r.cost);
    r.returned = true;
    return true;
  }

  async supplierRefund(
    r: Receipt,
    rupees: number,
    channel: 'cash' | 'card' | 'transfer',
  ): Promise<boolean> {
    if (r.returned) return false;
    const res = await this.call(this.owner, 'POST', `/purchase-receipts/${r.id}/returns`, {
      lineId: r.lineId,
      qty: '1',
      uom: 'l',
      reason: 'Leaking carton',
      refundAmount: String(rupees),
      refundChannel: channel,
    });
    if (res.status !== 201) return false;
    r.returned = true;
    this.add(channel, null, rupees * 100);
    return true;
  }

  async expense(
    rupees: number,
    channel: Channel,
    options: {
      provider?: Provider;
      fromTill?: boolean;
      businessDate?: string;
      category?: string;
    } = {},
  ): Promise<ExpenseRec | null> {
    if (options.fromTill && !this.shiftId) return null;
    const provider = channel === 'transfer' ? (options.provider ?? 'bank') : null;
    const res = await this.tillMay(this.owner, '/expenses', {
      categoryId: this.categories[options.category ?? 'Supplies'],
      amount: String(rupees),
      paidVia: channel,
      ...(provider ? { provider } : {}),
      ...(options.fromTill ? { fromTill: true } : {}),
      ...(options.businessDate ? { businessDate: options.businessDate } : {}),
      payee: 'Somebody',
    });
    if (res === false) return null;
    const e: ExpenseRec = {
      id: String(res['id']),
      amount: rupees * 100,
      channel,
      provider,
      fromTill: options.fromTill === true,
    };
    this.expenses.push(e);
    this.add(channel, provider, -e.amount);
    return e;
  }

  async voidExpense(e: ExpenseRec): Promise<void> {
    await this.ok(this.owner, 'POST', `/expenses/${e.id}/void`, { reason: 'Entered twice' });
    this.expenses.splice(this.expenses.indexOf(e), 1);
    this.add(e.channel, e.provider, e.amount);
  }

  async correctExpense(e: ExpenseRec, rupees: number): Promise<void> {
    if (e.fromTill && !this.shiftId) return;
    const res = await this.tillMay(this.owner, `/expenses/${e.id}/correct`, {
      reason: 'The bill says otherwise',
      categoryId: this.categories['Supplies'],
      amount: String(rupees),
      paidVia: e.channel,
      ...(e.provider ? { provider: e.provider } : {}),
      ...(e.fromTill ? { fromTill: true } : {}),
    });
    if (res === false) return;
    this.expenses.splice(this.expenses.indexOf(e), 1, {
      ...e,
      id: String(res['id']),
      amount: rupees * 100,
    });
    this.add(e.channel, e.provider, e.amount - rupees * 100);
  }

  async adjust(
    direction: 'in' | 'out',
    rupees: number,
    channel: Channel,
    provider?: Provider,
  ): Promise<void> {
    const res = await this.ok(this.owner, 'POST', '/ledger/entries', {
      direction,
      amount: String(rupees),
      channel,
      ...(channel === 'transfer' ? { provider: provider ?? 'bank' } : {}),
      memo: 'Owner entry',
    });
    const p = channel === 'transfer' ? (provider ?? 'bank') : null;
    this.adjustments.push({
      id: String(res['id']),
      reversed: false,
      amount: rupees * 100,
      dir: direction,
      channel,
      provider: p,
    });
    this.add(channel, p, (direction === 'in' ? 1 : -1) * rupees * 100);
  }

  async reverseAdjustment(index: number): Promise<boolean> {
    const a = this.adjustments[index];
    if (!a || a.reversed) return false;
    await this.ok(this.owner, 'POST', `/ledger/entries/${a.id}/reverse`, { reason: 'Wrong entry' });
    a.reversed = true;
    this.add(a.channel, a.provider, (a.dir === 'in' ? -1 : 1) * a.amount);
    return true;
  }

  /** The ledger's balance per channel|provider, in paisa, from all its entries. */
  async ledgerBalances(): Promise<Map<string, number>> {
    const { rows } = await this.fx.pool.query<{
      channel: Channel;
      provider: Provider | null;
      paisa: string;
    }>(
      `SELECT channel, transfer_provider AS provider,
              (sum(CASE direction WHEN 'in' THEN amount ELSE -amount END) * 100)::bigint::text AS paisa
         FROM cl.ledger_entries GROUP BY channel, transfer_provider`,
    );
    return new Map(
      rows
        .map((r): [string, number] => [key(r.channel, r.provider), Number(r.paisa)])
        .filter(([, v]) => v !== 0),
    );
  }

  expected(): Map<string, number> {
    return new Map([...this.model].filter(([, v]) => v !== 0));
  }
}
