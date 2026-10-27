/**
 * Phase 2 shell journeys (PLAN.md step 2.7: E2E login journey; AT-86 for the shell
 * screens). Each test registers its own device with a fresh one-time code.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, navLabels, registerDevice, shop } from './support.ts';

const OWNER_AREAS = [
  'Floor',
  'Live operations',
  'Approvals',
  'Pickup',
  'Bills & payments',
  'Deliveries',
  'Inventory',
  'Menu & recipes',
  'Ledger',
  'Expenses',
  'Assets',
  'Reports',
  'Users & roles',
  'Devices',
  'Settings',
  'Audit log',
  'System health',
];

test('owner registers the counter PC, logs in and checks system health', async ({ page }) => {
  const s = shop();
  await page.goto('/');
  await expect(page).toHaveURL(/\/register$/);
  await expectAccessible(page, 'register');

  await registerDevice(page, s.codes[0] ?? '');
  await expectAccessible(page, 'login');
  await logIn(page, s.owner.username, s.owner.password);
  await expect(page).toHaveURL(/\/floor$/);
  expect(await navLabels(page)).toEqual(OWNER_AREAS);
  await expect(page.getByText('Owner · Owner')).toBeVisible();
  await expectAccessible(page, 'shell (placeholder area)');

  await page.getByRole('link', { name: 'System health' }).click();
  await expect(page.getByRole('region', { name: 'Database' }).getByText('Connected')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Background worker' })).toContainText(
    'Not running',
  );
  await expectAccessible(page, 'system health');

  // Logging out ends the session; the device stays registered.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
});

test('a code made on the Devices page registers a waiter phone with waiter-only areas', async ({
  page,
  browser,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[1] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Devices' }).click();
  await page.getByLabel('Device name').fill('Sara phone');
  await page.getByLabel('Owned by').selectOption('personal');
  await page.getByRole('button', { name: 'Create code' }).click();
  const code = (await page.getByTestId('registration-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^\d{8}$/);
  await expectAccessible(page, 'devices');

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phone.newPage();
  try {
    await registerDevice(phonePage, code);
    await logIn(phonePage, 'sara', s.password);
    expect(await navLabels(phonePage)).toEqual(['Floor', 'Approvals', 'Pickup']);
    await expect(phonePage.getByText('Sara · Waiter')).toBeVisible();
    await expectAccessible(phonePage, 'waiter shell on a phone');

    await phonePage.goto('/devices');
    await expect(phonePage.getByText('Your role does not include this area.')).toBeVisible();

    // The used code cannot register another device.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/register');
    await otherPage.getByLabel('Registration code').fill(code);
    await otherPage.getByRole('button', { name: 'Register device' }).click();
    await expect(otherPage.getByRole('alert')).toBeVisible();
    await expect(otherPage).toHaveURL(/\/register$/);
    await other.close();
  } finally {
    await phone.close();
  }

  await page.reload();
  await expect(page.getByRole('cell', { name: 'Sara phone' })).toBeVisible();
});

test('PIN switch on a shared device, by keyboard, offers recent users only', async ({ page }) => {
  const s = shop();
  const sara = s.staff.find((u) => u.username === 'sara');
  const ali = s.staff.find((u) => u.username === 'ali');
  if (!sara || !ali) throw new Error('seed users missing');
  await registerDevice(page, s.codes[2] ?? '');
  await logIn(page, s.owner.username, s.owner.password);

  await page.getByRole('link', { name: 'Switch user' }).click();
  await expect(page.getByRole('heading', { name: 'Who is using this device?' })).toBeVisible();
  await expectAccessible(page, 'PIN switch');
  await page.getByLabel('Username').fill('sara');
  await page.getByRole('group', { name: /PIN for/ }).focus();
  await page.keyboard.type(sara.pin);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Sara · Waiter')).toBeVisible();
  expect(await navLabels(page)).toEqual(['Floor', 'Approvals', 'Pickup']);

  // Ali takes over with a wrong PIN first: refused, digits cleared, then the right one.
  await page.getByRole('link', { name: 'Switch user' }).click();
  await expect(page.getByRole('button', { name: 'Sara' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Owner' })).toHaveCount(0); // owners use passwords
  await page.getByRole('button', { name: 'Someone else' }).click();
  await page.getByLabel('Username').fill('ali');
  for (const d of '9999') await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Enter' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('status', { name: /0 of up to 6/ })).toBeVisible();
  for (const d of ali.pin) await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: 'Enter' }).click();
  await expect(page.getByText('Ali · Cashier')).toBeVisible();
  expect(await navLabels(page)).toContain('Bills & payments');
});

test('the connection banner pauses writes until the screen is up to date', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[3] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Devices' }).click();
  await page.getByLabel('Device name').fill('Tablet 3');
  const create = page.getByRole('button', { name: 'Create code' });
  await expect(create).toBeEnabled();

  // Live updates cut: "Reconnecting…", and writes are disabled.
  await page.route('**/api/staff/v1/events', (route) => route.abort());
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
  await page.getByLabel('Device name').fill('Tablet 3');
  await expect(create).toBeDisabled();
  await expectAccessible(page, 'reconnecting banner');

  // The server says it is starting (e.g. after a power cut): its own message.
  await page.route('**/health/ready', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'SERVER_STARTING', detail: 'Checking saved data.' }),
    }),
  );
  await expect(page.getByRole('status').filter({ hasText: 'Server starting…' })).toBeVisible();

  // Everything back: the banner goes and writes are allowed again.
  await page.unroute('**/health/ready');
  await page.unroute('**/api/staff/v1/events');
  await expect(
    page.getByRole('status').filter({ hasText: /Reconnecting|Server starting/ }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(create).toBeEnabled();
});
