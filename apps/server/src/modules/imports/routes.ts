/**
 * Template import (API.md §5.9; step 4.9). Anyone who reads inventory may open the
 * screen; each file then needs the permission the same change needs on screen. The CSV is
 * sent as text. Importing changes stock and money records, so it needs an
 * Idempotency-Key ([I]).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { handleCommand } from '../../platform/idempotency.ts';
import { parseInput } from '../../platform/validation.ts';
import { authOf, factsOf } from '../identity/index.ts';
import { applyImport, previewImport } from './service.ts';
import { TEMPLATES } from './templates.ts';

const body = z.object({ csv: z.string().min(1).max(1_500_000) }).strict();
const keyParam = (request: FastifyRequest) =>
  parseInput(
    z.object({ template: z.enum(TEMPLATES.map((t) => t.key) as [string, ...string[]]) }),
    request.params,
  ).template;

export async function importRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; now?: () => Date },
): Promise<void> {
  const { pool } = options;
  const now = options.now ?? (() => new Date());
  const who = (request: FastifyRequest) => {
    const auth = authOf(request);
    const facts = factsOf(request);
    return {
      actor: { kind: 'user' as const, userId: auth.user.id, deviceId: auth.device.id },
      correlationId: facts.correlationId,
      ...(facts.ip ? { ip: facts.ip } : {}),
    };
  };
  const can = (request: FastifyRequest) => (p: string) => authOf(request).permissions.has(p);
  const read = { config: { permission: 'inventory.read' }, bodyLimit: 2_000_000 };

  app.get('/imports/templates', { config: { permission: 'inventory.read' } }, async (request) => ({
    items: TEMPLATES.map((t) => ({
      key: t.key,
      file: t.file,
      title: t.title,
      columns: t.columns,
      permission: t.permission,
      allowed: can(request)(t.permission),
    })),
  }));

  app.post('/imports/:template/preview', read, async (request) => {
    const { csv } = parseInput(body, request.body);
    return previewImport(pool, who(request), can(request), keyParam(request), csv, now());
  });

  app.post('/imports/:template/apply', read, async (request, reply) => {
    const template = keyParam(request);
    const { csv } = parseInput(body, request.body);
    const auth = authOf(request);
    return handleCommand(
      pool,
      request,
      reply,
      { scope: `import.${template}`, actorRef: `user:${auth.user.id}`, payload: { csv } },
      async (tx) => ({
        status: 200,
        body: await applyImport(tx, who(request), can(request), template, csv, now()),
      }),
    );
  });
}
