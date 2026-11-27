/**
 * The guides' words are the screens' words (Phase 7 step 7.6): every menu item, tab, heading
 * and button that docs/phase-7/OWNER_GUIDE.md, TRAINING.md and RUNBOOKS.md tell people to
 * use is there, named as they are written, for the owner. A screen renamed without its guide
 * fails here.
 */
import { expect, test } from '@playwright/test';
import { logIn, registerDevice, shop } from './support.ts';

test('every screen, tab and button the guides name exists as written', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[30] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const area of [
    'Floor',
    'Live operations',
    'Approvals',
    'Pickup',
    'Bills & payments',
    'Deliveries',
    'Inventory',
    'Menu & recipes',
    'Reports',
    'Users & roles',
    'Devices',
    'Settings',
    'Audit log',
    'System health',
  ])
    await expect(nav.getByRole('link', { name: area, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Switch user' })).toBeVisible();

  const visit = async (area: string, heading = area) => {
    await nav.getByRole('link', { name: area, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  };
  await visit('Users & roles');
  for (const tab of ['People', 'Roles'])
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await visit('Devices');
  await expect(page.getByRole('button', { name: 'Create code' })).toBeVisible();
  await visit('Settings');
  for (const heading of [
    'Shop and branding',
    'E-mail (scheduled reports)',
    'Off-site copy of the backups',
  ])
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await visit('Hardware');
  for (const heading of ['Printers', 'Scanner'])
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await visit('Inventory');
  for (const tab of ['Receive stock', 'Waste', 'Counts', 'Import'])
    await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await visit('Menu & recipes', 'Menu');
  await expect(page.getByRole('tab', { name: 'Recipes' })).toBeVisible();
  await visit('Bills & payments');
  // No shift open yet: the counter offers to open one (TRAINING.md, cashier).
  await expect(page.getByLabel('Opening float (Rs)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open shift' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Refunds & corrections' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New takeaway' })).toBeVisible();
  await visit('Reports');
  await expect(
    page.getByLabel('Report', { exact: true }).getByRole('option', { name: 'Day-end' }),
  ).toBeAttached();
  await expect(page.getByRole('button', { name: 'E-mail reports' })).toBeVisible();
  await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Sales by day' });
  for (const link of ['Download CSV', 'Download PDF'])
    await expect(page.getByRole('link', { name: link })).toBeVisible();
  await visit('System health');
  await expect(page.getByText('Backup drive')).toBeVisible();
});
