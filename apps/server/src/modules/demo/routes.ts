/**
 * Demo routes (docs/phase-8/DEMO.md): who one can switch to, switching, and the one-time wipe.
 * All answer "not found" where no demo is loaded, so an ordinary shop has none of this.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { writeAudit } from '../../platform/audit.ts';
import { AppError } from '../../platform/errors.ts';
import { parseInput } from '../../platform/validation.ts';
import {
  authOf,
  deviceOf,
  factsOf,
  setSessionCookie,
  startDemoSession,
} from '../identity/index.ts';
import { demoPeople } from './service.ts';

const NO_DEMO = 'There is no demo data here';

export async function demoRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool; secureCookies: boolean },
): Promise<void> {
  const { pool, secureCookies } = options;

  app.get('/demo', { config: { auth: 'device' } }, async () => {
    const ids = await demoPeople(pool);
    if (!ids) return { active: false, people: [] };
    const { rows } = await pool.query<{ username: string; name: string; role: string }>(
      `SELECT u.username, u.display_name AS name, r.name AS role
         FROM cl.users u
         JOIN cl.user_roles ur ON ur.user_id = u.id
         JOIN cl.roles r ON r.id = ur.role_id
        WHERE u.id = ANY ($1::bigint[]) ORDER BY r.id, u.id`,
      [ids],
    );
    return { active: true, people: rows };
  });

  app.post('/demo/switch', { config: { auth: 'device' } }, async (request, reply) => {
    const body = parseInput(z.object({ username: z.string().max(60) }).strict(), request.body);
    const ids = await demoPeople(pool);
    if (!ids) throw new AppError('NOT_FOUND', NO_DEMO);
    const token = await startDemoSession(
      pool,
      deviceOf(request),
      body.username,
      ids,
      factsOf(request),
    );
    setSessionCookie(reply, token, secureCookies);
    return reply.code(204).send();
  });

  app.post('/demo/wipe', async (request, reply) => {
    const auth = authOf(request);
    if (!auth.user.isOwner)
      throw new AppError('FORBIDDEN', 'Only an owner can delete the demo data');
    parseInput(z.object({ confirm: z.literal('DELETE') }).strict(), request.body);
    if (!(await demoPeople(pool))) throw new AppError('NOT_FOUND', NO_DEMO);
    await pool.query('SELECT cl.wipe_demo_data()');
    // The person may have been made up: then the session went with them.
    const { rows } = await pool.query('SELECT 1 FROM cl.users WHERE id = $1', [auth.user.id]);
    await writeAudit(
      pool,
      {
        actor: rows[0] ? { kind: 'user', userId: auth.user.id } : { kind: 'system' },
        correlationId: factsOf(request).correlationId,
      },
      { action: 'demo.wiped', entityType: 'setting' },
    );
    return reply.code(204).send();
  });
}

/** The guest side: pick a made-up table instead of scanning its code. */
export async function customerDemoRoutes(
  app: FastifyInstance,
  options: { pool: pg.Pool },
): Promise<void> {
  app.get('/demo/tables', { config: { auth: 'public' } }, async () => {
    const { rows } = await options.pool.query<{ guest_links: { label: string; token: string }[] }>(
      `SELECT guest_links FROM cl.demo_state WHERE status = 'loaded'`,
    );
    return { tables: rows[0]?.guest_links ?? [] };
  });
}
