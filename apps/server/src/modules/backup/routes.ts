/**
 * Backup routes (API.md §5.16; Phase 7 step 7.2): the owner's off-site bucket (`backup.manage`,
 * owner only by policy). The secret key goes in and never comes out.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../platform/db/tx.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { readOffsite, saveOffsite, testOffsite, type OffsiteDeps } from './offsite.ts';

const offsiteInput = z
  .object({
    endpoint: z
      .string()
      .trim()
      .regex(
        /^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/,
        'https://<host>, e.g. https://s3.eu-central-003.backblazeb2.com',
      ),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,40}$/, 'e.g. eu-central-003 or auto'),
    bucket: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'the bucket name'),
    prefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._/-]{0,100}$/)
      .default('coffee-lounge/'),
    accessKeyId: z.string().trim().min(4).max(128),
    secretAccessKey: z.string().min(8).max(200).optional(),
    expectedVersion: z.number().int().optional(),
  })
  .strict();

export async function backupRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; offsite: OffsiteDeps },
): Promise<void> {
  const { pool } = options;
  const who = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
      userId: auth.user.id,
    };
  };
  const manage = { config: { permission: 'backup.manage' } };
  app.get('/backup/offsite', manage, async () => readOffsite(pool));
  app.put('/backup/offsite', manage, async (request) => {
    const body = parseInput(offsiteInput, request.body);
    return withTransaction(pool, (tx) => saveOffsite(tx, who(request), options.offsite, body));
  });
  app.post('/backup/offsite/test', manage, async () => {
    await testOffsite(pool, options.offsite);
    return { ok: true };
  });
}
