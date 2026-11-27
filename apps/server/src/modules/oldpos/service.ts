/**
 * One import of the old POS's export (scripts/old-pos/export-old-pos.ps1): its products, its
 * customers and its sales history, in the caller's transaction. Safe to repeat. The file is
 * checked as a whole first, so a damaged one changes nothing.
 */
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Who } from '../catalog/index.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { applyMenuPlan, type MenuImportResult } from './apply.ts';
import { applyCustomers, applyHistory, planCustomers } from './history.ts';
import { planMenu, type MenuPlan } from './menu.ts';

const int = z.number().int().min(-2_000_000_000).max(2_000_000_000);
const str = z.string().max(400);
const at = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

const fileSchema = z.object({
  source: z.string().max(200).optional(),
  exportedAt: z.string().max(60).optional(),
  products: z
    .array(
      z.object({
        name: str,
        barcode: str,
        price: int,
        inStock: z.boolean(),
        category: str,
      }),
    )
    .max(20_000),
  bills: z
    .array(
      z.object({
        id: int,
        billNo: int,
        at,
        total: int,
        discount: int,
        payable: int,
        paid: int,
        balance: int,
        status: str,
        customerName: str,
        mobile: str,
        location: str,
        cashier: str,
      }),
    )
    .max(2_000_000)
    .optional(),
  lines: z
    .array(
      z.object({
        id: int,
        billNo: int,
        at,
        barcode: str,
        name: str,
        category: str,
        qty: int,
        price: int,
        amount: int,
        status: str,
      }),
    )
    .max(5_000_000)
    .optional(),
});
export type OldPosFile = z.infer<typeof fileSchema>;

export interface OldPosResult {
  menu: MenuImportResult;
  skipped: MenuPlan['skipped'];
  customers: { created: number; updated: number };
  history: { bills: number; lines: number };
}

/** The export as sent: gzip or plain JSON, from the screen or the command line. */
export function readOldPosFile(bytes: Buffer): OldPosFile {
  let json: string;
  try {
    const raw =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes, { maxOutputLength: 400_000_000 })
        : bytes;
    json = raw.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    throw new AppError('VALIDATION_FAILED', 'This file is damaged: export it again.');
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'This is not an old POS export file.');
  }
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This is not an old POS export file, or it is from a different version of the export.',
    );
  }
  return parsed.data;
}

export async function importOldPos(
  tx: Tx,
  who: Who,
  file: OldPosFile,
  timeZone: string,
): Promise<OldPosResult> {
  const plan = planMenu(file.products);
  const menu = await applyMenuPlan(tx, who, plan);
  const bills = file.bills ?? [];
  const customers = await applyCustomers(tx, planCustomers(bills));
  const history = await applyHistory(tx, { bills, lines: file.lines ?? [] }, timeZone);
  await writeAudit(tx, who, {
    action: 'oldpos.import',
    entityType: 'old_pos',
    entityId: '0',
    after: { source: file.source ?? null, customers, history, skipped: plan.skipped.length },
  });
  return { menu, skipped: plan.skipped, customers, history };
}
