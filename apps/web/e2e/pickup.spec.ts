/**
 * Phase 3 step 3.5 journey: a staff round reaches Pickup; Undo sends nothing; a real
 * pickup leaves the queue after 5 seconds; a waiting item is cancelled from the table
 * screen with "not made yet". AT-92 end to end, AT-86 for the new screens.
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

test('pickup with Undo, then cancel a waiting item', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[9] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Garden menu' });
  const tea = (await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Garden tea',
    variants: [{ name: 'Pot', price: '300' }],
  })) as {
    variantIds: string[];
  };
  const scone = (await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Scone',
    variants: [{ name: 'Piece', price: '250' }],
  })) as {
    variantIds: string[];
  };
  const table = await staffPost(page, '/tables', { code: 'G1', name: 'Garden' });
  const session = await staffPost(page, `/tables/${String(table['id'])}/sessions`, {});
  await staffPost(page, `/sessions/${String(session['id'])}/rounds`, {
    lines: [
      { variantId: tea.variantIds[0], qty: 1, modifierOptionIds: [] },
      { variantId: scone.variantIds[0], qty: 2, modifierOptionIds: [] },
    ],
  });

  await page.getByRole('link', { name: 'Pickup' }).click();
  const card = page.getByRole('listitem').filter({ hasText: 'Garden' }).first();
  await expect(card).toContainText('1 × Garden tea');
  await expectAccessible(page, 'pickup');

  // Undo: nothing is sent, the tea stays waiting.
  await card.getByRole('button', { name: 'Picked up Garden tea for Garden' }).click();
  await expect(page.getByText('Picked up 1 × Garden tea for Garden')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pickup-undo.png`, fullPage: true });
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(5_500);
  await expect(card).toContainText('1 × Garden tea');

  // A real pickup: sent when the toast closes, and the tea leaves the queue.
  await card.getByRole('button', { name: 'Picked up Garden tea for Garden' }).click();
  await expect(page.getByText('Picked up 1 × Garden tea for Garden')).toBeHidden({
    timeout: 8_000,
  });
  await expect(card).not.toContainText('Garden tea');
  await expect(card).toContainText('2 × Scone');

  // Cancel one scone from the table screen: not made yet.
  await page.getByRole('link', { name: 'Floor' }).click();
  await page
    .getByRole('region', { name: 'Garden' })
    .getByRole('link', { name: /Orders/ })
    .click();
  const sconeLine = page.locator('li.cart-line').filter({ hasText: '2 × Scone' });
  await expect(sconeLine).toContainText('Being prepared');
  await sconeLine.getByRole('button', { name: 'Cancel… Scone' }).click();
  await page.getByLabel('How many').selectOption('1');
  await page.getByLabel('No, not made yet').check();
  await page.getByLabel('Reason').fill('Guest changed their mind');
  await expectAccessible(page, 'cancel items');
  await page.getByRole('button', { name: 'Cancel items' }).click();
  await expect(sconeLine).toContainText('Being prepared · 1 cancelled');
  await expect(page.locator('li.cart-line').filter({ hasText: '1 × Garden tea' })).toContainText(
    'Served',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/session-lines.png`, fullPage: true });
});
