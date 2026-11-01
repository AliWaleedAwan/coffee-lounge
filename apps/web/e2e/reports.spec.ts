/**
 * Phase 6 step 6.2 on screen: the owner sells a coffee, opens Reports (J8: the top items by
 * margin are on the overview, one click from the menu), opens the Net sales tile to its report,
 * and drills from the day to its items. Accessibility on the overview and a report (AT-86).
 * Step 6.5: a report downloaded as CSV, and the day-end. Step 6.6: a scheduled e-mail.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

async function staffPost(page: Page, path: string, data: object): Promise<Record<string, unknown>> {
  const res = await page.request.post(`/api/staff/v1${path}`, {
    data,
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return res.status() === 204 ? {} : ((await res.json()) as Record<string, unknown>);
}

test('the owner overview, a tile to its report, and a day down to its items', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[29] ?? '');
  await logIn(page, s.owner.username, s.owner.password);

  const cat = await staffPost(page, '/menu/categories', { name: 'Report menu' });
  const item = await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Report flat white',
    variants: [{ name: 'Regular', price: '450' }],
  });
  const table = await staffPost(page, '/tables', { code: 'RP1', name: 'Report table' });
  const session = await staffPost(page, `/tables/${String(table['id'])}/sessions`, {});
  await staffPost(page, `/sessions/${String(session['id'])}/rounds`, {
    lines: [{ variantId: (item['variantIds'] as string[])[0], qty: 2, modifierOptionIds: [] }],
  });
  const bill = (await (
    await page.request.get(`/api/staff/v1/sessions/${String(session['id'])}/bill`)
  ).json()) as {
    invoice: { id: string };
  };
  const locked = await staffPost(page, `/invoices/${bill.invoice.id}/lock`, {});
  await staffPost(page, `/invoices/${bill.invoice.id}/payments`, {
    lockVersion: locked['lockVersion'],
    method: 'card_manual',
    amount: '900',
  });

  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Headline figures' });
  await expect(tiles.getByRole('button', { name: /Net sales/ })).toBeVisible();
  await expect(tiles.getByRole('button', { name: /Orders/ })).toBeVisible();
  // J8: the owner reaches the top items by margin in one click from the menu.
  await expect(page.getByRole('heading', { name: 'Top items by margin' })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Top items by sales' })
      .getByRole('row', { name: /Report flat white/ }),
  ).toContainText('Rs 900.00');
  await expectAccessible(page, 'reports overview');

  await tiles.getByRole('button', { name: /Net sales/ }).click();
  await expect(page.getByLabel('Report', { exact: true })).toHaveValue(/./);
  await expect(page.getByLabel('Report', { exact: true }).locator('option:checked')).toHaveText(
    'Sales by day',
  );
  const days = page.getByRole('table', { name: 'Sales by day' });
  await expect(days.getByRole('row').last()).toContainText('Total');
  await expectAccessible(page, 'sales by day');

  await page.getByLabel('Period').selectOption({ label: 'Today' });
  await days.getByRole('row').nth(1).getByRole('button').click();
  // A day opens its bills; a bill opens its lines.
  await expect(page.getByLabel('Report', { exact: true })).toHaveValue(/./);
  await expect(page.getByLabel('Report', { exact: true }).locator('option:checked')).toHaveText(
    'Bills',
  );
  const bills = page.getByRole('table', { name: 'Bills' });
  const billRow = bills.getByRole('row', { name: /Report table/ });
  await expect(billRow).toContainText('Rs 900.00');
  await billRow.getByRole('button').click();
  await expect(page.getByRole('button', { name: 'Back to the bills' })).toBeVisible();
  const lines = page.getByRole('table', { name: 'Bill lines' });
  await expect(lines.getByRole('row', { name: /Report flat white/ })).toContainText('Rs 900.00');
  await expectAccessible(page, 'bill lines');
  await page.getByRole('button', { name: 'Back to the bills' }).click();
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Sales by item' });
  await page.getByLabel('Period').selectOption({ label: 'Today' });
  const items = page.getByRole('table', { name: 'Sales by item' });
  await expect(items.getByRole('row', { name: /Report flat white/ })).toContainText('Rs 900.00');
  await page.getByText('How these figures are worked out').click();
  await expect(page.locator('li', { hasText: 'Σ line gross' }).first()).toBeVisible();

  // Step 6.5: the report on screen downloads as CSV, the same figures (AT-103).
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^sales-by-item_\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync(await csv.path(), 'utf8');
  expect(text.startsWith('\uFEFFItem,')).toBe(true);
  expect(text).toContain('Report flat white');
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();

  // The day-end of yesterday: figures, its PDF and the printed slip.
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Day-end' });
  await expect(page.getByRole('heading', { name: /^Day-end · Business date/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Sales' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expectAccessible(page, 'day-end');

  // Step 6.6: a scheduled e-mail, and the mailbox it goes out from.
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'E-mails' });
  await page.getByLabel('To (one or more addresses)').fill('owner@example.test');
  await page.getByRole('button', { name: 'Schedule it' }).click();
  await expect(
    page
      .getByRole('table', { name: 'Scheduled e-mails' })
      .getByRole('row', { name: /Day-end report/ }),
  ).toContainText('Daily at 08:00');
  await expectAccessible(page, 'scheduled e-mails');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'E-mail (scheduled reports)' })).toBeVisible();
  await expect(page.getByLabel('App password')).toHaveAttribute('type', 'password');
  await expectAccessible(page, 'mailbox settings');
  await page.goto('/reports');

  // Step 6.4: stock and people reports, each with its own filters.
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Stock on hand' });
  await expect(page.getByLabel('Stock category')).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Stock on hand' }).getByRole('row').last(),
  ).toContainText('Total');
  await expectAccessible(page, 'stock on hand');
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Audit log' });
  await page.getByLabel('Period').selectOption({ label: 'Today' });
  await page.getByLabel('Record').selectOption('invoice');
  const audit = page.getByRole('table', { name: 'Audit log' });
  await expect(audit.getByRole('row', { name: /invoice\.settle/ }).first()).toBeVisible();
});
