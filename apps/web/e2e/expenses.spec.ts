/**
 * Phase 5 step 5.3 on screen (AT-107, AT-23): the owner records the electricity bill paid
 * by bank transfer with a PDF of the bill, sees it in the period with its category total,
 * then corrects the amount: the first is voided with the reason and the new one names it;
 * the bill stays attached. No cash from the till: specs before till.spec open no shift.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('the owner records an expense with its bill, then corrects it', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[26] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Expenses' }).click();
  await expect(page.getByRole('heading', { name: 'Expenses', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Record an expense' }).click();
  const form = page.getByRole('form', { name: 'Record an expense' });
  await form.getByLabel('Category').selectOption({ label: 'Utilities' });
  await form.getByLabel('Amount (Rs)').fill('12500');
  await form.getByLabel('Paid by').selectOption({ label: 'Transfer' });
  await form.getByLabel('Provider').selectOption({ label: 'Bank' });
  await form.getByLabel('Paid to').fill('LESCO');
  await form.getByLabel('Bill or reference number').fill('OCT-0042');
  await form.getByLabel(/^Bill \(photo or PDF/).setInputFiles({
    name: 'lesco-october.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% LESCO October\n'),
  });
  await expectAccessible(page, 'expense form');
  await form.getByRole('button', { name: 'Record expense' }).click();
  const recorded = page
    .getByRole('status')
    .filter({ hasText: /Recorded EXP-\d{4}-\d{5} with its bill\./ });
  await expect(recorded).toBeVisible();
  const expenseNo = /EXP-\d{4}-\d{5}/.exec((await recorded.textContent()) ?? '')?.[0] ?? '';

  const table = page.getByRole('table', { name: 'Expenses' });
  const row = table.getByRole('row', { name: new RegExp(`^${expenseNo} `) });
  await expect(row).toContainText('Utilities');
  await expect(row).toContainText('Transfer · Bank');
  await expect(row).toContainText('Rs 12500');
  await expect(
    row.getByRole('link', { name: `Download the bill of ${expenseNo} (PDF)` }),
  ).toBeVisible();
  await expect(page.getByText(/Recorded expenses Rs 12500 · Utilities Rs 12500/)).toBeVisible();
  await expectAccessible(page, 'expenses');

  await row.getByRole('button', { name: `Correct ${expenseNo}` }).click();
  const fix = page.getByRole('form', { name: `Correct ${expenseNo}` });
  await fix.getByLabel('Amount (Rs)').fill('12000');
  await fix.getByLabel('Why is it corrected').fill('The bill says 12,000');
  await fix.getByRole('button', { name: 'Void and record again' }).click();
  const again = page.getByRole('status').filter({
    hasText: new RegExp(`${expenseNo} voided and recorded again as EXP-\\d{4}-\\d{5}\\.`),
  });
  await expect(again).toBeVisible();
  const newNo = /as (EXP-\d{4}-\d{5})/.exec((await again.textContent()) ?? '')?.[1] ?? '';

  await expect(
    table.getByRole('row', { name: new RegExp(`^${expenseNo} \\(voided\\)`) }),
  ).toContainText('The bill says 12,000');
  const fresh = table.getByRole('row', { name: new RegExp(`^${newNo} `) });
  await expect(fresh).toContainText('Rs 12000');
  await expect(
    fresh.getByRole('link', { name: `Download the bill of ${newNo} (PDF)` }),
  ).toBeVisible();
  await expect(page.getByText(/Recorded expenses Rs 12000 · Utilities Rs 12000/)).toBeVisible();
});
