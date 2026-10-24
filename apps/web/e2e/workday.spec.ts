/**
 * Phase 3 step 3.12: the staff journeys of UI_UX.md §7 with their tap targets (UX-J2…J6),
 * the live operations screen, owner settings (AT-130) and a long live-update cut (AT-43).
 * Named to run last: it relies on what earlier specs left (a closed shift with a variance)
 * and changes the shop's brand colour.
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

/** Counts the taps or key presses a journey needs. */
function counter(page: Page) {
  let n = 0;
  return {
    get count() {
      return n;
    },
    async click(locator: ReturnType<Page['getByRole']>) {
      n += 1;
      await locator.click();
    },
    async press(key: string) {
      n += 1;
      await page.keyboard.press(key);
    },
  };
}

test('a working day: journeys J2–J6, live operations, settings, a long cut', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const s = shop();
  await page.clock.install();
  await registerDevice(page, s.codes[15] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Courtyard menu' });
  const item = (await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Courtyard cappuccino',
    variants: [{ name: 'Regular', price: '650' }],
  })) as { variantIds: string[] };
  const table = await staffPost(page, '/tables', { code: 'CY1', name: 'Courtyard' });
  const session = await staffPost(page, `/tables/${String(table['id'])}/sessions`, {});

  // J2: add 2 cappuccinos to the table and send, ≤ 5 taps from the table's screen.
  await page.goto(`/sessions/${String(session['id'])}`);
  const j2 = counter(page);
  await j2.click(page.getByRole('tab', { name: 'Courtyard menu' }));
  await j2.click(page.getByRole('button', { name: /Courtyard cappuccino/ }));
  await j2.click(page.getByRole('button', { name: 'One more' }));
  await j2.click(page.getByRole('button', { name: /^Add/ }));
  await j2.click(page.getByRole('button', { name: 'Send to kitchen' }));
  await expect(page.getByText('Accepted so far Rs 1300')).toBeVisible();
  expect(j2.count).toBeLessThanOrEqual(5);

  // J3: a guest's QR round is accepted in 1 tap; one someone else took first says so.
  const qr = (await staffPost(page, '/qr-entry-points/generate', {
    tableIds: [table['id']],
    counter: false,
  })) as { items: { url: string }[] };
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const guest = await phone.newPage();
  await guest.goto(qr.items[0]?.url ?? '');
  await expect(guest).toHaveURL(/\/order$/); // the table is open: the phone joins it
  const guestOrder = async () => {
    const res = await guest.request.post(`${new URL(guest.url()).origin}/api/customer/v1/rounds`, {
      data: { lines: [{ variantId: item.variantIds[0], qty: 1, modifierOptionIds: [] }] },
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { round: { id: string } }).round.id;
  };
  await guestOrder();
  const taken = await guestOrder();
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Courtyard · order 3' })).toBeVisible();
  await staffPost(page, `/rounds/${taken}/accept`, {}); // another device, a moment earlier
  const j3 = counter(page);
  await j3.click(page.getByRole('button', { name: 'Accept Courtyard order 2' }));
  await expect(page.getByRole('listitem').filter({ hasText: 'Courtyard · order 2' })).toHaveCount(
    0,
  );
  expect(j3.count).toBe(1);
  await page
    .getByRole('button', { name: 'Accept Courtyard order 3' })
    .click({ timeout: 2_000 })
    .catch(() => undefined);
  await expectAccessible(page, 'approvals');

  // J4: Picked up, 1 tap per ticket (sent when its Undo toast closes).
  await page.getByRole('link', { name: 'Pickup' }).click();
  const cards = page.getByRole('listitem').filter({ hasText: 'Courtyard' });
  const j4 = counter(page);
  const tickets = await cards.count();
  for (let i = 0; i < tickets; i++) {
    await j4.click(
      cards
        .first()
        .getByRole('button', { name: /^Picked up/ })
        .first(),
    );
    await page.clock.fastForward(6_000);
    await expect(page.getByText(/^Picked up .* for Courtyard/)).toBeHidden();
  }
  expect(j4.count).toBe(tickets);
  await expect(cards).toHaveCount(0);

  // J5: lock the bill and take cash with change in ≤ 4 actions.
  await staffPost(page, '/cash-shifts', { openingFloat: '3000' });
  await page.getByRole('link', { name: 'Bills & payments' }).click();
  const j5 = counter(page);
  await j5.click(page.getByRole('option', { name: /Courtyard/ }));
  await expect(page.getByRole('heading', { name: 'Courtyard · bill' })).toBeVisible();
  await j5.press('F2');
  await expect(page.getByText('Ready to pay')).toBeVisible();
  await j5.press('F4');
  await page.clock.runFor(50); // the focus moves on the next frame (the test clock holds frames)
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.type('3000');
  await j5.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /Paid · INV-/ })).toBeVisible();
  expect(j5.count).toBeLessThanOrEqual(4);

  // J6: counter-QR takeaway, Accept & pay in 2 actions.
  const counterQr = (await staffPost(page, '/qr-entry-points/generate', {
    tableIds: [],
    counter: true,
  })) as { items: { url: string }[] };
  const walkIn = await phone.newPage();
  await walkIn.goto(counterQr.items[0]?.url ?? '');
  await expect(walkIn.getByRole('button', { name: 'View menu' })).toBeVisible();
  const placed = await walkIn.request.post(
    `${new URL(walkIn.url()).origin}/api/customer/v1/rounds`,
    {
      data: { lines: [{ variantId: item.variantIds[0], qty: 1, modifierOptionIds: [] }] },
      headers: { 'idempotency-key': crypto.randomUUID() },
    },
  );
  expect(placed.ok()).toBe(true);
  const order = page.getByRole('form', { name: /^Takeaway / }).filter({ hasText: 'Total Rs 650' });
  await expect(order).toBeVisible();
  const j6 = counter(page);
  await j6.click(order.getByRole('button', { name: 'Card' }));
  await j6.click(order.getByRole('button', { name: 'Accept & pay · Rs 650' }));
  await expect(
    page.getByRole('status').filter({ hasText: /Accepted and paid · INV-/ }),
  ).toBeVisible();
  expect(j6.count).toBe(2);
  await phone.close();

  // Live operations: the figures and the inbox (the till spec left a variance to approve).
  await page.getByRole('link', { name: 'Live operations' }).click();
  await expect(page.getByRole('heading', { name: 'Live operations' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Right now' })).toContainText('Sales today');
  await expect(page.getByRole('region', { name: /Needs a manager/ })).toContainText(
    /Cash shift of Owner: variance Rs -10\.00/,
  );
  await expectAccessible(page, 'live operations');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/operations.png`, fullPage: true });

  // AT-43: live updates cut for ten minutes; writes pause; on reconnect the screen catches up.
  await page.getByRole('link', { name: 'Floor' }).click();
  await page.route('**/api/staff/v1/events', (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
  await staffPost(page, '/tables', { code: 'CY2', name: 'Courtyard corner' }); // made elsewhere meanwhile
  await page.clock.fastForward('10:00');
  await expect(page.getByRole('region', { name: 'Courtyard corner' })).toHaveCount(0);
  await page.unroute('**/api/staff/v1/events');
  await page.clock.fastForward(30_000);
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByRole('region', { name: 'Courtyard corner' })).toBeVisible();

  // AT-130: settings take effect; a brand colour failing contrast cannot be saved.
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Shop and branding' })).toBeVisible();
  const colour = page.getByLabel('Brand colour', { exact: true });
  await colour.fill('#F2C94C');
  await expect(page.getByText(/Too light: white button text on it reaches/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save branding' })).toBeDisabled();
  await colour.fill('#1F4E79');
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByText('Saved. Every screen and the next receipts use it.')).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByRole('button', { name: 'Save branding' })
        .evaluate((b) => getComputedStyle(b).backgroundColor),
    )
    .toBe('rgb(31, 78, 121)');
  const escalation = page.getByLabel('Waiting order goes to managers after (minutes)');
  await escalation.fill('4');
  await page
    .getByRole('button', { name: 'Save Waiting order goes to managers after (minutes)' })
    .click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' }).first()).toBeVisible();
  await expectAccessible(page, 'settings');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
});
