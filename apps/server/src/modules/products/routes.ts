/**
 * New product from a scan (Phase 8 step 8.1; API.md §5.11b): in one transaction the inventory
 * item, its barcode, a menu item with one size, a one-to-one recipe and stock tracking, so
 * selling one takes one off stock. Whoever may not set prices saves it not on sale (P8-3).
 */
import { Decimal } from '@cl/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { changePrice, createItemIn, updateItem } from '../catalog/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import {
  activateRecipe,
  addBarcodeIn,
  createInventoryItem,
  createRecipeDraft,
  postOpeningBalance,
  reevaluateAlerts,
  setStockMode,
} from '../stock/index.ts';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction } from '../../platform/db/tx.ts';
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
  const id = z.object({ id: z.string().regex(/^\d{1,18}$/) }).strict();
  const whoOf = (request: FastifyRequest) => {
    const auth = authOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: factsOf(request).correlationId,
    };
  };
  /** The menu size that sells this item one for one, if there is one (recipe, even a draft). */
  const soldAs = async (itemId: string) => {
    const { rows } = await pool.query<{
      menuItemId: string;
      itemVersion: number;
      variantId: string;
      variantVersion: number;
      name: string;
      price: string;
      onSale: boolean;
    }>(
      `SELECT mi.id::text AS "menuItemId", mi.version AS "itemVersion", v.id::text AS "variantId",
              v.version AS "variantVersion", mi.name, v.price::text AS price, mi.is_active AS "onSale"
         FROM cl.recipe_components c
         JOIN cl.recipe_versions rv ON rv.id = c.recipe_version_id AND rv.status <> 'retired'
         JOIN cl.menu_variants v ON v.id = rv.variant_id AND v.archived_at IS NULL
         JOIN cl.menu_items mi ON mi.id = v.item_id AND mi.archived_at IS NULL
        WHERE c.inventory_item_id = $1
          AND (SELECT count(*) FROM cl.recipe_components o WHERE o.recipe_version_id = rv.id) = 1
        ORDER BY rv.id DESC LIMIT 1`,
      [itemId],
    );
    return rows[0] ?? null;
  };

  /** Scan to sell (step 8.3): the size a barcode sells. Packs hold many, so they are refused. */
  app.get('/products/sell-scan', { config: { permission: 'orders.create' } }, async (request) => {
    const { code } = parseInput(
      z.object({ code: z.string().regex(/^[!-~]{1,64}$/) }).strict(),
      request.query,
    );
    const { rows } = await pool.query<{ item_id: string; pack: boolean }>(
      `SELECT item_id::text, pack_size_id IS NOT NULL AS pack FROM cl.barcodes
        WHERE code = $1 AND is_active`,
      [code],
    );
    const hit = rows[0];
    if (!hit) return { variantId: null, problem: `Barcode ${code} is not known` };
    if (hit.pack)
      return { variantId: null, problem: 'That code is for a whole pack: scan one piece' };
    const sold = await soldAs(hit.item_id);
    return sold?.onSale
      ? { variantId: sold.variantId, problem: null }
      : { variantId: null, problem: `Barcode ${code}: this product is not on sale` };
  });

  app.get(
    '/products/by-item/:id',
    { config: { permission: 'inventory.read' } },
    async (request) => ({ soldAs: await soldAs(parseInput(id, request.params).id) }),
  );

  /** The selling price, from the item's card: this also puts a saved product on sale (P8-3). */
  app.post(
    '/products/by-item/:id/price',
    { config: { permission: 'menu.price_change' } },
    async (request) => {
      const itemId = parseInput(id, request.params).id;
      const input = parseInput(
        z.object({ price: amount, reason: z.string().trim().min(3).max(200) }).strict(),
        request.body,
      );
      const sold = await soldAs(itemId);
      if (!sold) throw new AppError('NOT_FOUND', 'This item is not sold on the menu');
      const who = whoOf(request);
      await changePrice(pool, who, sold.variantId, {
        expectedVersion: sold.variantVersion,
        price: input.price,
        reason: input.reason,
      });
      if (!sold.onSale) {
        await updateItem(pool, who, sold.menuItemId, {
          expectedVersion: sold.itemVersion,
          isActive: true,
        });
      }
      return { soldAs: await soldAs(itemId) };
    },
  );

  /** A wrong date on a delivery: corrected with a reason, kept in the audit log. */
  app.post(
    '/inventory/lots/:id/expiry',
    { config: { permission: 'inventory.items_manage' } },
    async (request) => {
      const lotId = parseInput(id, request.params).id;
      const input = parseInput(
        z
          .object({
            expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            reason: z.string().trim().min(3).max(200),
          })
          .strict(),
        request.body,
      );
      return withTransaction(pool, async (tx) => {
        const { rows } = await tx.query<{ item_id: string; before: string | null }>(
          `SELECT item_id::text, expiry_date::text AS before FROM cl.inventory_lots
            WHERE id = $1 FOR UPDATE`,
          [lotId],
        );
        const lot = rows[0];
        if (!lot) throw new AppError('NOT_FOUND', 'No such lot');
        await tx.query('UPDATE cl.inventory_lots SET expiry_date = $2 WHERE id = $1', [
          lotId,
          input.expiryDate,
        ]);
        await writeAudit(tx, whoOf(request), {
          action: 'stock.lot.expiry_corrected',
          entityType: 'inventory_lot',
          entityId: lotId,
          before: { expiryDate: lot.before },
          after: { expiryDate: input.expiryDate },
          reason: input.reason,
        });
        await reevaluateAlerts(tx, lot.item_id);
        return { id: lotId };
      });
    },
  );

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
          // Tracking needs a counted quantity. Without one the recipe stays a draft, to activate
          // on Menu → Recipes once stock has been received.
          if (input.opening) {
            await activateRecipe(tx, who, draft.id);
            await setStockMode(tx, who, variantId, 'recipe');
          }
          if (!onSale) {
            await tx.query('UPDATE cl.menu_items SET is_active = false WHERE id = $1', [menu.id]);
          }
          return { status: 201, body: { itemId, menuItemId: menu.id, variantId, onSale } };
        },
      );
    },
  );
}
