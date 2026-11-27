/**
 * Phase 8 step 8.3: on the counter a scan adds the product to the order, a second scan makes
 * it two, and an unknown code says so.
 */
import { expect, test } from '@playwright/test';
import { logIn, registerDevice, shop } from './support.ts';

test('scan to sell at the counter', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[33] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  const post = async (path: string, data: object) => {
    const res = await page.request.post(`/api/staff/v1${path}`, {
      headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
      data,
    });
    expect(res.ok()).toBe(true);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as { id: string };
  };
  const cat = await post('/menu/categories', { name: 'Scan to sell' });
  await post('/products', {
    barcode: '8964000000017',
    name: 'Scan juice',
    categoryId: cat.id,
    price: '150',
    opening: { qty: '10', unitCost: '100' },
  });
  const table = await post('/tables', { code: 'SC1', name: 'Scan table' });
  const session = await post(`/tables/${table.id}/sessions`, {});
  await page.goto(`/sessions/${session.id}`);

  const box = page.getByLabel('Scan a product');
  await box.pressSequentially('8964000000017');
  await box.press('Enter');
  await expect(page.getByText('Scan juice').first()).toBeVisible();
  await expect(box).toBeFocused();
  await box.pressSequentially('8964000000017');
  await box.press('Enter');
  await expect(page.getByText('Rs 300').first()).toBeVisible();
  await box.pressSequentially('1111111111111');
  await box.press('Enter');
  await expect(page.getByRole('form', { name: 'Scan to sell' })).toContainText('not known');
  // Back as it was for the journeys after this one: nothing sent, the table free.
  await post(`/sessions/${session.id}/cancel`, { reason: 'Test finished' });
});
