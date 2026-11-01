/**
 * New product from a scan (Phase 8 step 8.1; API.md §5.11b): in one transaction the inventory
 * item, its barcode, a menu item with one size, a one-to-one recipe and stock tracking, so
 * selling one takes one off stock. Whoever may not set prices saves it not on sale (P8-3).
 */
import { Decimal } from '@cl/shared';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { createItemIn } from '../catalog/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import {
  activateRecipe,
  addBarcodeIn,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  setStockMode,
} from '../stock/index.ts';
import { AppError } from '../../platform/errors.ts';
import { handleCommand } from '../../platform/idempotency.ts';
import { businessDateOf } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';

const amount = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'rupees, e.g. 200');
const body = z
  .object({
    barcode: z.string().regex(/^[!-~]{1,32}$/, 'a barcode'),
    name: z.string().trim().min(1).max(80),
    categoryId: z.string().regex(/^\d{1,18}$/),
    sku: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
      .optional(),
    baseUom: z.enum(['pcs', 'g', 'ml']).optional(),
    price: amount.optional(),
    lowThreshold: z
      .string()
      .regex(/^\d{1,10}(\.\d{1,4})?$/)
      .optional(),
    trackExpiry: z.boolean().optional(),
    opening: z
      .object({
        qty: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/),
        unitCost: amount,
        expiryDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function productRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());

  app.post(
    '/products',
    { config: { permission: 'inventory.items_manage' } },
    async (request, reply) => {
      const input = parseInput(body, request.body);
      const auth = authOf(request);
      if (
        input.opening &&
        !auth.permissions.has('inventory.opening_balance') &&
        !auth.permissions.has('inventory.receive')
      )
        throw new AppError('FORBIDDEN', 'You cannot enter stock on hand');
      const onSale = input.price !== undefined && auth.permissions.has('menu.price_change');
      const who = {
        actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
        correlationId: factsOf(request).correlationId,
      };
      return handleCommand(
        pool,
        request,
        reply,
        { scope: 'product.create', actorRef: `user:${auth.user.id}`, payload: input },
        async (tx) => {
          const trackExpiry = input.trackExpiry ?? false;
          const { id: itemId } = await createInventoryItem(tx, who, {
            sku: input.sku ?? `BC-${input.barcode.replace(/[^A-Za-z0-9]/g, '')}`,
            name: input.name,
            baseUom: input.baseUom ?? 'pcs',
            trackLots: trackExpiry,
            trackExpiry,
            ...(input.lowThreshold ? { lowThreshold: input.lowThreshold } : {}),
          });
          await addBarcodeIn(tx, who, itemId, { code: input.barcode });
          if (input.opening) {
            await postOpeningBalance(
              tx,
              { actorUserId: auth.user.id, businessDate: await businessDateOf(tx, now()) },
              who,
              {
                itemId,
                qty: new Decimal(input.opening.qty),
                unitCost: new Decimal(input.opening.unitCost),
                ...(input.opening.expiryDate ? { expiryDate: input.opening.expiryDate } : {}),
              },
            );
          }
          const menu = await createItemIn(tx, who, {
            categoryId: input.categoryId,
            name: input.name,
            variants: [{ name: 'Regular', price: onSale ? (input.price ?? '0') : '0' }],
          });
          const variantId = menu.variantIds[0] ?? '';
          const draft = await createRecipeDraft(tx, {
            variantId,
            components: [{ itemId, qtyBase: '1', wasteFactor: '0' }],
          });
          await activateRecipe(tx, who, draft.id);
          // Without a starting quantity there is nothing to count yet: tracking starts when the
          // first delivery does (Receive stock, "start stock control").
          if (input.opening) await setStockMode(tx, who, variantId, 'recipe');
          if (!onSale) {
            await tx.query('UPDATE cl.menu_items SET is_active = false WHERE id = $1', [menu.id]);
          }
          return { status: 201, body: { itemId, menuItemId: menu.id, variantId, onSale } };
        },
      );
    },
  );
}
