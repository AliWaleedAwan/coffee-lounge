/**
 * Phase 5 step 5.2 on screen (AT-36): the owner sets up a bill paid by card; the cashier
 * finds it among paid bills, refunds one of the two lattes to the card with the owner's
 * PIN on the same device, and sees the refund number, what is left, and the slip to
 * reprint. The bill itself stays as it was. Card only: specs before till.spec open no shift.
 */
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

test('a cashier refunds one item to the card with the owner approving on the device', async ({
  page,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[25] ?? '');
  await logIn(page, s.owner.username, s.owner.password);

  // The owner's PIN (to approve), and a table paid by card, through the staff API.
  await staffPost(page, '/auth/pin', { password: s.owner.password, pin: '1470' });
  const cat = await staffPost(page, '/menu/categories', { name: 'Refund menu' });
  const item = await staffPost(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'Refund latte',
    variants: [{ name: 'Regular', price: '600' }],
  });
  const variantId = (item['variantIds'] as string[])[0];
  const table = await staffPost(page, '/tables', { code: 'RF1', name: 'Refund table' });
  const session = await staffPost(page, `/tables/${String(table['id'])}/sessions`, {});
  await staffPost(page, `/sessions/${String(session['id'])}/rounds`, {
    lines: [{ variantId, qty: 2, modifierOptionIds: [] }],
  });
  const bill = (await (
    await page.request.get(`/api/staff/v1/sessions/${String(session['id'])}/bill`)
  ).json()) as { invoice: { id: string } };
  const locked = await staffPost(page, `/invoices/${bill.invoice.id}/lock`, {});
  const paid = await staffPost(page, `/invoices/${bill.invoice.id}/payments`, {
    lockVersion: locked['lockVersion'],
    method: 'card_manual',
    amount: '1200',
    reference: 'AP314',
  });
  const invoiceNo = String(paid['invoiceNo']);

  // The cashier on the same device.
  await page.getByRole('button', { name: 'Log out' }).click();
  await logIn(page, 'ali', s.password);
  await page.goto('/counter');
  await page.getByRole('link', { name: 'Refunds & corrections' }).click();
  await page.getByLabel('Invoice number, table or guest').fill('Refund table');
  await page.getByRole('button', { name: `Open ${invoiceNo}` }).click();
  await expect(page.getByRole('heading', { name: `${invoiceNo} · Refund table` })).toBeVisible();
  await expectAccessible(page, 'refunds');

  await page.getByRole('button', { name: 'Refund this Card payment' }).click();
  const form = page.getByRole('form', { name: 'Refund' });
  await form.getByLabel(/Refund latte/).selectOption({ index: 1 });
  await expect(form.getByLabel('Amount to refund (Rs)')).toHaveValue('600.00');
  await form.getByLabel('Reason').selectOption('Other');
  await form.getByLabel('What happened').fill('One latte was never served');
  await form.getByLabel('Manager username').fill(s.owner.username);
  await form.getByLabel('Manager PIN').fill('1470');
  await expectAccessible(page, 'refund form');
  await form.getByRole('button', { name: /^Refund Rs/ }).click();

  await expect(
    page.getByRole('status').filter({ hasText: /RF-\d{4}-\d{5}: Rs 600.* by Card/ }),
  ).toBeVisible();
  const done = page.getByRole('row', { name: /RF-\d{4}-\d{5} Refund by Card/ });
  await expect(done).toContainText('One latte was never served');
  await expect(done).toContainText('Owner');
  await expect(done.getByRole('button', { name: /Reprint slip/ })).toBeVisible();
  const payments = page.getByRole('table', { name: 'Payments' });
  await expect(payments.getByRole('row', { name: /Card ref AP314/ })).toContainText('600');
  await expect(
    page.getByRole('table', { name: 'Items' }).getByRole('row', { name: /Refund latte/ }),
  ).toContainText('1 · Rs 600');
});
