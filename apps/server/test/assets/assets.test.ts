/**
 * The asset register (Phase 5 step 5.4): the whole life of an asset is in its history
 * (AT-106); a correction keeps the original traceable (AT-23, asset part); disposal is a
 * status, never a delete; maintenance can point at the expense that paid for it; the
 * 09_assets.csv template imports all or nothing and a re-import changes nothing (AT-82).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDateOf, shopDateOf } from '../../src/platform/settings.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let clerk: Client;
let manager: Client;
let waiter: Client;
let today = '';

type Body = Record<string, unknown>;
async function call(client: Client, method: 'GET' | 'POST', path: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${path}`,
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Body>() : {} };
}
const read = async (id: string) => (await call(owner, 'GET', `/assets/${id}`)).body;
const types = async (id: string) =>
  ((await read(id))['history'] as { type: string }[]).map((h) => h.type);
const version = async (id: string) => Number(((await read(id))['asset'] as Body)['version']);
const change = async (id: string, changes: Body, reason?: string, v?: number) =>
  call(owner, 'POST', `/assets/${id}/changes`, {
    version: v ?? (await version(id)),
    changes,
    ...(reason ? { reason } : {}),
  });
const template = () =>
  readFileSync(new URL('../../../../docs/templates/09_assets.csv', import.meta.url), 'utf8');

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('as-clerk', ['inventory_clerk']);
  await fx.addUser('as-mgr', ['manager']);
  await fx.addUser('as-waiter', ['waiter']);
  await fx.addUser('bilal', ['cashier']);
  clerk = await fx.loggedIn('as-clerk');
  manager = await fx.loggedIn('as-mgr');
  waiter = await fx.loggedIn('as-waiter');
  today = await businessDateOf(fx.pool, new Date());
});
afterAll(async () => {
  await fx.close();
});

describe('an asset from purchase to disposal (AT-106)', () => {
  it('records acquired → moved → maintenance → disposed, and nothing changes after', async () => {
    const created = await call(owner, 'POST', '/assets', {
      name: 'Espresso grinder',
      category: 'Coffee equipment',
      purchaseDate: '2025-06-01',
      purchasePrice: '95000',
      location: 'Bar',
      condition: 'new',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body['assetTag']).toBe('AST-0001');
    const id = String(created.body['id']);

    expect((await change(id, { location: 'Back bar' })).body).toMatchObject({ events: ['moved'] });

    const expense = await call(owner, 'POST', '/expenses', {
      categoryId: (
        (await call(owner, 'GET', '/expense-categories')).body['items'] as {
          id: string;
          name: string;
        }[]
      ).find((c) => c.name === 'Repairs & maintenance')?.id,
      amount: '4500',
      paidVia: 'cash',
      payee: 'Grinder service',
    });
    const service = await call(owner, 'POST', `/assets/${id}/maintenance`, {
      performedOn: today,
      vendor: 'Grinder service',
      cost: '4500',
      description: 'Burrs replaced',
      expenseNo: String(expense.body['expenseNo']).toLowerCase(),
    });
    expect(service.status, JSON.stringify(service.body)).toBe(201);

    const disposed = await call(owner, 'POST', `/assets/${id}/dispose`, {
      how: 'scrapped',
      reason: 'Motor burnt out',
    });
    expect(disposed.status).toBe(200);
    expect(await types(id)).toEqual(['acquired', 'moved', 'maintenance', 'disposed']);
    const detail = await read(id);
    expect(detail['asset']).toMatchObject({
      status: 'disposed',
      location: 'Back bar',
      lastMaintenance: today,
    });
    expect(detail['maintenance']).toEqual([
      expect.objectContaining({
        description: 'Burrs replaced',
        cost: '4500.00',
        expenseNo: expense.body['expenseNo'],
      }),
    ]);
    const history = detail['history'] as {
      type: string;
      data: Body;
      reason: string | null;
      by: string;
    }[];
    expect(history[1]).toMatchObject({ data: { from: 'Bar', to: 'Back bar' }, by: 'Owner' });
    expect(history[3]).toMatchObject({
      data: { how: 'scrapped', from: 'in_use' },
      reason: 'Motor burnt out',
    });

    expect((await change(id, { location: 'Store' })).status).toBe(409);
    expect(
      (await call(owner, 'POST', `/assets/${id}/dispose`, { how: 'sold', reason: 'Again' })).status,
    ).toBe(409);
    await expect(fx.pool.query('DELETE FROM cl.assets WHERE id = $1', [id])).rejects.toThrow();
    await expect(fx.pool.query('UPDATE cl.asset_events SET reason = NULL')).rejects.toThrow();
    await expect(fx.pool.query('DELETE FROM cl.asset_maintenance')).rejects.toThrow();
  });
});

describe('corrections keep the original (AT-23, asset part)', () => {
  it('a value correction needs a reason; details keep before and after; a stale edit is refused', async () => {
    const created = await call(owner, 'POST', '/assets', {
      assetTag: 'frg-01',
      name: 'Fridge',
      category: 'Refrigeration',
      purchasePrice: '140000',
    });
    const id = String(created.body['id']);
    expect((await change(id, { purchasePrice: '145000' })).status).toBe(400);
    const v = await version(id);
    const fixed = await change(
      id,
      { purchasePrice: '145000', name: 'Under-counter fridge', status: 'in_repair' },
      'Invoice says 145,000',
      v,
    );
    expect(fixed.body).toMatchObject({
      events: ['value_corrected', 'status_changed', 'details_changed'],
    });
    expect((await change(id, { condition: 'fair' }, undefined, v)).status).toBe(409);
    const history = (await read(id))['history'] as {
      type: string;
      data: Body;
      reason: string | null;
    }[];
    expect(history.map((h) => h.type)).toEqual([
      'acquired',
      'value_corrected',
      'status_changed',
      'details_changed',
    ]);
    expect(history[0]?.data).toMatchObject({ name: 'Fridge', purchasePrice: '140000.00' });
    expect(history[1]).toMatchObject({
      data: { from: '140000.00', to: '145000.00' },
      reason: 'Invoice says 145,000',
    });
    expect(history[3]?.data).toEqual({
      before: { name: 'Fridge' },
      after: { name: 'Under-counter fridge' },
    });
    // Nothing different, nothing recorded.
    expect((await change(id, { name: 'Under-counter fridge' })).body).toMatchObject({ events: [] });
    const { rows } = await fx.pool.query<{ action: string }>(
      `SELECT action FROM cl.audit_events WHERE entity_type = 'asset' AND entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual(['asset.register', 'asset.change']);
  });

  it('tags are unique whatever the case; AST numbers skip a tag someone typed', async () => {
    expect(
      (await call(owner, 'POST', '/assets', { assetTag: 'FRG-01', name: 'Other', category: 'X' }))
        .status,
    ).toBe(400);
    await call(owner, 'POST', '/assets', {
      assetTag: 'AST-0002',
      name: 'Typed',
      category: 'Furniture',
    });
    const next = await call(owner, 'POST', '/assets', {
      name: 'Chair',
      category: 'Furniture',
      quantity: 12,
    });
    expect(next.body['assetTag']).toBe('AST-0003');
  });

  it('maintenance is recorded once done, and an expense pays for one maintenance only', async () => {
    const a = await call(owner, 'POST', '/assets', {
      name: 'Ice machine',
      category: 'Refrigeration',
    });
    const id = String(a.body['id']);
    // Tomorrow on the shop's calendar (after midnight, before 04:00, the business date lags it).
    const tomorrow = new Date(`${await shopDateOf(fx.pool, new Date())}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const later = tomorrow.toISOString().slice(0, 10);
    expect(
      (
        await call(owner, 'POST', `/assets/${id}/maintenance`, {
          performedOn: later,
          description: 'Cleaned',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, 'POST', `/assets/${id}/maintenance`, {
          performedOn: today,
          description: 'Cleaned',
          nextDue: today,
        })
      ).status,
    ).toBe(400);
    const { rows } = await fx.pool.query<{ expense_no: string }>(
      `SELECT expense_no FROM cl.expenses WHERE id IN (SELECT expense_id FROM cl.asset_maintenance)`,
    );
    const used = rows[0]?.expense_no ?? '';
    expect(
      (
        await call(owner, 'POST', `/assets/${id}/maintenance`, {
          performedOn: today,
          description: 'Cleaned',
          expenseNo: used,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(owner, 'POST', `/assets/${id}/maintenance`, {
          performedOn: today,
          description: 'Cleaned',
          expenseNo: 'EXP-1999-99999',
        })
      ).status,
    ).toBe(400);
    const ok = await call(owner, 'POST', `/assets/${id}/maintenance`, {
      performedOn: today,
      description: 'Descaled',
      nextDue: later,
    });
    expect(ok.status).toBe(201);
    expect((await read(id))['asset']).toMatchObject({ nextDue: later });
  });
});

describe('09_assets.csv (AT-82, P5-7)', () => {
  it('refuses the examples, imports all or nothing, and a re-import changes nothing', async () => {
    const examples = await call(owner, 'POST', '/imports/assets/preview', { csv: template() });
    expect(examples.body['errors']).toEqual(
      expect.arrayContaining([expect.objectContaining({ row: 2, column: 'asset_tag' })]),
    );
    const csv = template().replaceAll('EX-', 'IM-');
    const bad = await call(owner, 'POST', '/imports/assets/apply', {
      csv: `${csv}IM-X,Broken,Things,1,,,Nobody Ltd,,shiny,nobody,\n`,
    });
    expect(bad.status).toBe(400);
    const errors = (bad.body['errors'] as { column: string }[]).map((e) => e.column);
    expect(errors).toEqual(expect.arrayContaining(['supplier', 'condition', 'responsible']));
    expect((await call(owner, 'GET', '/assets?q=IM-')).body['items']).toEqual([]);

    const ok = await call(owner, 'POST', '/imports/assets/apply', { csv });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body['summary']).toEqual({ create: 2, update: 0, unchanged: 0 });
    const again = await call(owner, 'POST', '/imports/assets/apply', { csv });
    expect(again.body['summary']).toEqual({ create: 0, update: 0, unchanged: 2 });

    // Moved and handed to someone: one update, its events in the history.
    const moved = csv.replace('Bar,good,,', 'Back bar,good,bilal,');
    expect(
      (await call(owner, 'POST', '/imports/assets/apply', { csv: moved })).body['summary'],
    ).toEqual({
      create: 0,
      update: 1,
      unchanged: 1,
    });
    const list = (await call(owner, 'GET', '/assets?q=IM-ESP')).body['items'] as { id: string }[];
    expect(await types(list[0]?.id ?? '')).toEqual(['acquired', 'moved', 'details_changed']);

    // A disposed asset is refused by a re-import.
    await call(owner, 'POST', `/assets/${list[0]?.id ?? ''}/dispose`, {
      how: 'sold',
      reason: 'Upgraded',
    });
    const refused = await call(owner, 'POST', '/imports/assets/preview', { csv: moved });
    expect(refused.body['errors']).toEqual([expect.objectContaining({ column: 'asset_tag' })]);
    // The clerk may import stock files, not assets (assets.manage).
    expect((await call(clerk, 'POST', '/imports/assets/apply', { csv })).status).toBe(403);
  });
});

describe('who may (RBAC.md: assets.read / assets.manage)', () => {
  it('only the owner by default', async () => {
    for (const client of [waiter, clerk, manager]) {
      expect((await call(client, 'GET', '/assets')).status).toBe(403);
      expect((await call(client, 'POST', '/assets', { name: 'X', category: 'Y' })).status).toBe(
        403,
      );
    }
  });
});
