/**
 * Phase 3 step 3.3 journeys: the owner adds tables and makes the printable QR sheet; a
 * guest phone scans one (customer listener) without opening anything; staff open the
 * table, the next scan joins it, and the session moves to another table. AT-86 for the
 * floor screens.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const SHOTS = process.env['E2E_SCREENSHOT_DIR'];

test('owner sets up tables and QR cards; guests scan; staff open and move a table', async ({
  page,
  playwright,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[6] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Floor' }).click();
  await expect(page.getByRole('heading', { name: 'Floor', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Tables & QR codes' }).click();

  for (const { code, name } of [
    { code: 'T01', name: 'Window 1' },
    { code: 'T02', name: 'Window 2' },
  ]) {
    await page.getByLabel('Code', { exact: true }).fill(code);
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Seats (optional)').fill('4');
    await page.getByRole('button', { name: 'Add table' }).click();
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await expectAccessible(page, 'tables and QR codes');

  await page.getByLabel('All tables').check();
  await page.getByLabel('Counter takeaway code').check();
  const generated = page.waitForResponse((r) => r.url().endsWith('/qr-entry-points/generate'));
  await page.getByRole('button', { name: 'Make codes for printing' }).click();
  const sheet = (await (await generated).json()) as { items: { label: string; url: string }[] };
  await expect(page.getByRole('img', { name: /^QR code for/ })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Print' })).toBeEnabled();
  await expectAccessible(page, 'QR sheet');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/qr-sheet.png`, fullPage: true });
  await page.getByRole('button', { name: 'Done' }).click();

  // A guest scans Window 1: the menu opens, nothing is occupied.
  const window1 = sheet.items.find((i) => i.label === 'Window 1')?.url ?? '';
  expect(window1).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]{22}$/);
  const token = window1.split('/t/')[1] ?? '';
  const guest = await playwright.request.newContext({ baseURL: new URL(window1).origin });
  const browse = await guest.get(`/api/customer/v1/entry/${token}`);
  expect(await browse.json()).toMatchObject({ orderingOpen: true, session: null });
  expect((await guest.get('/api/customer/v1/menu')).status()).toBe(200);

  await page.getByRole('tab', { name: 'Tables now' }).click();
  const w1 = page.getByRole('region', { name: 'Window 1' });
  await expect(w1.getByText('Available')).toBeVisible();
  await w1.getByRole('button', { name: 'Open table Window 1' }).click();
  await w1.getByLabel('Guests (optional)').fill('2');
  await w1.getByRole('button', { name: 'Open table', exact: true }).click();
  await expect(w1.getByText('Occupied')).toBeVisible();

  // The next scan at Window 1 joins the session (D-09).
  const second = await playwright.request.newContext({ baseURL: new URL(window1).origin });
  const joined = (await (await second.get(`/api/customer/v1/entry/${token}`)).json()) as {
    session: { sessionNo: string } | null;
  };
  expect(joined.session?.sessionNo).toMatch(/^S-\d{8}-\d{4}$/);
  await expect(w1.getByText(/^1$/)).toBeVisible(); // one guest phone
  await expectAccessible(page, 'floor');

  await w1.getByRole('button', { name: 'Move Window 1' }).click();
  await w1.getByLabel('Move to').selectOption({ label: 'Window 2' });
  await w1.getByRole('button', { name: 'Move session' }).click();
  await expect(page.getByRole('region', { name: 'Window 2' }).getByText('Occupied')).toBeVisible();
  await expect(w1.getByText('Available')).toBeVisible();
  // The joined phone follows its session.
  expect((await second.get('/api/customer/v1/session')).status()).toBe(200);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/floor.png`, fullPage: true });
  await guest.dispose();
  await second.dispose();
});
