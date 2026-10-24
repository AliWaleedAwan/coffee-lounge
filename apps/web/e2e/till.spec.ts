/**
 * Phase 3 step 3.7 journey at the counter (the till), keyboard only (AT-87, UI_UX.md J5): `/` finds
 * the table, `Enter` opens its bill, `F2` prepares it, `F4` cash with change, settled.
 * A second table pays split: `F5` card for part, then cash; a discount sheet closes on
 * `Esc`. Then the cash shift (step 3.8): a paid-out, and a close that is Rs 10 short waits
 * for someone other than the cashier (AT-37). AT-86 for the new screens. Named to run after the specs that expect an empty shop.
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

async function seatedTable(page: Page, code: string, name: string, variantId: string, qty: number) {
  const table = await staffPost(page, '/tables', { code, name });
  const session = await staffPost(page, `/tables/${String(table['id'])}/sessions`, {});
  await staffPost(page, `/sessions/${String(session['id'])}/rounds`, {
    lines: [{ variantId, qty, modifierOptionIds: [] }],
  });
}

test('counter by keyboard: find, prepare, cash with change; then a split payment', async ({
  page,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[11] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const cat = await staffPost(page, '/menu/categories', { name: 'Counter menu' });
  const latte = (await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Counter latte',
    variants: [{ name: 'Regular', price: '650' }],
  })) as { variantIds: string[] };
  const variantId = latte.variantIds[0] ?? '';
  await seatedTable(page, 'TR1', 'Terrace', variantId, 2);
  await seatedTable(page, 'BL1', 'Balcony', variantId, 1);

  await page.getByRole('link', { name: 'Bills & payments' }).click();
  await expect(page.getByRole('heading', { name: 'Bills & payments' })).toBeVisible();
  await page.getByLabel('Opening float (Rs)').fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByText(/Cash shift open/)).toBeVisible();

  // J5: / → type → Enter → F2 → F4 → amount → Enter.
  await page.locator('body').press('/');
  await expect(page.getByRole('combobox', { name: /Find a table/ })).toBeFocused();
  await page.keyboard.type('terr');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Terrace · bill' })).toBeVisible();
  await expect(page.locator('.totals')).toContainText('Rs 1300');
  await expectAccessible(page, 'counter: open bill');
  await page.keyboard.press('F2');
  await expect(page.getByText('Ready to pay')).toBeVisible();
  await page.keyboard.press('F4');
  await expect(page.getByLabel('Cash received')).toBeFocused();
  await page.keyboard.type('2000');
  await expect(page.locator('.change-due')).toContainText('Rs 700');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/counter-cash.png`, fullPage: true });
  await page.keyboard.press('Enter');
  const paid = page.getByRole('status').filter({ hasText: /Paid · INV-\d{4}-\d{6}/ });
  await expect(paid).toBeVisible();
  await expect(paid).toContainText('change Rs 700');
  await expect(paid).toContainText('Terrace is now free');
  await expectAccessible(page, 'counter: settled');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/counter-settled.png`, fullPage: true });
  await expect(page.getByRole('option', { name: /Terrace/ })).toHaveCount(0);

  // Next customer: back to the search; arrow keys move through the matches.
  await page.getByRole('button', { name: 'Next customer' }).click();
  await expect(page.getByRole('combobox', { name: /Find a table/ })).toBeFocused();
  await page.keyboard.type('b');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('option', { name: /Balcony/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Balcony · bill' })).toBeVisible();

  // A discount sheet closes on Esc.
  await page.getByRole('button', { name: 'Discount…' }).click();
  await expect(page.getByRole('heading', { name: 'Discount' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Discount' })).toBeHidden();

  // Split: Rs 250 by card (F5), the rest in cash (F4, exact).
  await page.keyboard.press('F2');
  await expect(page.getByText('Ready to pay')).toBeVisible();
  await page.keyboard.press('F5');
  await expect(page.getByLabel(/Approval code/)).toBeFocused();
  await page.keyboard.type('A7781');
  await page.getByLabel('Amount for this payment').fill('250');
  await page.getByRole('button', { name: 'Take Rs 250 by card' }).click();
  await expect(page.locator('.totals')).toContainText('Rs 400');
  await page.keyboard.press('F4');
  await page.getByRole('button', { name: 'Exact' }).click();
  await page.getByRole('button', { name: 'Take Rs 400 by cash' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Paid · INV-/ })).toBeVisible();
  await expect(page.locator('.bill-lines + .totals ~ ul')).toContainText('ref A7781');

  // The cash shift: 5000 float + 1300 + 400 cash, then Rs 100 paid out.
  await page.getByRole('link', { name: 'Cash shift' }).click();
  await expect(page.getByRole('heading', { name: 'Cash shift', level: 1 })).toBeVisible();
  await expect(page.locator('.totals').first()).toContainText('Rs 6700');
  await page.getByLabel('Amount (Rs)').fill('100');
  await page.getByLabel('What for').fill('Milk top-up, receipt kept');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Paid out Rs 100 recorded.')).toBeVisible();
  await expect(page.locator('.totals').first()).toContainText('Rs 6600');
  await expectAccessible(page, 'cash shift');
  await page.getByLabel('Counted cash (Rs)').fill('6590');
  await expect(page.getByText('The till is Rs 10 short (expected Rs 6600).')).toBeVisible();
  await page.getByLabel('Why the difference').fill('Not found at the count');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shift-close.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByText(/Variance Rs -10 is waiting for a manager’s approval/)).toBeVisible();
  // The owner closed their own shift: someone else approves it.
  await expect(page.getByRole('row', { name: /Not found at the count/ })).toContainText(
    'Waiting for approval',
  );
  await expect(page.getByRole('heading', { name: 'Open a shift' })).toBeVisible();
  await expectAccessible(page, 'cash shift closed');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/shift-closed.png`, fullPage: true });
});
