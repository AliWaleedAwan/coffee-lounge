/**
 * Load test for AC-PERF-1 and AC-PERF-2 (TEST_PLAN.md; P7-6; Phase 7 step 7.5). Runs on a
 * laptop on the shop Wi-Fi (nothing is installed on the server PC) against a shop that holds
 * no real trading yet: it makes its own tables "Load 1…12" and its orders.
 *
 *   NODE_EXTRA_CA_CERTS=<coffee-lounge-root.pem> CL_LOAD_PASSWORD=<owner password> \
 *     node scripts/load.ts --staff https://192.168.100.250:8443 --guest http://192.168.100.250:8080 \
 *       --code <registration code> [--user owner] [--minutes 30] [--lines-per-hour 120] [--out load.json]
 *   (in development: --state <e2e state file> instead of --code and the password)
 *
 * The devices of the SRS's peak: 3 tablets and 6 phones (waiters: open a table, send a round,
 * mark it picked up), the counter PC (lock and take payment), and 30 guest phones (open the
 * table's QR page, read the menu, refresh their order every 15 s). One live-updates stream
 * measures how long a change takes to reach a screen. A request that fails for want of the
 * server (it restarted, a power cut) is sent again with the same Idempotency-Key, so a retry
 * never doubles an order or a payment (AT-56). Prints p50/p95/p99 per kind of request against
 * the targets: p95 ≤ 300 ms and p99 ≤ 1 s for ordering, pickup and payment; live updates p95
 * ≤ 1 s and p99 ≤ 2 s.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    staff: { type: 'string' },
    guest: { type: 'string' },
    code: { type: 'string' },
    user: { type: 'string', default: 'owner' },
    state: { type: 'string' },
    minutes: { type: 'string', default: '30' },
    'lines-per-hour': { type: 'string', default: '120' },
    out: { type: 'string' },
    // A test shop with no menu yet (development, CI): one item to sell.
    'create-menu': { type: 'boolean' },
  },
});
if (!values.staff || !values.guest) {
  console.error(
    'usage: node scripts/load.ts --staff <https url> --guest <http url> --code <code> …',
  );
  process.exit(2);
}
const STAFF = `${values.staff}/api/staff/v1`;
const GUEST = `${values.guest}/api/customer/v1`;
const state = values.state
  ? (JSON.parse(readFileSync(values.state, 'utf8')) as {
      owner: { username: string; password: string };
      codes: string[];
    })
  : null;
const password = state?.owner.password ?? process.env['CL_LOAD_PASSWORD'] ?? '';
const username = state?.owner.username ?? values.user;
const firstCode = values.code ?? state?.codes.at(-1) ?? '';
if (!password || !firstCode) {
  console.error('Need the owner password (CL_LOAD_PASSWORD) and a registration code (--code).');
  process.exit(2);
}
const MINUTES = Number(values.minutes);
const LINES_PER_HOUR = Number(values['lines-per-hour']);
const stopAt = Date.now() + MINUTES * 60_000;

// ------------------------------------------------------------------ measuring

type Kind = 'order' | 'pickup' | 'payment' | 'read' | 'guest';
const samples: Record<Kind, number[]> = { order: [], pickup: [], payment: [], read: [], guest: [] };
const liveDelays: number[] = [];
let retries = 0;
const guestFailures = new Set<string>();
let errors = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Client {
  cookies = new Map<string, string>();
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  /** One request; a dropped connection or 5xx is retried with the same Idempotency-Key. */
  async call(
    method: string,
    path: string,
    body: unknown,
    kind: Kind,
  ): Promise<Record<string, unknown>> {
    const key = randomUUID();
    for (let attempt = 0; ; attempt++) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(method === 'GET' ? {} : { 'idempotency-key': key, 'x-cl-request': '1' }),
            cookie: this.cookieHeader(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        for (const c of res.headers.getSetCookie()) {
          const [pair] = c.split(';');
          const [k, ...v] = (pair ?? '').split('=');
          if (k) this.cookies.set(k.trim(), v.join('='));
        }
        const text = await res.text();
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${String(res.status)}`);
        if (attempt === 0) samples[kind].push(performance.now() - t0);
        if (res.status >= 400) {
          errors += 1;
          throw Object.assign(
            new Error(`${method} ${path}: ${String(res.status)} ${text.slice(0, 200)}`),
            { fatal: true },
          );
        }
        return text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch (e) {
        if ((e as { fatal?: boolean }).fatal || attempt >= 60 || Date.now() > stopAt + 300_000)
          throw e;
        retries += 1;
        await sleep(Math.min(5_000, 250 * 2 ** attempt));
      }
    }
  }
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0);
};

// ------------------------------------------------------------------ setting up

async function device(code: string): Promise<Client> {
  const c = new Client(STAFF);
  await c.call('POST', '/devices/register', { code }, 'read');
  await c.call('POST', '/auth/login', { username, password }, 'read');
  return c;
}

const owner = await device(firstCode);
const codes: string[] = [];
for (let i = 0; i < 10; i++) {
  const r = await owner.call(
    'POST',
    '/devices/registration-codes',
    {
      deviceName: `Load device ${String(i + 1)}`,
      kind: i === 9 ? 'reception' : 'waiter',
      ownership: 'shop',
    },
    'read',
  );
  codes.push(String(r['code']));
}
const waiters = await Promise.all(codes.slice(0, 9).map((c) => device(c)));
const counter = await device(codes[9] ?? '');

const menu = await owner.call('GET', '/menu', undefined, 'read');
const sellable: { variantId: string; options: string[] }[] = [];
for (const cat of menu['categories'] as Record<string, unknown>[]) {
  for (const item of cat['items'] as Record<string, unknown>[]) {
    const options = (
      (item['modifierGroups'] as Record<string, unknown>[] | undefined) ?? []
    ).flatMap((g) =>
      ((g['options'] as { id: string }[] | undefined) ?? [])
        .slice(0, Number(g['minSelect'] ?? 0))
        .map((o) => o.id),
    );
    for (const v of item['variants'] as Record<string, unknown>[])
      if (v['available'] !== false && item['allowDineIn'] !== false)
        sellable.push({ variantId: String(v['id']), options });
  }
}
if (sellable.length === 0 && values['create-menu']) {
  const cat = await owner.call('POST', '/menu/categories', { name: 'Load test' }, 'read');
  const item = await owner.call(
    'POST',
    '/menu/items',
    { categoryId: cat['id'], name: 'Load coffee', variants: [{ name: 'Regular', price: '450' }] },
    'read',
  );
  sellable.push({ variantId: (item['variantIds'] as string[])[0] ?? '', options: [] });
}
if (sellable.length === 0)
  throw new Error('the menu has nothing to sell (load a menu, or --create-menu on a test shop)');

const run = randomUUID().slice(0, 4).toUpperCase();
const tables: { id: string; code: string; token: string }[] = [];
for (let t = 1; t <= 12; t++) {
  const code = `LD${run}${String(t)}`;
  const table = await owner.call(
    'POST',
    '/tables',
    { code, name: `Load ${run}-${String(t)}` },
    'read',
  );
  tables.push({ id: String(table['id']), code, token: '' });
}
const qr = await owner.call(
  'POST',
  '/qr-entry-points/generate',
  { tableIds: tables.map((t) => t.id), counter: false },
  'read',
);
// Matched by table code: each table's QR token, as printed on its card.
for (const item of qr['items'] as { tableCode: string; token: string }[]) {
  const t = tables.find((x) => x.code === item.tableCode);
  if (t) t.token = item.token;
}

// ------------------------------------------------------------------ live updates

/** Rounds sent and not yet seen on the stream: round id → when the request was sent. */
const pendingLive = new Map<string, number>();
async function listen(): Promise<void> {
  while (Date.now() < stopAt) {
    try {
      const res = await fetch(`${STAFF}/events`, {
        headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      });
      const reader = res.body?.getReader();
      let buffer = '';
      if (!reader) throw new Error('no stream');
      for (;;) {
        const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (done || Date.now() > stopAt) break;
        buffer += new TextDecoder().decode(value);
        // Each event names its record: a round's event arriving is that round on screen.
        for (const m of buffer.matchAll(/"type":"order_round","id":"(\d+)"/g)) {
          const sent = pendingLive.get(m[1] ?? '');
          if (sent !== undefined) {
            liveDelays.push(performance.now() - sent);
            pendingLive.delete(m[1] ?? '');
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 1);
      }
    } catch {
      await sleep(2_000);
    }
  }
}

// ------------------------------------------------------------------ the actors

let orders = 0;
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;

async function waiter(c: Client, table: { id: string }): Promise<void> {
  // Lines per waiter per hour, as rounds of 1–2 lines.
  const gapMs = (3600_000 / (LINES_PER_HOUR / waiters.length)) * 1.5;
  await sleep(Math.random() * gapMs);
  while (Date.now() < stopAt) {
    const s = await c.call('POST', `/tables/${table.id}/sessions`, {}, 'order');
    const sessionId = String(s['id']);
    const lines = Array.from({ length: Math.random() < 0.5 ? 1 : 2 }, () => {
      const v = pick(sellable);
      return { variantId: v.variantId, qty: 1, modifierOptionIds: v.options };
    });
    const sent = performance.now();
    const round = await c.call('POST', `/sessions/${sessionId}/rounds`, { lines }, 'order');
    pendingLive.set(String(round['id']), sent);
    const view = await c.call('GET', `/sessions/${sessionId}`, undefined, 'read');
    for (const r of (view['rounds'] as { lines?: { id: string; qty: number }[] }[] | undefined) ??
      [])
      for (const l of r.lines ?? [])
        await c.call('POST', `/lines/${l.id}/pickup`, { qty: l.qty }, 'pickup');
    const bill = await counter.call('GET', `/sessions/${sessionId}/bill`, undefined, 'read');
    const invoiceId = (bill['invoice'] as { id: string }).id;
    const locked = await counter.call('POST', `/invoices/${invoiceId}/lock`, {}, 'payment');
    await counter.call(
      'POST',
      `/invoices/${invoiceId}/payments`,
      {
        lockVersion: locked['lockVersion'],
        method: 'card_manual',
        amount: String(locked['total']),
      },
      'payment',
    );
    orders += 1;
    await sleep(gapMs * (0.5 + Math.random()));
  }
}

async function guest(table: { token: string }): Promise<void> {
  const g = new Client(GUEST);
  await sleep(Math.random() * 15_000);
  try {
    await g.call('GET', `/entry/${table.token}`, undefined, 'guest');
    await g.call('GET', '/menu', undefined, 'guest');
    while (Date.now() < stopAt) {
      // The menu, as a guest page refreshing it (their order is polled only once they order).
      await g.call('GET', '/menu', undefined, 'guest');
      await sleep(15_000);
    }
  } catch (e) {
    guestFailures.add(e instanceof Error ? e.message : String(e));
  }
}

console.log(
  `Load: ${String(waiters.length)} waiter devices, a counter, 30 guests, ${String(LINES_PER_HOUR)} lines an hour, ${String(MINUTES)} minutes`,
);
const started = Date.now();
const actors = [
  listen(),
  ...waiters.map((w, i) =>
    waiter(w, tables[i % tables.length] ?? { id: '' }).catch((e: unknown) => {
      console.error(`waiter ${String(i)}: ${e instanceof Error ? e.message : String(e)}`);
    }),
  ),
  ...Array.from({ length: 30 }, (_, i) => guest(tables[i % tables.length] ?? { token: '' })),
];
await Promise.all(actors);

const busy = [...samples.order, ...samples.pickup, ...samples.payment];
const result = {
  minutes: Math.round((Date.now() - started) / 600) / 100,
  orders,
  retries,
  errors,
  latencyMs: Object.fromEntries(
    (Object.keys(samples) as Kind[]).map((k) => [
      k,
      {
        n: samples[k].length,
        p50: pct(samples[k], 50),
        p95: pct(samples[k], 95),
        p99: pct(samples[k], 99),
      },
    ]),
  ),
  busy: { p95: pct(busy, 95), p99: pct(busy, 99) },
  guestFailures: [...guestFailures],
  liveMs: { n: liveDelays.length, p95: pct(liveDelays, 95), p99: pct(liveDelays, 99) },
};
const pass = {
  'AC-PERF-1': (result.busy.p95 ?? 0) <= 300 && (result.busy.p99 ?? 0) <= 1000,
  'AC-PERF-2': (result.liveMs.p95 ?? 0) <= 1000 && (result.liveMs.p99 ?? 0) <= 2000,
};
console.log(JSON.stringify({ ...result, pass }, null, 2));
if (values.out) writeFileSync(values.out, `${JSON.stringify({ ...result, pass }, null, 2)}\n`);
process.exit(Object.values(pass).every(Boolean) && errors === 0 ? 0 : 1);
