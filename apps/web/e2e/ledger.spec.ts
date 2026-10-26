/**
 * Phase 5 step 5.1 on screen: the owner opens the ledger, posts a manual entry with a
 * reason (P5-8: the bank balance on the first day), sees it in the entries with its channel
 * balance, reverses it with a reason, and the balance is back where it was; the reversed
 * entry stays (D-31).
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('the owner posts a manual entry and reverses it; nothing is edited', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[24] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Ledger' }).click();
  await expect(page.getByRole('heading', { name: 'Ledger', level: 1 })).toBeVisible();
  await expectAccessible(page, 'ledger');

  await page.getByRole('button', { name: 'New manual entry' }).click();
  const form = page.getByRole('form', { name: 'New manual entry' });
  await form.getByLabel('Amount (Rs)').fill('12345');
  await form.getByLabel('Channel').selectOption({ label: 'Transfer' });
  await form.getByLabel('Provider').selectOption({ label: 'Easypaisa' });
  await form.getByLabel('Reason').fill('Easypaisa wallet on the first day');
  await form.getByRole('button', { name: 'Post entry' }).click();
  const posted = page.getByRole('status').filter({ hasText: /Posted LE-\d{4}-\d{6}\./ });
  await expect(posted).toBeVisible();
  const entryNo = /LE-\d{4}-\d{6}/.exec((await posted.textContent()) ?? '')?.[0] ?? '';

  const balances = page.getByRole('table').first();
  const closing = balances
    .getByRole('row', { name: /Transfer · Easypaisa/ })
    .getByRole('cell')
    .last();
  await expect(closing).toHaveText('Rs 12,345');
  const row = page.getByRole('row', { name: new RegExp(`^${entryNo} `) });
  await expect(row).toContainText('Manual entry');
  await expect(row).toContainText('Easypaisa wallet on the first day');

  await row.getByRole('button', { name: `Reverse ${entryNo}` }).click();
  const reverse = page.getByRole('form', { name: `Reverse ${entryNo}` });
  await reverse.getByLabel('Why').fill('Posted to the wrong wallet');
  await reverse.getByRole('button', { name: 'Reverse entry' }).click();

  await expect(row).toContainText('reversed by LE-');
  await expect(row.getByRole('button', { name: `Reverse ${entryNo}` })).toHaveCount(0);
  await expect(page.getByRole('row', { name: new RegExp(`Reversal of ${entryNo}`) })).toBeVisible();
  await expect(closing).toHaveText('Rs 0');
});
