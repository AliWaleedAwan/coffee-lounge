/**
 * The owner designs the receipt: text typed on the left shows on the paper on the right,
 * as the printer's own renderer lays it out. (Item photos: menu.spec.ts.)
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

test('owner designs the receipt and sees it as it prints', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[31] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Receipt design' }).click();
  await expect(page.getByRole('heading', { name: 'Receipt design', level: 1 })).toBeVisible();
  const paper = page.getByRole('img', { name: 'Receipt preview' });
  await expect(paper).toContainText('COFFEE LOUNGE');
  await expect(paper).toContainText('Cashier:');

  await page.getByRole('button', { name: 'Add top text' }).click();
  await page.getByLabel('Top text 1').fill('NTN 1234567-8\nOpen 10am to 2am');
  await expect(paper).toContainText('NTN 1234567-8');
  await expect(paper).toContainText('Open 10am to 2am');
  await page.getByLabel("Print the cashier's name").uncheck();
  await expect(paper).not.toContainText('Cashier:');
  await expectAccessible(page, 'receipt design');
  await page.getByRole('button', { name: 'Save receipt design' }).click();
  await expect(page.getByText('Saved. The next receipt prints like this.')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/receipt-design.png`, fullPage: true });
  await page.reload();
  await expect(page.getByRole('img', { name: 'Receipt preview' })).toContainText('NTN 1234567-8');
  await page.getByRole('button', { name: 'Back to the standard receipt' }).click();
  await expect(page.getByText('Back to the standard receipt.')).toBeVisible();
});
