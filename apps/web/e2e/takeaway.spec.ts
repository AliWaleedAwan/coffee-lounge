/**
 * Phase 3 step 3.9 journey: two guests order from the counter QR on their own phones and
 * each sees only their own order (AT-75); the cashier takes one guest's money and presses
 * Accept & pay (AT-51), and rejects the other. Card only, so the till shift of the next
 * spec starts clean.
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

test('two guests at the counter QR; Accept & pay one, reject the other', async ({
  page,
  browser,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[12] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Counter QR menu' });
  await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Rose tea',
    variants: [{ name: 'Cup', price: '300' }],
  });
  const qr = (await staffPost(page, '/qr-entry-points/generate', {
    tableIds: [],
    counter: true,
  })) as { items: { url: string }[] };
  const link = qr.items[0]?.url ?? '';

  // Two phones scan the same counter code and order.
  const order = async (qty: number) => {
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    const guest = await phone.newPage();
    await guest.goto(link);
    await guest.getByRole('tab', { name: 'Counter QR menu' }).click();
    for (let i = 0; i < qty; i++) {
      await guest
        .getByRole('button', { name: /Rose tea/ })
        .first()
        .click();
      await guest.getByRole('button', { name: /^Add/ }).click();
    }
    await guest.getByRole('button', { name: 'Send order' }).click();
    await expect(guest.getByRole('tab', { name: /My orders \(1 waiting\)/ })).toBeVisible();
    return guest;
  };
  const first = await order(1);
  const second = await order(2);
  await expect(first.getByText('Pay at the counter')).toBeVisible();
  // Each phone sees its own order only: one line on the first, two on the second.
  const lines = (guest: Page) =>
    guest.getByRole('region', { name: 'My orders' }).getByText('1 × Rose tea · Cup');
  await expect(lines(first)).toHaveCount(1);
  await expect(lines(second)).toHaveCount(2);
  await expectAccessible(first, 'guest counter order');

  // The cashier: the queue, then Accept & pay by card for the first guest.
  await page.getByRole('link', { name: 'Bills & payments' }).click();
  await expect(
    page.getByRole('heading', { name: /Takeaway · waiting to pay \(2\)/ }),
  ).toBeVisible();
  const one = page.getByRole('form', { name: /^Takeaway / }).filter({ hasText: 'Total Rs 300' });
  const two = page.getByRole('form', { name: /^Takeaway / }).filter({ hasText: 'Total Rs 600' });
  await expect(one).toContainText(/Unpaid · cancels in (29|30):\d\d/);
  await expectAccessible(page, 'counter: takeaway queue');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/takeaway-queue.png`, fullPage: true });
  await one.getByRole('button', { name: 'Card' }).click();
  await one.getByLabel(/Approval code/).fill('TQ551');
  await one.getByRole('button', { name: 'Accept & pay · Rs 300' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: /Accepted and paid · INV-\d{4}-\d{6}/ }),
  ).toBeVisible();
  await expect(one).toHaveCount(0);

  // The second guest's order is rejected with a reason.
  await two.getByRole('button', { name: 'Reject…' }).click();
  await two.getByRole('button', { name: 'Reject order' }).click();
  await expect(two).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: /Takeaway · waiting to pay \(0\)/ }),
  ).toBeVisible();

  // The first guest's visit is paid and over; the second sees the reason.
  await first.reload();
  await expect(
    first.getByRole('heading', { name: 'Scan the QR code on your table' }),
  ).toBeVisible();
  await second.reload();
  await second.getByRole('tab', { name: /My orders/ }).click();
  await expect(second.getByText('Item just ran out')).toBeVisible();
});
