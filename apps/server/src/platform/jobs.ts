/**
 * Background jobs (02-architecture §2.9). Jobs are added with graphile-worker's SQL
 * function inside the business transaction, so a job exists if and only if the change
 * that caused it committed. A job key de-duplicates (e.g. one print job per ticket copy).
 */
import type { Queryable } from './db/pool.ts';

export interface EnqueueOptions {
  /** Replaces/de-duplicates an existing pending job with the same key. */
  jobKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  /** Jobs in one named queue run one at a time, in order (e.g. one printer). */
  queueName?: string;
}

/** `area:action` — graphile-worker cron lines do not accept dots in task names. */
const TASK = /^[a-z_]+(:[a-z_]+)+$/;

export async function enqueueJob(
  db: Queryable,
  task: string,
  payload: Record<string, unknown>,
  options: EnqueueOptions = {},
): Promise<string> {
  if (!TASK.test(task)) throw new Error(`Invalid task name "${task}"`);
  const { rows } = await db.query<{ id: string }>(
    `SELECT (graphile_worker.add_job($1, $2::json,
              job_key => $3, run_at => $4, max_attempts => $5, queue_name => $6)).id::text AS id`,
    [
      task,
      JSON.stringify(payload),
      options.jobKey ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? 10,
      options.queueName ?? null,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('add_job returned no id');
  return id;
}

/**
 * Hands every object of the job-queue schema to cl_jobs (migration 0006), so members of
 * cl_app pass graphile-worker's row-level security as owners. Run after every job-queue
 * migration: objects it creates belong to the migrating login until handed over.
 */
export async function adoptJobQueue(db: Queryable): Promise<void> {
  await db.query(`
    DO $$
    DECLARE r record;
    BEGIN
      ALTER SCHEMA graphile_worker OWNER TO cl_jobs;
      FOR r IN
        SELECT c.oid::regclass AS name, c.relkind
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'graphile_worker' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'c')
           AND pg_get_userbyid(c.relowner) <> 'cl_jobs'
           -- identity/serial sequences follow their table
           AND (c.relkind <> 'S' OR NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass
                              AND d.deptype IN ('a', 'i')))
      LOOP
        EXECUTE format('ALTER %s %s OWNER TO cl_jobs',
          CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW'
                         WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'c' THEN 'TYPE'
                         ELSE 'TABLE' END,
          r.name);
      END LOOP;
      FOR r IN
        SELECT t.oid::regtype AS name
          FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = 'graphile_worker' AND t.typtype IN ('e', 'd')
           AND pg_get_userbyid(t.typowner) <> 'cl_jobs'
      LOOP
        EXECUTE format('ALTER TYPE %s OWNER TO cl_jobs', r.name);
      END LOOP;
      FOR r IN
        SELECT p.oid::regprocedure AS name, p.prokind
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'graphile_worker' AND pg_get_userbyid(p.proowner) <> 'cl_jobs'
      LOOP
        EXECUTE format('ALTER %s %s OWNER TO cl_jobs',
          CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.name);
      END LOOP;
    END $$;
  `);
}
