/**
 * Phase 4 step 4.5 on screen (AT-108): the clerk counts one category blind, per lot for a
 * lot-tracked item; a small variance would post at once, but one line is over the
 * approval limits, so the count waits; the owner, on another device, sees the variances
 * and approves; the stock moves by the variances only.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

async function post(page: Page, path: string, data: object): Promise<Record<string, unknown>> {
  const res = await page.request.post(`/api/staff/v1${path}`, {
    data,
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

async function onHand(page: Page, itemId: string): Promise<string> {
  const res = await page.request.get(`/api/staff/v1/inventory/items/${itemId}`);
  return ((await res.json()) as { onHand: string }).onHand;
}

test('a blind count of one category, approved by the owner on another device', async ({
  page,
  browser,
}) => {
  const s = shop();
  const clerk = s.staff.find((u) => u.role === 'inventory_clerk');
  if (!clerk) throw new Error('no inventory clerk in the e2e shop');
  await registerDevice(page, s.codes[20] ?? '');
  await logIn(page, clerk.username, s.password);

  const milk = (await post(page, '/inventory/items', {
    sku: 'cnt-milk',
    name: 'Count milk',
    category: 'Count test',
    baseUom: 'ml',
    trackLots: true,
    trackExpiry: true,
  })) as { id: string };
  const sugar = (await post(page, '/inventory/items', {
    sku: 'cnt-sugar',
    name: 'Count sugar sachets',
    category: 'Count test',
    baseUom: 'pcs',
  })) as { id: string };
  await post(page, '/purchase-receipts', {
    paidNow: false,
    startStockControl: [milk.id, sugar.id],
    lines: [
      { itemId: milk.id, qty: '1000', lineCost: '300', expiryDate: '2099-05-01', lotCode: 'CM1' },
      { itemId: sugar.id, qty: '200', lineCost: '400' },
    ],
  });

  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Counts' }).click();
  await page.getByLabel('Count', { exact: true }).selectOption('category');
  await page.getByLabel('Category').selectOption('Count test');
  await page.getByRole('button', { name: 'Start count' }).click();
  await expect(page.getByRole('heading', { name: /^Count CNT-\d{4}-\d{5}$/ })).toBeVisible();
  await expect(
    page.getByText('0 of 2 items counted. Blind count: enter what is on the shelf.'),
  ).toBeVisible();

  const milkBox = page.getByRole('group', { name: 'Count Count milk' });
  await milkBox.getByLabel('Lot CM1 · expires 2099-05-01', { exact: true }).fill('990');
  await milkBox.getByLabel('Lot CM1 · expires 2099-05-01', { exact: true }).press('Enter');
  await expect(milkBox.getByText('Saved: 990 ml')).toBeVisible();
  const sugarBox = page.getByRole('group', { name: 'Count Count sugar sachets' });
  await sugarBox.getByLabel('Counted Count sugar sachets', { exact: true }).fill('150');
  await sugarBox.getByLabel('Counted Count sugar sachets', { exact: true }).press('Enter');
  await expect(sugarBox.getByText('Saved: 150 pcs')).toBeVisible();
  await expect(page.getByText('2 of 2 items counted.', { exact: false })).toBeVisible();
  await expectAccessible(page, 'counting');
  await page.getByRole('button', { name: 'Submit count' }).click();
  await expect(page.getByText('Waiting for approval').first()).toBeVisible();
  expect(await onHand(page, sugar.id)).toBe('200.0000'); // nothing posted yet

  // The owner, on another device.
  const baseURL = test.info().project.use.baseURL;
  const ownerDevice = await browser.newContext(baseURL ? { baseURL } : {});
  const ownerPage = await ownerDevice.newPage();
  try {
    await registerDevice(ownerPage, s.codes[21] ?? '');
    await logIn(ownerPage, s.owner.username, s.owner.password);
    await ownerPage.getByRole('link', { name: 'Inventory' }).click();
    await ownerPage.getByRole('tab', { name: 'Counts' }).click();
    await ownerPage
      .getByRole('button', { name: /^Open\s*CNT-/ })
      .first()
      .click();
    const sugarRow = ownerPage.getByRole('row', { name: /Count sugar sachets/ });
    await expect(sugarRow).toContainText('200 pcs');
    await expect(sugarRow).toContainText('-50 pcs');
    await expect(sugarRow).toContainText('Over the limit');
    await expect(ownerPage.getByRole('row', { name: /Count milk · lot CM1/ })).toContainText(
      '-10 ml',
    );
    await expectAccessible(ownerPage, 'count approval');
    await ownerPage.getByRole('button', { name: 'Approve and post' }).click();
    await expect(ownerPage.getByText('Posted').first()).toBeVisible();
  } finally {
    await ownerDevice.close();
  }
  expect(await onHand(page, sugar.id)).toBe('150.0000');
  expect(await onHand(page, milk.id)).toBe('990.0000');
});
