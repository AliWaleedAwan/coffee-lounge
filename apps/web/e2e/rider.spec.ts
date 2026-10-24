/**
 * Phase 3 step 3.10 journey on the delivery board: the owner adds a rider, a cashier-style
 * delivery is entered with a phone number (masked on the board, AT-123), its items go to
 * the kitchen and are picked up, the rider is sent, and the card payment is recorded when
 * the rider is back (AT-54/AT-60 on screen). Card only, so the till shift of the specs
 * after this one starts clean.
 */
import { expect, test, type Page } from '@playwright/test';
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

test('a card-on-delivery order from phone call to delivered', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[13] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Delivery menu' });
  await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Beef nihari',
    variants: [{ name: 'Plate', price: '900' }],
  });

  await page.getByRole('link', { name: 'Deliveries' }).click();
  await expect(page.getByRole('heading', { name: 'Deliveries', level: 1 })).toBeVisible();
  await page.getByLabel('Rider name').fill('Asad');
  await page.getByRole('button', { name: 'Add rider' }).click();
  await expect(page.getByRole('region', { name: 'Riders' })).toContainText('Asad');

  // The order: by phone, card on delivery, with a phone number.
  await page.getByRole('button', { name: 'New delivery' }).click();
  await page.getByLabel('Payment').selectOption('card_on_delivery');
  await page.getByLabel('Customer name').fill('Sana');
  await page.getByLabel('Customer phone').fill('0321 7654321');
  await page.getByLabel('Address').fill('House 9, Street 3, Johar Town');
  await page.getByRole('button', { name: 'Create and add items' }).click();
  await expect(page.getByRole('heading', { name: /^Delivery · S-/ })).toBeVisible();
  await page.getByRole('tab', { name: 'Delivery menu' }).click();
  await page
    .getByRole('button', { name: /Beef nihari/ })
    .first()
    .click();
  await page.getByRole('button', { name: /^Add/ }).click();
  await page.getByRole('button', { name: 'Send to kitchen' }).click();
  await expect(page.getByText('1 × Beef nihari').first()).toBeVisible();

  // The board: phone masked; dispatch waits for the kitchen.
  await page.getByRole('link', { name: '← Deliveries' }).click();
  const card = page.getByRole('article', { name: /^Delivery S-/ }).filter({ hasText: 'Sana' });
  await expect(card).toContainText('•••• •••4321');
  await expect(card).not.toContainText('7654321');
  await expect(card).toContainText('1 item not picked up yet.');
  await expectAccessible(page, 'delivery board');

  const queue = (await (await page.request.get('/api/staff/v1/pickup')).json()) as {
    tickets: { id: string; where: string }[];
  };
  for (const t of queue.tickets) await staffPost(page, `/tickets/${t.id}/pickup`, {});
  await page.reload();
  await card.getByLabel('Rider').selectOption({ label: 'Asad' });
  await card.getByRole('button', { name: /^Dispatch/ }).click();
  const out = page.getByRole('region', { name: /Out for delivery/ });
  await expect(out).toContainText('Sana');
  await expect(out).toContainText('Rs 900 to collect');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/delivery-out.png`, fullPage: true });

  // Asad is back: the customer paid by card.
  await out.getByRole('button', { name: /Asad returned: delivered/ }).click();
  await out.getByLabel(/Approval code/).fill('RD8812');
  await out.getByRole('button', { name: 'Record delivered' }).click();
  const done = page.getByRole('region', { name: /Done today/ });
  await expect(done).toContainText('Sana');
  await expect(page.getByRole('region', { name: /Out for delivery/ })).toContainText('None.');
  await expectAccessible(page, 'delivery board, delivered');
});
