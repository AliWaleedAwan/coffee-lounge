/**
 * Phase 4 step 4.2 on screen. UX-J7 (UI_UX.md §7): the clerk scans and receives three
 * items with lot and expiry, within 90 s, counting every action (a scan is one: the code
 * and Enter, as a USB scanner types them, P4-4; the real SNC-930D is HW-10, on site).
 * AT-14 on screen: an unknown barcode is linked to an item from the receive screen and
 * lands on the receipt. A wrong receipt is reversed from the receipts list.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

async function post(page: Page, path: string, data: object): Promise<Record<string, unknown>> {
  const res = await page.request.post(`/api/staff/v1${path}`, {
    data,
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

/** An item with one pack and the pack's barcode; returns the item id. */
async function item(
  page: Page,
  fields: {
    sku: string;
    name: string;
    baseUom: string;
    trackLots?: boolean;
    trackExpiry?: boolean;
  },
  pack: { name: string; qty: string; uom: string; code: string },
): Promise<string> {
  const { id } = (await post(page, '/inventory/items', fields)) as { id: string };
  const { id: packSizeId } = (await post(page, `/inventory/items/${id}/pack-sizes`, {
    name: pack.name,
    qty: pack.qty,
    uom: pack.uom,
  })) as { id: string };
  await post(page, `/inventory/items/${id}/barcodes`, { code: pack.code, packSizeId });
  return id;
}

test('J7: scan and receive three items with lot and expiry; link an unknown code; reverse', async ({
  page,
}) => {
  const s = shop();
  const clerk = s.staff.find((u) => u.role === 'inventory_clerk');
  if (!clerk) throw new Error('no inventory clerk in the e2e shop');
  await registerDevice(page, s.codes[19] ?? '');
  await logIn(page, clerk.username, s.password);

  // The shop's items, already counted (a first receipt with an empty shelf, D-29).
  const milk = await item(
    page,
    { sku: 'rcv-milk', name: 'Fresh milk', baseUom: 'ml', trackLots: true, trackExpiry: true },
    { name: '1 L carton', qty: '1', uom: 'l', code: '8960000000105' },
  );
  const oat = await item(
    page,
    { sku: 'rcv-oat', name: 'Oat drink', baseUom: 'ml', trackLots: true, trackExpiry: true },
    { name: '1 L carton', qty: '1', uom: 'l', code: '8960000000112' },
  );
  const cups = await item(
    page,
    { sku: 'rcv-cups', name: 'Paper cups 8 oz', baseUom: 'pcs' },
    { name: 'Sleeve of 50', qty: '50', uom: 'pcs', code: '8960000000129' },
  );
  await post(page, '/purchase-receipts', {
    paidNow: false,
    startStockControl: [milk, oat, cups],
    lines: [
      { itemId: milk, qty: '500', lineCost: '140', expiryDate: '2099-01-01' },
      { itemId: oat, qty: '500', lineCost: '300', expiryDate: '2099-01-01' },
      { itemId: cups, qty: '20', lineCost: '300' },
    ],
  });
  await post(page, '/suppliers', { name: 'E2E Dairy' });
  await page.getByRole('link', { name: 'Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', level: 1 })).toBeVisible();

  // ---- J7, timed, every action counted.
  let actions = 0;
  const act = async (step: () => Promise<void>) => {
    actions += 1;
    await step();
  };
  const box = page.getByLabel('Scan or type barcode / name');
  const scan = (code: string) =>
    act(async () => {
      await box.pressSequentially(code);
      await box.press('Enter');
    });
  const started = Date.now();
  await act(() => page.getByRole('tab', { name: 'Receive stock' }).click());
  await act(() =>
    page.getByLabel('Supplier (optional)').selectOption({ label: 'E2E Dairy' }).then(),
  );
  await scan('8960000000105');
  const milkLine = page.getByRole('group', { name: 'Line: Fresh milk' });
  await expect(milkLine).toBeVisible();
  await scan('8960000000105');
  await expect(milkLine.getByText('2 × 1 L carton = 2,000 ml')).toBeVisible();
  await scan('8960000000112');
  await scan('8960000000129');
  const oatLine = page.getByRole('group', { name: 'Line: Oat drink' });
  const cupLine = page.getByRole('group', { name: 'Line: Paper cups 8 oz' });
  await expect(cupLine.getByText('1 × Sleeve of 50 = 50 pcs')).toBeVisible();
  await act(() => milkLine.getByLabel('Line cost for Fresh milk (Rs)').fill('550'));
  await expect(milkLine.getByText('Unit cost: Rs 0.2750 / ml')).toBeVisible();
  await act(() => milkLine.getByLabel('Expiry date for Fresh milk').fill('2099-11-02'));
  await act(() => oatLine.getByLabel('Line cost for Oat drink (Rs)').fill('620'));
  await act(() => oatLine.getByLabel('Expiry date for Oat drink').fill('2099-11-20'));
  await act(() => cupLine.getByLabel('Line cost for Paper cups 8 oz (Rs)').fill('750'));
  await expect(page.getByText('Receipt total: Rs 1,920')).toBeVisible();
  await expectAccessible(page, 'receive stock');
  await act(() => page.getByRole('button', { name: 'Post receipt' }).click());
  const done = page.getByRole('heading', { name: /^Posted · GRN-\d{4}-\d{5}$/ });
  await expect(done).toBeVisible();
  expect(Date.now() - started).toBeLessThan(90_000);
  expect(actions).toBeLessThanOrEqual(12);
  await expect(page.getByRole('row', { name: /Fresh milk 2,000 ml 2,500 ml/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Paper cups 8 oz 50 pcs 70 pcs/ })).toBeVisible();
  const grn = ((await done.textContent()) ?? '').replace('Posted · ', '');

  // ---- AT-14 on screen: an unknown code, linked from the receive screen.
  await page.getByRole('button', { name: 'Receive another delivery' }).click();
  await box.pressSequentially('4006381333948');
  await box.press('Enter');
  const unknown = page.getByRole('alert').filter({ hasText: '4006381333948' });
  await expect(unknown).toContainText('isn’t linked to any item yet');
  await unknown.getByRole('button', { name: 'Link to an item…' }).click();
  await unknown.getByLabel('Find the item').fill('cups');
  await unknown.getByRole('button', { name: /Paper cups 8 oz/ }).click();
  await unknown
    .getByLabel('Pack it is printed on')
    .selectOption({ label: 'Sleeve of 50 (50 pcs)' });
  await unknown.getByRole('button', { name: 'Link and add' }).click();
  await expect(page.getByRole('group', { name: 'Line: Paper cups 8 oz' })).toBeVisible();
  await box.pressSequentially('4006381333948');
  await box.press('Enter');
  await expect(
    page
      .getByRole('group', { name: 'Line: Paper cups 8 oz' })
      .getByText('2 × Sleeve of 50 = 100 pcs'),
  ).toBeVisible();

  // ---- The first receipt was wrong: reverse it while its stock is still here.
  await page.getByRole('tab', { name: 'Receipts' }).click();
  await page.getByRole('button', { name: new RegExp(`Open\\s*${grn}`) }).click();
  await expect(page.getByRole('heading', { name: grn })).toBeVisible();
  await page.getByRole('button', { name: 'Reverse this receipt…' }).click();
  await page.getByLabel('Why is this receipt wrong?').fill('Delivered to the wrong shop');
  await page.getByRole('button', { name: `Reverse ${grn}` }).click();
  await expect(page.locator('.chip', { hasText: 'Reversed' })).toBeVisible();
  await expect(page.getByText('Delivered to the wrong shop')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reverse this receipt…' })).toHaveCount(0);
  await expectAccessible(page, 'receipt');
});
