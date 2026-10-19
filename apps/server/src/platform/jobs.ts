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
              job_key => $3, run_at => $4, max_attempts => $5)).id::text AS id`,
    [
      task,
      JSON.stringify(payload),
      options.jobKey ?? null,
      options.runAt ?? null,
      options.maxAttempts ?? 10,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('add_job returned no id');
  return id;
}
