/**
 * Readiness gate (WINDOWS_DEPLOYMENT.md §2): the API refuses business traffic with
 * 503 SERVER_STARTING until every blocker is cleared. Warnings never block.
 */
import { checkClock, latestRecordedInstant } from './clock.ts';
import type { Queryable } from './db/pool.ts';
import type { Migration } from './db/migrate.ts';

export type Blocker =
  'startup_pending' | 'database_unreachable' | 'migrations_pending' | 'clock_behind';
export type Warning = 'clock_jumped';

export class Readiness {
  private readonly blockers = new Map<Blocker, string>([
    ['startup_pending', 'Startup checks have not completed yet'],
  ]);
  private readonly warnings = new Map<Warning, string>();

  isReady(): boolean {
    return this.blockers.size === 0;
  }

  block(blocker: Blocker, detail: string): void {
    this.blockers.set(blocker, detail);
  }

  clear(blocker: Blocker): void {
    this.blockers.delete(blocker);
  }

  warn(warning: Warning, detail: string): void {
    this.warnings.set(warning, detail);
  }

  snapshot(): { blockers: Record<string, string>; warnings: Record<string, string> } {
    return {
      blockers: Object.fromEntries(this.blockers),
      warnings: Object.fromEntries(this.warnings),
    };
  }
}

export interface StartupCheckInput {
  db: Queryable;
  migrations: Migration[];
  now: Date;
  clockToleranceMs: number;
  readiness: Readiness;
}

interface AppliedRow {
  version: string;
  checksum: string;
}

/** Runs the startup checks and updates readiness. Never throws. */
export async function runStartupChecks(input: StartupCheckInput): Promise<void> {
  const { db, migrations, readiness } = input;

  try {
    await db.query('SELECT 1');
    readiness.clear('database_unreachable');
  } catch (error) {
    readiness.block('database_unreachable', `Database not reachable: ${(error as Error).message}`);
    return;
  }

  try {
    const { rows } = await db.query<AppliedRow>(
      `SELECT version, checksum FROM cl_meta.schema_migrations ORDER BY version`,
    );
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));
    const missing = migrations.filter((m) => applied.get(m.version) !== m.checksum);
    const known = new Set(migrations.map((m) => m.version));
    const unknown = rows.filter((r) => !known.has(r.version));
    if (missing.length > 0 || unknown.length > 0) {
      const parts = [
        ...missing.map((m) => `${m.version}_${m.name} not applied`),
        ...unknown.map((r) => `${r.version} applied but unknown to this server version`),
      ];
      readiness.block('migrations_pending', `Database schema does not match: ${parts.join('; ')}`);
      return;
    }
    readiness.clear('migrations_pending');
  } catch (error) {
    readiness.block('migrations_pending', `Schema check failed: ${(error as Error).message}`);
    return;
  }

  const clock = checkClock(input.now, await latestRecordedInstant(db), input.clockToleranceMs);
  if (!clock.ok) {
    readiness.block(
      'clock_behind',
      `PC clock is wrong: it is ${Math.round(clock.behindByMs / 60_000)} min behind the latest saved record ` +
        `(${clock.latest.toISOString()}). Set the date and time, then retry.`,
    );
    return;
  }
  readiness.clear('clock_behind');
  readiness.clear('startup_pending');
}
