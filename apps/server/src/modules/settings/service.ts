/**
 * Owner settings (DECISIONS.md §4, UI_UX.md "Settings", AT-130). Each editable setting has
 * a rule here; a change is checked, written with the row's version (a stale screen gets
 * 409), audited, and takes effect at once: the services read settings when they use them.
 *
 * The shop's time zone and business-day cutoff are shown but set at installation: moving
 * them would move every business date already written (D-22).
 */
import { brandColourProblem } from '@cl/shared';
import { z } from 'zod';
import type { Who } from '../catalog/index.ts';
import { writeAudit } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { publish } from '../../platform/outbox.ts';
import { readSetting, shopTimeZone } from '../../platform/settings.ts';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time like 08:00');
const minutes = (max: number) => z.number().int().min(1).max(max);

export const BUSINESS_HOURS = z.object({ opens: time, closes: time }).strict();

/** A short list the owner keeps: one to 30 names, each named once (any case). */
const nameList = z
  .array(z.string().trim().min(2, 'at least 2 characters each').max(60))
  .min(1, 'at least one')
  .max(30, 'at most 30')
  .refine(
    (names) => new Set(names.map((n) => n.toLowerCase())).size === names.length,
    'each name once',
  );

export interface SettingRule {
  label: string;
  group: 'Orders' | 'Tables' | 'Billing' | 'Stock' | 'Assets' | 'Privacy' | 'Shop';
  hint: string;
  schema: z.ZodType;
  editable: boolean;
  /** Money and control parameters: owner-only `settings.financial` (RBAC.md 🔒, RBAC review 5.6). */
  financial?: true;
}

export const SETTINGS: Readonly<Record<string, SettingRule>> = {
  'shop.timezone': {
    label: 'Time zone',
    group: 'Shop',
    hint: 'Set at installation',
    schema: z.string(),
    editable: false,
  },
  'shop.business_day_cutoff': {
    label: 'Business day starts at',
    group: 'Shop',
    hint: 'Set at installation: sales before this time count for the day before (D-22)',
    schema: time,
    editable: false,
  },
  'shop.business_hours': {
    label: 'Guests can order by QR',
    group: 'Shop',
    hint: 'Outside these hours guests can see the menu but not order; staff can always order. The same time twice means always open',
    schema: BUSINESS_HOURS,
    editable: true,
  },
  'orders.price_lock_minutes': {
    label: 'Price held for a sent order (minutes)',
    group: 'Orders',
    hint: 'A price that rises after a guest sent the order is honoured this long (D-08)',
    schema: minutes(240),
    editable: true,
  },
  'orders.escalation_minutes': {
    label: 'Waiting order goes to managers after (minutes)',
    group: 'Orders',
    hint: 'D-36',
    schema: minutes(60),
    editable: true,
  },
  'orders.takeaway_unpaid_expiry_minutes': {
    label: 'Unpaid counter-QR order cancels after (minutes)',
    group: 'Orders',
    hint: 'D-40',
    schema: minutes(240),
    editable: true,
  },
  'orders.uncollected_alert_minutes': {
    label: 'Alert when an item waits for pickup (minutes)',
    group: 'Orders',
    hint: 'D-33',
    schema: minutes(240),
    editable: true,
  },
  'orders.pickup_marks_served_dine_in': {
    label: 'Picked up means served at the table',
    group: 'Orders',
    hint: 'Turn off if waiters mark serving separately (D-33)',
    schema: z.boolean(),
    editable: true,
  },
  'sessions.stale_alert_hours': {
    label: 'Alert when a table is open longer than (hours)',
    group: 'Tables',
    hint: 'D-10',
    schema: z.number().int().min(1).max(24),
    editable: true,
  },
  'billing.cash_rounding_unit': {
    label: 'Round bills to',
    group: 'Billing',
    hint: 'D-16',
    schema: z.enum(['1.00', '5.00', '10.00']),
    editable: true,
    financial: true,
  },
  'inventory.count_variance_pct': {
    label: 'Stock count needs approval above (%)',
    group: 'Stock',
    hint: 'D-18',
    schema: z.number().min(0).max(100),
    editable: true,
    financial: true,
  },
  'inventory.count_variance_amount': {
    label: 'Stock count needs approval above (Rs)',
    group: 'Stock',
    hint: 'D-18',
    schema: z.string().regex(/^\d{1,9}\.\d{2}$/, 'an amount like 1000.00'),
    editable: true,
    financial: true,
  },
  'refunds.reasons': {
    label: 'Refund reasons offered',
    group: 'Billing',
    hint: 'One per line; the person refunding picks one and can add a note (step 5.2)',
    schema: nameList,
    editable: true,
  },
  'assets.categories': {
    label: 'Asset categories offered',
    group: 'Assets',
    hint: 'One per line; others typed on an asset are kept too',
    schema: nameList,
    editable: true,
  },
  'assets.locations': {
    label: 'Places offered for assets',
    group: 'Assets',
    hint: 'One per line',
    schema: nameList,
    editable: true,
  },
  'privacy.delivery_pii_retention_months': {
    label: 'Delivery customer details kept for (months)',
    group: 'Privacy',
    hint: 'Names, phones and addresses are removed after this (D-25)',
    schema: z.number().int().min(1).max(120),
    editable: true,
  },
};

export async function listSettings(db: Queryable) {
  const { rows } = await db.query<{
    key: string;
    value: unknown;
    version: number;
    updated_at: Date;
  }>('SELECT key, value, version, updated_at FROM cl.system_settings ORDER BY key');
  return {
    items: rows.flatMap((r) => {
      const rule = SETTINGS[r.key];
      if (!rule) return [];
      return [
        {
          key: r.key,
          value: r.value,
          version: r.version,
          label: rule.label,
          group: rule.group,
          hint: rule.hint,
          editable: rule.editable,
          financial: rule.financial === true,
          updatedAt: r.updated_at.toISOString(),
        },
      ];
    }),
    branding: await readBranding(db),
  };
}

export async function updateSetting(
  tx: Tx,
  who: Who,
  key: string,
  input: { value: unknown; expectedVersion: number },
  can: (permission: string) => boolean = () => false,
): Promise<{ key: string; version: number }> {
  const rule = SETTINGS[key];
  if (!rule?.editable) throw new AppError('NOT_FOUND', 'No such setting can be changed');
  if (rule.financial && !can('settings.financial')) {
    throw new AppError('FORBIDDEN', `${rule.label} is the owner’s to change (settings.financial)`);
  }
  const parsed = rule.schema.safeParse(input.value);
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${rule.label}: ${parsed.error.issues[0]?.message ?? 'not valid'}`,
    );
  }
  const { rows: before } = await tx.query<{ value: unknown }>(
    'SELECT value FROM cl.system_settings WHERE key = $1 FOR UPDATE',
    [key],
  );
  const { rows } = await tx.query<{ version: number }>(
    `UPDATE cl.system_settings SET value = $3, updated_by = $4 WHERE key = $1 AND version = $2
     RETURNING version`,
    [key, input.expectedVersion, JSON.stringify(parsed.data), who.actor.userId],
  );
  const version = rows[0]?.version;
  if (version === undefined) {
    throw new AppError(
      'STALE_STATE',
      'Someone changed this setting meanwhile. Check it and try again.',
    );
  }
  await writeAudit(tx, who, {
    action: 'settings.update',
    entityType: 'setting',
    after: { key, value: parsed.data },
    before: { key, value: before[0]?.value },
  });
  return { key, version };
}

// ---------------------------------------------------------------- branding (DEC-14)

const receiptWording = z.object({
  shopName: z.string().min(1),
  addressLine: z.string().nullable(),
  phone: z.string().nullable(),
  footer: z.string(),
});

/** The shop's name and brand colour, for every screen and the guest app. */
export async function readBranding(db: Queryable) {
  const { rows } = await db.query<{ definition: unknown; version: number }>(
    `SELECT definition, version FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active`,
  );
  const wording = receiptWording.parse(rows[0]?.definition);
  return {
    ...wording,
    primary: await readSetting(db, 'brand.primary', z.string()),
    version: rows[0]?.version ?? 1,
  };
}

export interface BrandingInput {
  expectedVersion: number;
  shopName: string;
  addressLine: string | null;
  phone: string | null;
  footer: string;
  primary: string;
}

/** Shop name and receipt wording (the receipt template) and the brand colour, together. */
export async function updateBranding(tx: Tx, who: Who, input: BrandingInput) {
  const problem = brandColourProblem(input.primary);
  if (problem)
    throw new AppError('VALIDATION_FAILED', `Brand colour: ${problem}`, { field: 'primary' });
  const { rows } = await tx.query<{ id: string; definition: Record<string, unknown> }>(
    `SELECT id::text, definition FROM cl.ticket_templates WHERE kind = 'receipt' AND is_active
       AND version = $1 FOR UPDATE`,
    [input.expectedVersion],
  );
  const template = rows[0];
  if (!template) {
    throw new AppError(
      'STALE_STATE',
      'Someone changed the branding meanwhile. Check it and try again.',
    );
  }
  const definition = {
    ...template.definition,
    shopName: input.shopName,
    addressLine: input.addressLine,
    phone: input.phone,
    footer: input.footer,
  };
  await tx.query('UPDATE cl.ticket_templates SET definition = $2 WHERE id = $1', [
    template.id,
    JSON.stringify(definition),
  ]);
  await tx.query(
    `UPDATE cl.system_settings SET value = $1, updated_by = $2 WHERE key = 'brand.primary'`,
    [JSON.stringify(input.primary.toUpperCase()), who.actor.userId],
  );
  await writeAudit(tx, who, {
    action: 'settings.branding',
    entityType: 'setting',
    before: template.definition,
    after: { ...definition, primary: input.primary.toUpperCase() },
  });
  await publish(tx, {
    type: 'settings.changed',
    entityType: 'setting',
    entityId: '0',
    topics: ['menu'],
  });
  return readBranding(tx);
}

// ---------------------------------------------------------------- business hours

/** Shop-local "HH:MM" of an instant. */
function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}

/**
 * Whether guests may order by QR now. Hours may pass midnight (opens 08:00, closes 01:00);
 * equal times mean always open.
 */
export async function guestOrderingOpen(
  db: Queryable,
  now: Date,
): Promise<{ open: boolean; opens: string; closes: string }> {
  const hours = await readSetting(db, 'shop.business_hours', BUSINESS_HOURS);
  if (hours.opens === hours.closes) return { open: true, ...hours };
  const t = localTime(now, await shopTimeZone(db));
  const open =
    hours.opens < hours.closes
      ? t >= hours.opens && t < hours.closes
      : t >= hours.opens || t < hours.closes;
  return { open, ...hours };
}
