/**
 * UX-J1 (UI_UX.md §7): a guest scans the table's code, chooses a cappuccino with a size
 * and oat milk, sends it and follows it to the table, in at most 8 taps, then asks for the
 * bill. The guest's screen moves on by itself as staff act (live updates, step 3.11).
 * Named to run last: it adds a menu and a table.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

async function staffPost(page: Page, path: string, data: object): Promise<Record<string, unknown>> {
  const res = await page.request.post(`/api/staff/v1${path}`, {
    data,
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test('J1: scan, cappuccino large with oat milk, send, follow, ask for the bill', async ({
  page,
  browser,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[14] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Rooftop menu' });
  const milk = await staffPost(page, '/modifier-groups', {
    name: 'Milk',
    minSelect: 1,
    maxSelect: 1,
    options: [{ name: 'Whole milk' }, { name: 'Oat milk', priceDelta: '150' }],
  });
  await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Cardamom cappuccino',
    modifierGroupIds: [milk['id']],
    variants: [
      { name: 'Regular', price: '650' },
      { name: 'Large', price: '780' },
    ],
  });
  const table = await staffPost(page, '/tables', { code: 'RT1', name: 'Rooftop' });
  const qr = (await staffPost(page, '/qr-entry-points/generate', {
    tableIds: [table['id']],
    counter: false,
  })) as { items: { url: string }[] };

  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const guest = await phone.newPage();
  let taps = 0;
  const tap = async (name: string | RegExp, role: 'button' | 'tab' | 'radio' = 'button') => {
    taps += 1;
    const target =
      role === 'radio' ? guest.getByLabel(name) : guest.getByRole(role, { name }).first();
    await target.click();
  };

  const started = Date.now();
  await guest.goto(qr.items[0]?.url ?? ''); // the camera opens the link
  await expectAccessible(guest, 'guest landing');
  await tap('View menu');
  // Many categories: the tab row scrolls, the page never scrolls sideways on a phone.
  expect(
    await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await tap('Rooftop menu', 'tab');
  await tap(/Cardamom cappuccino/);
  await tap(/^Large/, 'radio');
  await tap(/^Oat milk/, 'radio');
  await tap(/^Add/);
  await expectAccessible(guest, 'guest menu with the order bar');
  if (SHOTS) await guest.screenshot({ path: `${SHOTS}/guest-menu.png` });
  await tap(/View order · 1 item/);
  await expect(guest.getByRole('region', { name: 'Your order' })).toContainText('Total Rs 930');
  await tap('Send order');
  await expect(guest.getByRole('heading', { name: 'Waiting for staff to confirm' })).toBeVisible();
  expect(taps).toBeLessThanOrEqual(8);
  expect(Date.now() - started).toBeLessThan(60_000);
  await expectAccessible(guest, 'guest status');

  // Staff accept and the kitchen hands it over: the guest's screen follows by itself.
  const approvals = (await (await page.request.get('/api/staff/v1/approvals')).json()) as {
    items: { id: string; session: { tableName: string | null } }[];
  };
  const round = approvals.items.find((r) => r.session.tableName === 'Rooftop');
  await staffPost(page, `/rounds/${round?.id ?? ''}/accept`, {});
  await expect(guest.getByRole('heading', { name: 'Being prepared' })).toBeVisible();
  const pickup = (await (await page.request.get('/api/staff/v1/pickup')).json()) as {
    tickets: { id: string; where: string }[];
  };
  for (const t of pickup.tickets.filter((x) => x.where.includes('Rooftop'))) {
    await staffPost(page, `/tickets/${t.id}/pickup`, {});
  }
  await expect(guest.getByRole('heading', { name: 'Served. Enjoy!' })).toBeVisible();
  if (SHOTS) await guest.screenshot({ path: `${SHOTS}/guest-status.png`, fullPage: true });

  // The bill: one tap, and the counter sees the request.
  await guest.getByRole('button', { name: 'Request bill' }).click();
  await expect(guest.getByText('Bill requested. A staff member is on the way.')).toBeVisible();
  await page.getByRole('link', { name: 'Bills & payments' }).click();
  await expect(page.getByRole('option', { name: /Rooftop/ })).toContainText('Asked for the bill');
  await phone.close();
});
