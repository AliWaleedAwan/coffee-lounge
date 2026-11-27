/**
 * Phase 8 step 8.2: a clerk scans an unknown barcode (typing it and Enter, as a USB scanner
 * does) and saves a product, not on sale; scanning it again opens its card; the owner sets
 * the price, which puts it on sale, and corrects a wrong expiry date.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('scan to add a product, then price it and correct its date', async ({ page }) => {
  const s = shop();
  const clerk = s.staff.find((u) => u.role === 'inventory_clerk');
  if (!clerk) throw new Error('no inventory clerk in the e2e shop');
  await registerDevice(page, s.codes[32] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const res = await page.request.post('/api/staff/v1/menu/categories', {
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
    data: { name: 'Scan drinks' },
  });
  expect(res.ok()).toBe(true);
  await page.getByRole('button', { name: 'Log out' }).click();

  await logIn(page, clerk.username, s.password);
  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Items' }).click();
  const scan = page.getByLabel('Scan or type barcode / name');
  await scan.fill('8964000101476');
  await scan.press('Enter');
  await page.getByRole('button', { name: 'Add as a new item' }).click();

  const form = page.getByRole('form', { name: 'New product' });
  await expect(form).toContainText('8964000101476');
  await expect(form.getByLabel('Selling price (Rs)')).toHaveCount(0);
  await form.getByLabel('Name').fill('Scan Pepsi Tin');
  await form.getByLabel('Menu category').selectOption({ label: 'Scan drinks' });
  await form.getByLabel('This product has an expiry date').check();
  await form.getByLabel('Quantity').fill('24');
  await form.getByLabel('Cost of one (Rs)').fill('80');
  await form.getByLabel('Expiry date', { exact: true }).fill('2027-03-01');
  await expectAccessible(page, 'new product');
  await form.getByRole('button', { name: 'Save product' }).click();

  const selling = page.getByRole('region', { name: 'Selling price' });
  await expect(selling).toContainText('Not on sale');
  await page.getByRole('button', { name: 'Back to inventory' }).click();
  await scan.fill('8964000101476');
  await scan.press('Enter');
  await expect(page.getByRole('heading', { name: 'Scan Pepsi Tin' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out' }).click();

  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Items' }).click();
  await page.getByLabel('Scan or type barcode / name').fill('8964000101476');
  await page.getByLabel('Scan or type barcode / name').press('Enter');
  await selling.getByLabel('New selling price (Rs)').fill('120');
  await selling.getByRole('button', { name: 'Set price' }).click();
  await expect(selling).toContainText('On sale');
  await expect(selling).toContainText('120');

  await page.getByRole('button', { name: 'Correct date' }).click();
  await page.getByLabel('Correct expiry date').fill('2027-04-15');
  await page.getByLabel('Why', { exact: true }).fill('Misread the can');
  await page.getByRole('button', { name: 'Save date' }).click();
  await expect(page.getByRole('region', { name: 'Lots' })).toContainText('2027-04-15');
});
