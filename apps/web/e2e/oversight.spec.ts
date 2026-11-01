/**
 * Phase 5 step 5.5 on screen: the owner checks what the cashier may do and where each
 * permission comes from, denies one with an override and sees it gone (AT-38), looks at
 * the manager role's grants, finds the change in the audit log with its reason and before
 * and after (AT-95), then removes the override again. Accessibility on each screen (AT-86).
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('users & roles, the effective-permission preview and the audit log', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[28] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Users & roles' }).click();
  await expect(page.getByRole('heading', { name: 'Users & roles', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Open Ali' }).click();
  const person = page.getByRole('region', { name: 'Ali (ali)' });
  const effective = person.getByRole('table', { name: 'Effective permissions' });
  await expect(effective.getByRole('row', { name: /payments\.collect/ })).toContainText(
    'role Cashier',
  );
  await expect(effective.getByRole('row', { name: /payments\.refund_request/ })).toBeVisible();
  await expectAccessible(page, 'users');

  const add = person.getByRole('form', { name: 'Add an override' });
  await add.getByLabel('Permission').selectOption('payments.refund_request');
  await add.getByLabel('Effect').selectOption('deny');
  await add.getByLabel('Why').fill('Refunds paused for this cashier');
  await add.getByRole('button', { name: 'Add override' }).click();
  await expect(person.getByRole('status')).toContainText('Denied payments.refund_request for Ali.');
  await expect(person.getByRole('list', { name: 'Overrides' })).toContainText(
    'Refunds paused for this cashier',
  );
  await expect(effective.getByRole('row', { name: /payments\.refund_request/ })).toHaveCount(0);

  await page.getByRole('tab', { name: 'Roles' }).click();
  await page.getByLabel('Role', { exact: true }).selectOption({ label: 'Manager' });
  // Plain words, in groups; technical names only on request; sensitive ones can be given too.
  await expect(page.getByText('roles.manage')).toHaveCount(0);
  await page.getByText('People & security').click();
  const delegate = page.getByRole('checkbox', { name: /Change what roles and people may do/ });
  await expect(delegate).toBeEnabled();
  await expect(page.locator('.perm-row', { hasText: 'Change what roles' })).toContainText(
    'Sensitive',
  );
  await page.getByLabel('Show technical names').check();
  await expect(page.getByText('roles.manage')).toBeVisible();
  await expectAccessible(page, 'roles');

  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await page.getByLabel('Action', { exact: true }).selectOption('permission.override_set');
  const row = page
    .getByRole('table', { name: 'Audit log' })
    .getByRole('row', { name: /permission\.override_set/ })
    .first();
  await expect(row).toContainText('Owner');
  await expect(row).toContainText('Refunds paused for this cashier');
  await row.getByRole('button', { name: /Show/ }).click();
  await expect(page.getByText('"payments.refund_request": "deny"')).toBeVisible();
  await expectAccessible(page, 'audit log');

  // Back as it was for the journeys after this one.
  await page.getByRole('link', { name: 'Users & roles' }).click();
  await page.getByRole('button', { name: 'Open Ali' }).click();
  await page.getByRole('button', { name: 'Remove override of payments.refund_request' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Ali (ali)' })
      .getByRole('table', { name: 'Effective permissions' })
      .getByRole('row', {
        name: /payments\.refund_request/,
      }),
  ).toBeVisible();
});
