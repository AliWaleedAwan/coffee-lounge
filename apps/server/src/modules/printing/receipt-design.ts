/**
 * The owner's receipt design (Settings → Receipt design): text blocks above and below the
 * bill and a few switches, kept as `layout` in the active receipt template (0013) next to
 * the shop name and contact line the branding form edits. The preview is the real
 * renderer's output on a sample bill at the receipt printer's width, so the screen shows
 * what the paper will. Without a saved layout the standard receipt prints, unchanged.
 */
import { z } from 'zod';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { composeReceipt, type ReceiptData, type ReceiptLayout } from './documents.ts';
import type { PreviewLine } from './escpos.ts';

const size = z.enum(['normal', 'wide', 'big']);
export const receiptBlock = z
  .object({
    text: z.string().max(400),
    align: z.enum(['left', 'center', 'right']),
    bold: z.boolean(),
    size,
  })
  .strict();
export const receiptLayout = z
  .object({
    header: z.array(receiptBlock).max(10),
    footer: z.array(receiptBlock).max(10),
    shopNameSize: size,
    showContact: z.boolean(),
    showCashier: z.boolean(),
  })
  .strict();

const definition = z.object({
  shopName: z.string().min(1),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
  footer: z.string(),
  layout: receiptLayout.optional(),
});

/** What the standard receipt prints, as a layout: where an owner starts designing. */
export function standardLayout(footer: string): ReceiptLayout {
  return {
    header: [],
    footer: footer ? [{ text: footer, align: 'center', bold: false, size: 'normal' }] : [],
    shopNameSize: 'wide',
    showContact: true,
    showCashier: true,
  };
}

async function receiptWidth(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ chars_per_line: number }>(
    // The till's receipt printer; else any active printer (one at launch); else 80 mm.
    `SELECT p.chars_per_line FROM cl.printers p
      WHERE p.is_active
      ORDER BY EXISTS (SELECT 1 FROM cl.tills t WHERE t.receipt_printer_id = p.id) DESC, p.id
      LIMIT 1`,
  );
  return rows[0]?.chars_per_line ?? 48;
}

export async function readReceiptDesign(db: Queryable) {
  const { rows } = await db.query<{ definition: unknown; version: number }>(
    `SELECT definition, version FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active`,
  );
  const d = definition.parse(rows[0]?.definition);
  return {
    version: rows[0]?.version ?? 1,
    saved: d.layout !== undefined,
    layout: d.layout ?? standardLayout(d.footer),
    shop: { name: d.shopName, addressLine: d.addressLine, phone: d.phone },
    width: await receiptWidth(db),
  };
}

/** A made-up bill that shows every part of the receipt. */
function sample(shop: ReceiptData['shop'], layout: ReceiptLayout): ReceiptData {
  return {
    shop,
    invoiceNo: 'INV-2026-000123',
    where: 'Table: T5',
    at: new Date(),
    cashier: 'Cashier',
    lines: [
      {
        qty: 2,
        name: 'Tikka Pizza Medium',
        amount: '2260.00',
        modifiers: [{ name: 'Extra Topping', amount: '150.00' }],
      },
      { qty: 1, name: 'Mint Margrita', amount: '150.00', modifiers: [] },
      { qty: 3, name: 'Naan', amount: '105.00', modifiers: [] },
    ],
    subtotal: '2665.00',
    discounts: [],
    rounding: '0.00',
    total: '2665.00',
    payments: [{ label: 'Cash', amount: '3000.00' }],
    change: '335.00',
    delivery: null,
    footer: '',
    layout,
  };
}

export async function previewReceipt(
  db: Queryable,
  layout: ReceiptLayout,
  timeZone: string,
): Promise<{ width: number; lines: PreviewLine[] }> {
  const design = await readReceiptDesign(db);
  const width = design.width;
  const doc = composeReceipt(sample(design.shop, layout), {
    width,
    canCut: false,
    copyNo: 1,
    timeZone,
  });
  return { width, lines: doc.preview() };
}

export async function saveReceiptDesign(
  tx: Tx,
  who: AuditContext,
  input: { expectedVersion: number; layout: ReceiptLayout | null },
) {
  const { rows } = await tx.query<{ id: string; definition: Record<string, unknown> }>(
    `SELECT id::text, definition FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active
       AND version = $1 FOR UPDATE`,
    [input.expectedVersion],
  );
  const template = rows[0];
  if (!template)
    throw new AppError(
      'STALE_STATE',
      'Someone changed the receipt meanwhile. Check it and try again.',
    );
  const { layout: before, ...rest } = template.definition;
  // null goes back to the standard receipt.
  const next = input.layout ? { ...rest, layout: input.layout } : rest;
  await tx.query('UPDATE cl.ticket_templates SET definition = $2 WHERE id = $1', [
    template.id,
    JSON.stringify(next),
  ]);
  await writeAudit(tx, who, {
    action: 'settings.receipt_design',
    entityType: 'setting',
    before: { layout: before ?? null },
    after: { layout: input.layout },
  });
  return readReceiptDesign(tx);
}
