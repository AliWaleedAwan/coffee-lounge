/**
 * System routes (API.md §5.7): the health page data, and the backup banner for every device. Diagnostics only; no business data.
 * When the database is down this route cannot authenticate the caller and answers
 * 503 DATABASE_UNAVAILABLE; the page then shows that state from public /health/ready.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../../platform/audit.ts';
import { withTransaction } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { authOf, factsOf } from '../identity/index.ts';
import type { HealthMonitor } from '../../platform/health.ts';

export interface SystemRouteOptions {
  health: HealthMonitor;
  pool: pg.Pool;
  /** The updater's mailbox (installed shops only): its status, and the owner's request. */
  updateDir?: string | undefined;
}

interface AgentStatus {
  current?: string;
  available?: string | null;
  state?: string;
  message?: string | null;
}

export async function systemRoutes(
  app: FastifyInstance,
  options: SystemRouteOptions,
): Promise<void> {
  app.get('/system/health', { config: { permission: 'system.health' } }, async () =>
    options.health.system(),
  );
  const readAgent = async (dir: string): Promise<AgentStatus> => {
    try {
      return JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as AgentStatus;
    } catch {
      return {}; // the updater has not run yet
    }
  };
  const requested = async (dir: string): Promise<boolean> => {
    try {
      await readFile(join(dir, 'request'));
      return true;
    } catch {
      return false;
    }
  };

  app.get('/system/update', { config: { permission: 'system.update' } }, async () => {
    const dir = options.updateDir;
    if (!dir) {
      return { supported: false, current: null, available: null, state: 'idle', message: null };
    }
    const agent = await readAgent(dir);
    return {
      supported: true,
      current: agent.current ?? null,
      available: agent.available ?? null,
      state: (await requested(dir)) ? 'requested' : (agent.state ?? 'idle'),
      message: agent.message ?? null,
    };
  });

  // Only says "please": the updater decides what, if anything, is safe to install.
  app.post(
    '/system/update',
    { config: { permission: 'system.update' } },
    async (request, reply) => {
      const dir = options.updateDir;
      if (!dir) throw new AppError('VALIDATION_FAILED', 'Updates work only on an installed shop');
      if (!(await readAgent(dir)).available) {
        throw new AppError('VALIDATION_FAILED', 'No new version is ready');
      }
      const auth = authOf(request);
      const facts = factsOf(request);
      await withTransaction(options.pool, (tx) =>
        writeAudit(
          tx,
          {
            actor: { kind: 'user', userId: auth.user.id, deviceId: auth.device.id },
            correlationId: facts.correlationId,
            ...(facts.ip ? { ip: facts.ip } : {}),
          },
          { action: 'system.update_requested', entityType: 'user', entityId: auth.user.id },
        ),
      );
      await writeFile(join(dir, 'request'), '');
      return reply.code(202).send();
    },
  );

  // Every signed-in device shows a backup problem (AT-80): the problem and its words only.
  app.get('/system/backup-status', async () => options.health.backupBanner());
}
