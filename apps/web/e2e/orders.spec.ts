/**
 * Phase 3 step 3.4 journey across both apps: a guest phone orders from the table's QR
 * link (customer listener, guest app), staff accept it in Approvals, the guest sees it
 * accepted, and a waiter adds a round from the table screen. AT-86 for the new screens.
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

test('a guest orders by QR, staff accept it, and a waiter adds a round', async ({
  page,
  browser,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[8] ?? '');
  await logIn(page, s.owner.username, s.owner.password);

  // Menu and a table, through the staff API.
  const cat = await staffPost(page, '/menu/categories', { name: 'Patio menu' });
  await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'House latte',
    dietaryTags: ['Contains milk'],
    variants: [{ name: 'Regular', price: '450' }],
  });
  await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Mineral water',
    variants: [{ name: '500 ml', price: '100' }],
  });
  const table = await staffPost(page, '/tables', { code: 'P1', name: 'Patio' });
  const codes = (await staffPost(page, '/qr-entry-points/generate', {
    tableIds: [table['id']],
    counter: false,
  })) as {
    items: { url: string }[];
  };
  const link = codes.items[0]?.url ?? '';

  // The guest scans the card with their phone.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const guest = await phone.newPage();
  await guest.goto(link);
  await expect(guest).toHaveURL(/\/order$/);
  await guest.getByRole('tab', { name: 'Patio menu' }).click();
  await expect(guest.getByRole('button', { name: /House latte/ })).toBeVisible();
  await expectAccessible(guest, 'guest menu');
  await guest.getByRole('button', { name: /House latte/ }).click();
  await guest.getByLabel('Note for the kitchen (optional)').fill('Extra hot');
  await guest.getByRole('button', { name: /^Add/ }).click();
  await expect(guest.getByRole('region', { name: 'Order' })).toContainText('Total Rs 450');
  await guest.getByRole('button', { name: 'Send order' }).click();
  await expect(guest.getByRole('tab', { name: /My orders \(1 waiting\)/ })).toBeVisible();
  await expect(guest.getByText('Waiting for staff')).toBeVisible();
  await expectAccessible(guest, 'guest orders');

  // Staff accept it.
  await page.getByRole('link', { name: 'Approvals' }).click();
  const card = page.getByRole('listitem').filter({ hasText: 'Patio · order 1' });
  await expect(card).toContainText('1 × House latte · Regular');
  await expect(card).toContainText('Extra hot');
  await expectAccessible(page, 'approvals');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/approvals.png`, fullPage: true });
  await card.getByRole('button', { name: 'Accept Patio order 1' }).click();
  await expect(page.getByText('No orders are waiting.')).toBeVisible();

  await guest.reload();
  await guest.getByRole('tab', { name: /My orders/ }).click();
  await expect(guest.getByText('Accepted')).toBeVisible();
  if (SHOTS) await guest.screenshot({ path: `${SHOTS}/guest-orders.png`, fullPage: true });

  // A waiter adds water from the table screen; staff rounds go straight through.
  await page.getByRole('link', { name: 'Floor' }).click();
  await page
    .getByRole('region', { name: 'Patio' })
    .getByRole('link', { name: /Orders/ })
    .click();
  await expect(page.getByRole('heading', { name: /Patio · S-/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Patio menu' }).click();
  await page.getByRole('button', { name: /Mineral water/ }).click();
  await page.getByRole('button', { name: /^Add/ }).click();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.getByText('Accepted so far Rs 550')).toBeVisible();
  await expectAccessible(page, 'table session');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/session.png`, fullPage: true });
  await phone.close();
});
