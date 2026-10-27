/**
 * Owner settings on the staff API (API.md §5.9): thresholds, business hours and branding.
 * Every change sends the version it was made against and is audited (AT-130).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../platform/db/tx.ts';
import { parseInput } from '../../platform/validation.ts';
import type { Who } from '../catalog/index.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { listSettings, readBranding, updateBranding, updateSetting } from './service.ts';

function whoOf(request: FastifyRequest): Who {
  const auth = authOf(request);
  const facts = factsOf(request);
  return {
    actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
    correlationId: facts.correlationId,
    ...(facts.ip ? { ip: facts.ip } : {}),
  };
}

const expectedVersion = z.number().int().min(1);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

export async function settingsRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool },
): Promise<void> {
  const { pool } = options;

  // Every signed-in screen shows the shop's name in its colour.
  app.get('/branding', async () => {
    const b = await readBranding(pool);
    return { shopName: b.shopName, primary: b.primary };
  });

  app.get('/settings', { config: { permission: 'settings.manage' } }, async () =>
    listSettings(pool),
  );

  app.patch('/settings/:key', { config: { permission: 'settings.manage' } }, async (request) => {
    const { key } = parseInput(
      z.object({ key: z.string().regex(/^[a-z_]+\.[a-z_]+$/) }),
      request.params,
    );
    const body = parseInput(
      z.object({ value: z.unknown(), expectedVersion }).strict(),
      request.body,
    );
    const permissions = authOf(request).permissions;
    return withTransaction(pool, (tx) =>
      updateSetting(tx, whoOf(request), key, body, (p) => permissions.has(p)),
    );
  });

  app.put('/settings/branding', { config: { permission: 'settings.manage' } }, async (request) => {
    const body = parseInput(
      z
        .object({
          expectedVersion,
          shopName: z.string().trim().min(1).max(40),
          addressLine: optionalText(80),
          phone: optionalText(30),
          footer: z.string().trim().max(80),
          primary: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #6B4435'),
        })
        .strict(),
      request.body,
    );
    return withTransaction(pool, (tx) => updateBranding(tx, whoOf(request), body));
  });
}
