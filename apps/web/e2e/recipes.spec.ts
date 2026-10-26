/**
 * Phase 4 step 4.8 on screen: the owner writes a recipe for a size, activates it and
 * switches the size to track stock. AT-102 end to end: when its milk runs out, the drink
 * shows unavailable on the guest's phone and on the staff menu; when stock comes back it
 * is available again; the manual "unavailable" switch wins over stock.
 */
import { devices, expect, test, type Page } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

async function post(page: Page, path: string, data: object): Promise<Record<string, unknown>> {
  const res = await page.request.post(`/api/staff/v1${path}`, {
    data,
    headers: { 'x-cl-request': '1', 'idempotency-key': crypto.randomUUID() },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

test('a recipe written on screen; the drink follows its milk on guest and staff menus (AT-102)', async ({
  page,
  browser,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[22] ?? '');
  await logIn(page, s.owner.username, s.owner.password);

  const milk = (await post(page, '/inventory/items', {
    sku: 'rcp-milk',
    name: 'E2E recipe milk',
    baseUom: 'ml',
  })) as { id: string };
  await post(page, '/purchase-receipts', {
    paidNow: false,
    startStockControl: [milk.id],
    lines: [{ itemId: milk.id, qty: '300', lineCost: '90' }],
  });
  const cat = await post(page, '/menu/categories', { name: 'Recipe e2e' });
  const drink = (await post(page, '/menu/items', {
    categoryId: cat['id'],
    name: 'E2E flat white',
    variants: [{ name: 'Regular', price: '450' }],
  })) as { variantIds: string[] };
  const variantId = drink.variantIds[0] ?? '';
  const table = await post(page, '/tables', { code: 'RC1', name: 'Recipe table' });
  const qr = (await post(page, '/qr-entry-points/generate', {
    tableIds: [table['id']],
    counter: false,
  })) as { items: { url: string }[] };

  // The recipe, on screen.
  await page.getByRole('link', { name: 'Menu & recipes' }).click();
  await page.getByRole('tab', { name: 'Recipes' }).click();
  await page.getByRole('button', { name: /Open\s*E2E flat white Regular/ }).click();
  await expect(page.getByRole('heading', { name: 'E2E flat white · Regular' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a recipe' }).click();
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  const row = page.getByRole('group', { name: 'Ingredient new' });
  await row.getByLabel('Ingredient').selectOption({ label: 'E2E recipe milk' });
  await page
    .getByRole('group', { name: 'Ingredient E2E recipe milk' })
    .getByLabel('Quantity')
    .fill('200');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByRole('button', { name: 'Activate v1' }).click();
  await expect(page.getByRole('heading', { name: 'Active recipe · v1' })).toBeVisible();
  await page.getByRole('button', { name: 'Track stock with this recipe' }).click();
  await expect(
    page.getByText('This size tracks stock: each sale reserves and uses its ingredients.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Show what one takes' }).click();
  await expect(page.getByRole('table', { name: 'One unit takes' })).toContainText(
    'E2E recipe milk200 ml',
  );
  await expectAccessible(page, 'recipe editor');

  // The guest's phone.
  const phone = await browser.newContext({ ...devices['Pixel 7'] });
  const guest = await phone.newPage();
  const guestDrink = async () => {
    await guest.goto(qr.items[0]?.url ?? '');
    await guest.getByRole('button', { name: 'View menu' }).click();
    await guest.getByRole('tab', { name: 'Recipe e2e' }).click();
    return guest.getByRole('button', { name: /E2E flat white/ });
  };
  try {
    await expect(await guestDrink()).toBeEnabled();
    await expect(await guestDrink()).toContainText('Rs 450');

    // 300 ml − 200 ml spilled: one flat white needs 200 ml, so it is out.
    await post(page, '/inventory/waste', { itemId: milk.id, qty: '200', reasonCode: 'spilled' });
    const out = await guestDrink();
    await expect(out).toBeDisabled();
    await expect(out).toContainText('Unavailable right now');
    await page.getByRole('tab', { name: 'Items' }).click();
    const staffRow = page.getByRole('row', { name: /E2E flat white/ });
    await expect(staffRow).toContainText('Out of stock');
    await expectAccessible(guest, 'guest menu with an unavailable drink');

    // Milk arrives: available again.
    await post(page, '/purchase-receipts', {
      paidNow: false,
      lines: [{ itemId: milk.id, qty: '1000', lineCost: '300' }],
    });
    await expect(await guestDrink()).toBeEnabled();

    // The manual switch wins over stock.
    await post(page, `/menu/variants/${variantId}/availability`, {
      available: false,
      reason: 'Machine down',
    });
    await expect(await guestDrink()).toBeDisabled();
    const menu = (await (await page.request.get('/api/staff/v1/menu')).json()) as {
      categories: { items: { variants: { id: string; unavailableReason: string | null }[] }[] }[];
    };
    const v = menu.categories
      .flatMap((c) => c.items)
      .flatMap((i) => i.variants)
      .find((x) => x.id === variantId);
    expect(v?.unavailableReason).toBe('marked_unavailable');
  } finally {
    await phone.close();
  }
});
