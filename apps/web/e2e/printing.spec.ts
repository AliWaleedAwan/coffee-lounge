/**
 * Phase 3 step 3.6 journey with the real worker: the owner adds a network printer that
 * cannot be reached and sends a test print; the red banner appears on staff screens, the
 * Print jobs screen shows the job trying again, and turning the printer off clears it.
 * Printing onto paper is proven with the TCP simulator in the server tests and with a
 * Windows print queue in Windows CI; the shop's own printer is checked on site (AT-85).
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

test('printer setup, test print, the printer banner and the jobs screen', async ({ page }) => {
  test.setTimeout(60_000);
  const s = shop();
  await registerDevice(page, s.codes[10] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Printers' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Bench printer');
  await page.getByLabel('Connected by').selectOption('tcp');
  await page.getByLabel('Address', { exact: true }).fill('127.0.0.1:9'); // nothing listens: connection refused
  await page.getByRole('button', { name: 'Add printer' }).click();
  await expect(page.getByRole('cell', { name: 'Bench printer', exact: true })).toBeVisible();
  await page.getByLabel('Kitchen tickets print on').selectOption({ label: 'Bench printer' });
  await expectAccessible(page, 'settings: printers');

  await page.getByRole('button', { name: 'Test print Bench printer' }).click();
  await expect(page.getByText('Test page sent to Bench printer.')).toBeVisible();

  // The worker cannot reach it: the banner tells every staff screen.
  const banner = page
    .getByRole('alert')
    .filter({ hasText: 'Printer “Bench printer” is not printing' });
  await expect(banner).toBeVisible({ timeout: 40_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/printer-banner.png`, fullPage: true });
  await banner.getByRole('link', { name: 'Open print jobs' }).click();
  const row = page.getByRole('row', { name: /Test print/ });
  await expect(row).toContainText('Trying again');
  await expect(row).toContainText('The printer is not answering.');
  await expectAccessible(page, 'print jobs');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/print-jobs.png`, fullPage: true });

  // Turn it off: no banner for the specs after this one.
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Turn off Bench printer' }).click();
  await page
    .getByLabel('Kitchen tickets print on')
    .selectOption({ label: 'No printer (screens only)' });
  await expect(banner).toBeHidden({ timeout: 40_000 });
});
