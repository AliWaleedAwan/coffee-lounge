/**
 * Phase 5 step 5.4 on screen (AT-106): the owner registers the espresso machine, moves it,
 * records a service and finally disposes of it; each step is in its history, and a
 * disposed asset offers no more changes.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

test('an asset from registration to disposal, all in its history', async ({ page }) => {
  const s = shop();
  await registerDevice(page, s.codes[27] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Assets' }).click();
  await expect(page.getByRole('heading', { name: 'Assets', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Register an asset' }).click();
  const form = page.getByRole('form', { name: 'Register an asset' });
  await form.getByLabel('Tag (empty: next AST number)').fill('ESP-01');
  await form.getByLabel('Name').fill('Espresso machine');
  await form.getByLabel('Category').fill('Coffee equipment');
  await form.getByLabel('Where').fill('Bar');
  await form.getByLabel('Condition').selectOption({ label: 'Good' });
  await form.getByLabel('Price (Rs)').fill('850000');
  await expectAccessible(page, 'register asset');
  await form.getByRole('button', { name: 'Register' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Registered ESP-01.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ESP-01 · Espresso machine' })).toBeVisible();
  const history = page.getByRole('list', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('Registered as ESP-01');

  await page.getByRole('button', { name: 'Change details' }).click();
  const edit = page.getByRole('form', { name: 'Change details' });
  await edit.getByLabel('Where').fill('Back bar');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(history).toContainText('Moved from Bar to Back bar');

  await page.getByRole('button', { name: 'Record maintenance' }).click();
  const service = page.getByRole('form', { name: 'Record maintenance' });
  await service.getByLabel('What was done').fill('Group heads descaled');
  await service.getByLabel('Cost (Rs)').fill('6000');
  await service.getByRole('button', { name: 'Record maintenance' }).click();
  await expect(history).toContainText('Maintenance: Group heads descaled · Rs 6000');
  await expect(page.getByRole('table', { name: 'Maintenance' })).toContainText(
    'Group heads descaled',
  );
  await expectAccessible(page, 'asset detail');

  await page.getByRole('button', { name: 'Dispose of it' }).click();
  const dispose = page.getByRole('form', { name: 'Dispose of ESP-01' });
  await dispose.getByLabel('How').selectOption({ label: 'Sold' });
  await dispose.getByLabel('Why').fill('Replaced by a new machine');
  await dispose.getByRole('button', { name: 'Dispose of ESP-01' }).click();
  await expect(history).toContainText('Disposed: Sold · Replaced by a new machine');
  await expect(history.getByRole('listitem')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Change details' })).toHaveCount(0);

  await page.getByLabel('Status').selectOption({ label: 'Disposed' });
  await expect(
    page.getByRole('table', { name: 'Assets' }).getByRole('row', { name: /ESP-01/ }),
  ).toContainText('Disposed');
});
