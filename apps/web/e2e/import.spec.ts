/**
 * Phase 4 step 4.9 on screen (AT-82): the owner previews an items file with problems
 * (an example SKU, a bad unit), sees each problem with its row, imports nothing; fixes the
 * file, previews what it will create, imports it; importing it again changes nothing.
 */
import { expect, test } from '@playwright/test';
import { expectAccessible, logIn, registerDevice, shop } from './support.ts';

const HEADER =
  'sku,name,category,base_uom,track_lots,track_expiry,low_threshold,overstock_threshold,near_expiry_days';

test('import a template: problems by row, then all or nothing, then a re-import that changes nothing', async ({
  page,
}) => {
  const s = shop();
  await registerDevice(page, s.codes[23] ?? '');
  await logIn(page, s.owner.username, s.owner.password);
  await page.getByRole('link', { name: 'Inventory' }).click();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page
    .getByLabel('Template', { exact: true })
    .selectOption({ label: '1. Inventory items (01_inventory_items.csv)' });
  await expect(page.getByText(HEADER)).toBeVisible();

  const upload = async (rows: string[]) => {
    await page.getByLabel('CSV file').setInputFiles({
      name: '01_inventory_items.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${HEADER}\n${rows.join('\n')}\n`),
    });
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
  };

  await upload([
    'IMP-MILK,Imported milk,Dairy,ml,yes,yes,5000,60000,2',
    'EX-BEANS-HOUSE,Espresso beans,Coffee,g,no,no,2000,20000,',
    'IMP-CUPS,Imported cups,Packaging,boxes,no,no,100,2000,',
  ]);
  const problems = page.getByRole('table', { name: 'Problems' });
  await expect(page.getByRole('alert').filter({ hasText: '2 problems' })).toBeVisible();
  await expect(problems.getByRole('row', { name: /3 sku EX- is an example SKU/ })).toBeVisible();
  await expect(problems.getByRole('row', { name: /4 base_uom g, ml or pcs/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await expectAccessible(page, 'import problems');

  await upload([
    'IMP-MILK,Imported milk,Dairy,ml,yes,yes,5000,60000,2',
    'IMP-CUPS,Imported cups,Packaging,pcs,no,no,100,2000,',
  ]);
  await expect(page.getByText('2 rows, no problems: 2 new, 0 changed, 0 unchanged.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'What the import does' })).toContainText(
    'Item IMP-MILK Imported milk',
  );
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(
    page.getByText('Imported 01_inventory_items.csv: 2 new, 0 changed, 0 unchanged.'),
  ).toBeVisible();

  // The same file again: nothing new, nothing changed.
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.getByText('2 rows, no problems: 0 new, 0 changed, 2 unchanged.')).toBeVisible();
  await page.getByRole('tab', { name: 'Items' }).click();
  await page.getByLabel('Scan or type barcode / name').fill('IMP-');
  await expect(page.getByRole('row', { name: /Imported milk/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /Imported cups/ })).toHaveCount(1);
});
