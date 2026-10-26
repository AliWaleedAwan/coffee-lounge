/**
 * Phase 4 step 4.1 on screen: the clerk adds an item with a pack and links a barcode by
 * typing it and Enter, which is what a USB scanner does (P4-4; the real SNC-930D is HW-10,
 * on site). Scanning it from the search box opens the exact item; an unknown code offers
 * to link; a code another item owns is refused, naming the owner (AT-14 on screen).
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('a clerk adds an item, a pack and a barcode, then scans it', async ({ page }) => {
  const s = shop();
  const clerk = s.staff.find((u) => u.role === 'inventory_clerk');
  if (!clerk) throw new Error('no inventory clerk in the e2e shop');
  await registerDevice(page, s.codes[18] ?? '');
  await logIn(page, clerk.username, s.password);
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Needs attention' })).toBeVisible();
  await expectAccessible(page, 'inventory overview');
  await page.getByRole('tab', { name: 'Items' }).click();

  // A new item, its 1 L carton and the carton's barcode.
  await page.getByRole('button', { name: 'New item' }).click();
  await page.getByLabel('SKU').fill('e2e-milk');
  await page.getByLabel('Name', { exact: true }).fill('E2E whole milk');
  await page.getByLabel('Category (optional)').fill('Dairy');
  await page.getByLabel('Track lots (receipts create lots, used earliest expiry first)').check();
  await page.getByLabel('Track expiry dates').check();
  await page.getByLabel('Warn this many days before expiry').fill('2');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('heading', { name: 'E2E whole milk' })).toBeVisible();
  const packs = page.getByRole('region', { name: 'Pack sizes' });
  await packs.getByLabel('Pack name').fill('1 L carton');
  await packs.getByLabel('Holds').fill('1');
  await packs.getByLabel('Unit').selectOption('l');
  await expect(packs.getByText('= 1,000 ml')).toBeVisible();
  await packs.getByRole('button', { name: 'Add pack' }).click();
  await expect(packs.getByRole('row', { name: /1 L carton 1,000 ml/ })).toBeVisible();
  const barcodes = page.getByRole('region', { name: 'Barcodes' });
  await barcodes.getByLabel('Scan or type a barcode').pressSequentially('8960000000901');
  await barcodes.getByLabel('Scan or type a barcode').press('Enter');
  await expect(barcodes.getByRole('row', { name: /8960000000901 1 L carton/ })).toBeVisible();
  await expectAccessible(page, 'inventory item');

  // Scan from the list: the exact item opens.
  await page.getByRole('button', { name: 'Back to inventory' }).click();
  const box = page.getByLabel('Scan or type barcode / name');
  await expect(box).toBeFocused();
  await box.pressSequentially('8960000000901');
  await box.press('Enter');
  await expect(page.getByRole('heading', { name: 'E2E whole milk' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to inventory' }).click();
  await expectAccessible(page, 'inventory list');

  // An unknown code: link it to a second item, then try the first item's code there.
  await page.getByRole('button', { name: 'New item' }).click();
  await page.getByLabel('SKU').fill('e2e-cups');
  await page.getByLabel('Name', { exact: true }).fill('E2E cups');
  await page.getByLabel('Base unit').selectOption('pcs');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('heading', { name: 'E2E cups' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to inventory' }).click();
  await box.pressSequentially('4006381333931');
  await box.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Barcode 4006381333931 isn’t linked to any item yet',
  );
  await page.getByRole('button', { name: /Link here\s*E2E cups/ }).click();
  await expect(page.getByRole('heading', { name: 'E2E cups' })).toBeVisible();
  const cupCodes = page.getByRole('region', { name: 'Barcodes' });
  await expect(cupCodes.getByLabel('Scan or type a barcode')).toHaveValue('4006381333931');
  await cupCodes.getByRole('button', { name: 'Link barcode' }).click();
  await expect(cupCodes.getByRole('row', { name: /4006381333931 One pcs/ })).toBeVisible();
  await cupCodes.getByLabel('Scan or type a barcode').fill('8960000000901');
  await cupCodes.getByLabel('Scan or type a barcode').press('Enter');
  await expect(cupCodes.getByRole('alert')).toHaveText(
    /^Barcode 8960000000901 already belongs to E2E whole milk \(E2E-MILK\), 1 L carton$/,
  );
});
