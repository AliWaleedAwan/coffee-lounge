/**
 * Phase 3 step 3.1 journeys: the owner builds the menu, changes a price and adds a
 * promotion; a cashier marks a size unavailable. AT-86 for every menu screen; AT-126's
 * staff side (tags shown exactly as entered).
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

test('owner builds the menu, changes a price and schedules a promotion', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[4] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Menu & recipes' }).click();
  await expect(page.getByRole('heading', { name: 'Menu', exact: true })).toBeVisible();
  await expect(page.getByText('The menu is empty.')).toBeVisible();

  await page.getByLabel('Category name').fill('Coffee');
  await page.getByRole('button', { name: 'Add category' }).click();
  await expect(page.getByRole('heading', { name: 'Coffee' })).toBeVisible();

  await page.getByRole('tab', { name: 'Choices' }).click();
  await page.getByLabel('Group name').fill('Milk');
  await page.getByLabel(/Choices, one per line/).fill('Whole\nOat');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('heading', { name: 'Milk' })).toBeVisible();
  await page.getByRole('button', { name: 'Change charge for Oat' }).click();
  await page.getByLabel('Extra charge for Oat').fill('80');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('+ Rs 80')).toBeVisible();
  await expectAccessible(page, 'menu choices');

  await page.getByRole('tab', { name: 'Items' }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Latte');
  await page.getByLabel('Dietary and allergen tags').fill('Contains MILK\nHalal ✓');
  await page.getByLabel('Milk').check();
  await page.getByLabel('Size 1', { exact: true }).fill('Regular');
  await page.getByLabel('Price of size 1').fill('450');
  await page.getByRole('button', { name: 'Add another size' }).click();
  await page.getByLabel('Size 2', { exact: true }).fill('Large');
  await page.getByLabel('Price of size 2').fill('550');
  await expectAccessible(page, 'new item');
  await page.getByRole('button', { name: 'Create item' }).click();

  const latte = page.getByRole('row', { name: /Latte/ });
  await expect(latte).toContainText('Contains MILK · Halal ✓');
  await expect(latte).toContainText('Rs 450');
  await expect(latte).toContainText('Rs 550');
  await expectAccessible(page, 'menu items');

  await latte.getByRole('button', { name: 'Edit Latte' }).click();
  await page.getByRole('button', { name: 'Change price of Regular' }).click();
  await page.getByLabel('New price for Regular').fill('480');
  await page.getByLabel('Reason').fill('Milk price went up');
  await page.getByRole('button', { name: 'Save price' }).click();
  await expect(page.getByRole('row', { name: /Regular/ })).toContainText('Rs 480');
  await expectAccessible(page, 'item editor');
  await page.getByRole('button', { name: 'Back to the menu' }).click();

  await page.getByRole('tab', { name: 'Promotions' }).click();
  await page.getByRole('button', { name: 'New promotion' }).click();
  await page.getByLabel('Name').fill('Coffee 10%');
  await page.getByLabel('Percent off').fill('10');
  await page.getByLabel('Starts on').fill('2026-01-01');
  await page.getByRole('group', { name: 'Whole categories' }).getByLabel('Coffee').check();
  await expectAccessible(page, 'promotion form');
  await page.getByRole('button', { name: 'Create promotion' }).click();
  await expect(page.getByRole('row', { name: /Coffee 10%/ })).toContainText('Every day · all day');
  await expectAccessible(page, 'promotions');

  await page.getByRole('tab', { name: 'Items' }).click();
  // 480 → 432 with 10% off, shown next to the struck-through price.
  await expect(page.getByRole('row', { name: /Latte/ })).toContainText('Rs 432');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/menu-owner.png`, fullPage: true });
});

test('a cashier marks a size unavailable and back, and cannot edit the menu', async ({ page }) => {
  const s = shop();
  const cashier = s.staff.find((u) => u.role === 'cashier');
  await registerDevice(page, s.codes[5] ?? '');
  await logIn(page, cashier?.username ?? '', s.password);
  await page.getByRole('link', { name: 'Menu & recipes' }).click();
  const latte = page.getByRole('row', { name: /Latte/ });
  await expect(latte).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(0);

  await latte.getByRole('button', { name: /Mark unavailable\s*\(Large\)/ }).click();
  await page.getByLabel('Why is Large unavailable? (optional)').fill('Out of large cups');
  await page.getByRole('button', { name: 'Mark unavailable', exact: true }).click();
  await expect(latte).toContainText('Unavailable: Out of large cups');
  await expectAccessible(page, 'menu (cashier)');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/menu-cashier.png`, fullPage: true });

  await latte.getByRole('button', { name: /Mark available\s*\(Large\)/ }).click();
  await expect(latte).not.toContainText('Unavailable');
});
