/**
 * Receipt design (Settings → Receipt design): the owner's text blocks and switches print
 * on real receipts; the preview is the renderer's own lines; without a design the receipt
 * is the standard one (the golden files pin it); a stale screen is refused; only the
 * owner's settings permission may change it; going back to standard removes the design.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  composeReceipt,
  type ReceiptData,
  type ReceiptLayout,
} from '../../src/modules/printing/documents.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;

interface Design {
  version: number;
  saved: boolean;
  layout: Record<string, unknown> & { footer: { text: string }[] };
  width: number;
}
const url = '/api/staff/v1/settings/receipt-design';
const read = async (client = owner) => {
  const res = await client.call({ method: 'GET', url });
  return { status: res.statusCode, body: res.json<Design>() };
};

const layout: ReceiptLayout = {
  header: [
    { text: 'NTN 1234567-8\nOpen 10am - 2am', align: 'center', bold: false, size: 'normal' },
  ],
  footer: [
    { text: 'Free Wi-Fi: ask the cashier', align: 'left', bold: true, size: 'normal' },
    { text: 'THANK YOU', align: 'center', bold: true, size: 'big' },
  ],
  shopNameSize: 'big',
  showContact: false,
  showCashier: false,
};

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
});
afterAll(async () => {
  await fx.close();
});

describe('receipt design', () => {
  it('starts from the standard receipt', async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.saved).toBe(false);
    expect(body.width).toBe(48);
    expect(body.layout).toMatchObject({ header: [], shopNameSize: 'wide', showCashier: true });
    expect(body.layout.footer[0]?.text).toMatch(/Thank you/);
  });

  it('previews the lines the printer would print', async () => {
    const res = await owner.call({ method: 'POST', url: `${url}/preview`, payload: { layout } });
    expect(res.statusCode, res.body).toBe(200);
    const { lines } = res.json<{
      lines: { text: string; align: string; bold: boolean; wide: boolean; tall: boolean }[];
    }>();
    expect(lines[0]).toMatchObject({
      text: 'COFFEE LOUNGE',
      align: 'center',
      wide: true,
      tall: true,
    });
    expect(lines.map((l) => l.text)).toContain('NTN 1234567-8');
    expect(lines.some((l) => l.text.includes('Cashier:'))).toBe(false);
    expect(lines.at(-1)).toMatchObject({
      text: 'THANK YOU',
      align: 'center',
      bold: true,
      wide: true,
    });
    expect(lines.find((l) => l.text === 'Free Wi-Fi: ask the cashier')).toMatchObject({
      align: 'left',
      bold: true,
    });
  });

  it('wraps a double-width block to half the line', () => {
    const r = {
      shop: { name: 'X', addressLine: null, phone: null },
      invoiceNo: 'INV-1',
      where: 'T1',
      at: new Date(0),
      cashier: 'A',
      lines: [],
      subtotal: '0.00',
      discounts: [],
      rounding: '0.00',
      total: '0.00',
      payments: [],
      change: null,
      delivery: null,
      footer: '',
      layout: {
        ...layout,
        footer: [{ text: 'a '.repeat(30).trim(), align: 'left', bold: false, size: 'wide' }],
      },
    } satisfies ReceiptData;
    const lines = composeReceipt(r, {
      width: 48,
      canCut: true,
      copyNo: 1,
      timeZone: 'Asia/Karachi',
    }).preview();
    const wide = lines.filter((l) => l.wide && l.text.startsWith('a'));
    expect(wide.length).toBeGreaterThan(1);
    expect(wide.every((l) => l.text.length <= 24)).toBe(true);
  });

  it('saves for the owner only, refuses a stale screen, and goes back to standard', async () => {
    const before = await read();
    await fx.addUser('rd-mgr', ['manager']);
    const manager = await fx.loggedIn('rd-mgr');
    const denied = await manager.call({
      method: 'PUT',
      url,
      payload: { expectedVersion: before.body.version, layout },
    });
    expect(denied.statusCode).toBe(403);

    const saved = await owner.call({
      method: 'PUT',
      url,
      payload: { expectedVersion: before.body.version, layout },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<Design>()).toMatchObject({ saved: true, layout: { shopNameSize: 'big' } });

    const stale = await owner.call({
      method: 'PUT',
      url,
      payload: { expectedVersion: before.body.version, layout },
    });
    expect(stale.statusCode).toBe(409);

    // The branding form keeps the design (the same template row, so the same version).
    const version = (await read()).body.version;
    const branding = (await owner.call({ method: 'GET', url: '/api/staff/v1/branding' })).json<
      Record<string, unknown>
    >();
    const kept = await owner.call({
      method: 'PUT',
      url: '/api/staff/v1/settings/branding',
      payload: {
        expectedVersion: version,
        shopName: 'Coffee Lounge',
        addressLine: null,
        phone: null,
        footer: 'x',
        primary: branding['primary'],
      },
    });
    expect(kept.statusCode, kept.body).toBe(200);
    const now = await read();
    expect(now.body.saved).toBe(true);

    const standard = await owner.call({
      method: 'PUT',
      url,
      payload: { expectedVersion: now.body.version, layout: null },
    });
    expect(standard.json<Design>()).toMatchObject({ saved: false });
    const { rows } = await fx.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM cl.audit_events WHERE action = 'settings.receipt_design'",
    );
    expect(rows[0]?.n).toBe(2);
  });
});
