/** The cash drawer (step 8.7) against the TCP printer simulator: off by default, audited. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAWER_PULSE } from '../../src/modules/printing/escpos.ts';
import { withDrawerPulse } from '../../src/modules/printing/jobs.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { PrinterSimulator } from '../support/escpos/simulator.ts';

let fx: IdentityFixture;
let owner: Client;
let sim: PrinterSimulator;
let printerId = '';

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, payload?: object) {
  const res = await owner.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {} };
}

async function version(): Promise<number> {
  const { rows } = await fx.pool.query<{ version: number }>(
    'SELECT version FROM cl.printers WHERE id = $1',
    [printerId],
  );
  return rows[0]?.version ?? 0;
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  sim = new PrinterSimulator();
  await sim.start();
  const created = await call('POST', '/printers', {
    name: 'Drawer printer',
    connection: 'tcp',
    address: `127.0.0.1:${String(sim.port)}`,
  });
  printerId = String(created.body['id']);
});
afterAll(async () => {
  await sim.stop();
  await fx.close();
});

describe('the pulse', () => {
  it('is exactly ESC p 0 25 250', () => {
    expect([...DRAWER_PULSE]).toEqual([0x1b, 0x70, 0, 25, 250]);
  });
});

describe('opening on a receipt', () => {
  const receipt = Buffer.from('receipt');
  const printer = { drawer_enabled: true, drawer_on_cash: true };
  const job = { document_type: 'receipt' as const, copy_no: 1 };

  it('adds the pulse to the first copy of a cash receipt', () => {
    expect(withDrawerPulse(receipt, job, printer, true)).toEqual(
      Buffer.concat([receipt, DRAWER_PULSE]),
    );
  });

  it('leaves the bytes untouched otherwise, above all with the drawer off', () => {
    const same = (
      j: typeof job | { document_type: 'test_page'; copy_no: 1 },
      p = printer,
      cash = true,
    ) => withDrawerPulse(receipt, j, p, cash).equals(receipt);
    expect(same(job, { drawer_enabled: false, drawer_on_cash: true })).toBe(true);
    expect(same(job, { drawer_enabled: true, drawer_on_cash: false })).toBe(true);
    expect(same(job, printer, false)).toBe(true);
    expect(same({ ...job, copy_no: 2 })).toBe(true);
    expect(same({ document_type: 'test_page', copy_no: 1 })).toBe(true);
  });
});

describe('opening by hand', () => {
  it('is off by default: refused, and the printer gets nothing', async () => {
    const before = sim.jobs.length;
    const res = await call('POST', `/printers/${printerId}/drawer/open`, {});
    expect(res.status).toBe(400);
    expect(sim.jobs.length).toBe(before);
    expect((await call('GET', '/drawer')).body['printerId']).toBeNull();
  });

  it('switched on: sends the pulse once, writes who did it, and appears for the till', async () => {
    const on = await call('PATCH', `/printers/${printerId}`, {
      expectedVersion: await version(),
      drawerEnabled: true,
    });
    expect(on.status).toBe(200);
    const { rows: tills } = await fx.pool.query<{ id: string }>(
      'SELECT id::text FROM cl.tills LIMIT 1',
    );
    await call('PUT', `/tills/${tills[0]?.id ?? ''}/printer`, { printerId });
    expect((await call('GET', '/drawer')).body['printerId']).toBe(printerId);

    const res = await call('POST', `/printers/${printerId}/drawer/open`, {});
    expect(res.status).toBe(204);
    await expect.poll(() => sim.jobs.some((j) => j.bytes.includes(DRAWER_PULSE))).toBe(true);
    const { rows } = await fx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cl.audit_events WHERE action = 'drawer.open' AND entity_id = $1`,
      [printerId],
    );
    expect(rows[0]?.n).toBe(1);
    const { rows: jobs } = await fx.pool.query(
      'SELECT 1 FROM cl.print_jobs WHERE printer_id = $1',
      [printerId],
    );
    expect(jobs).toHaveLength(0); // never queued, so it cannot open later by itself
  });
});
