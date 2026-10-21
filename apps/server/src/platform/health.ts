/**
 * Health probes (API.md §1 and §5.7, WINDOWS_DEPLOYMENT.md §2 and H-14, AT-120).
 *
 * Public `/health/ready` answers from the readiness gate plus a live database probe, so
 * a client can tell "server starting" from "database down" without logging in (a
 * session check needs the database). `/system/health` adds the detail for the health
 * page. Probes are cached briefly: health URLs are unauthenticated and must not let a
 * client multiply load on the database.
 */
import { statfs } from 'node:fs/promises';
import net from 'node:net';
import { parse } from 'node:path';
import type { Queryable } from './db/pool.ts';
import type { Readiness } from './readiness.ts';

/** The API reports the worker as stale after this long without a heartbeat. */
export const HEARTBEAT_STALE_MS = 60_000;
/** H-14: warn at 80 % used, critical at 90 % used. */
export const DISK_WARNING_FREE_PERCENT = 20;
export const DISK_CRITICAL_FREE_PERCENT = 10;

export type DatabaseStatus = 'ok' | 'unreachable';
export type InternetStatus = 'online' | 'offline';

export interface WorkerStatus {
  status: 'ok' | 'stale' | 'down';
  lastHeartbeatAt: Date | null;
}

export interface DiskStatus {
  freePercent: number | null;
  status: 'ok' | 'warning' | 'critical' | 'unknown';
}

/** Single-flight cache: concurrent callers share one probe; the result lives ttlMs. */
export class Cached<T> {
  private value: { at: number; result: T } | undefined;
  private inflight: Promise<T> | undefined;
  private readonly ttlMs: number;
  private readonly probe: () => Promise<T>;
  private readonly now: () => number;

  constructor(ttlMs: number, probe: () => Promise<T>, now: () => number = () => Date.now()) {
    this.ttlMs = ttlMs;
    this.probe = probe;
    this.now = now;
  }

  get(): Promise<T> {
    if (this.value && this.now() - this.value.at < this.ttlMs) {
      return Promise.resolve(this.value.result);
    }
    this.inflight ??= this.probe()
      .then((result) => {
        this.value = { at: this.now(), result };
        return result;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** `unreachable` also covers a database too busy to answer within the timeout. */
export async function probeDatabase(db: Queryable, timeoutMs = 2_000): Promise<DatabaseStatus> {
  try {
    await withTimeout(db.query('SELECT 1'), timeoutMs);
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

export async function workerStatus(db: Queryable, name = 'worker'): Promise<WorkerStatus> {
  const { rows } = await db.query<{ beat_at: Date; age_ms: number }>(
    `SELECT beat_at, (EXTRACT(EPOCH FROM (now() - beat_at)) * 1000)::int AS age_ms
       FROM cl.worker_heartbeats WHERE worker_name = $1`,
    [name],
  );
  const row = rows[0];
  if (!row) return { status: 'down', lastHeartbeatAt: null };
  return {
    status: row.age_ms <= HEARTBEAT_STALE_MS ? 'ok' : 'stale',
    lastHeartbeatAt: row.beat_at,
  };
}

export function diskLevel(freePercent: number): DiskStatus['status'] {
  if (freePercent <= DISK_CRITICAL_FREE_PERCENT) return 'critical';
  if (freePercent <= DISK_WARNING_FREE_PERCENT) return 'warning';
  return 'ok';
}

/** Free space on the volume holding `path` (space usable by this service account). */
/**
 * The printer as the health page sees it (PRINTING_HARDWARE.md §6): `error` while any
 * job waits for staff or keeps failing, `unknown` before a printer is set up.
 */
export async function printerStatus(
  db: Queryable,
): Promise<{ status: 'ok' | 'error' | 'unknown'; openJobs: number }> {
  const { rows } = await db.query<{ printers: number; open: number; failing: number }>(
    `SELECT (SELECT count(*)::int FROM cl.printers WHERE is_active) AS printers,
            count(*) FILTER (WHERE status IN ('queued','sending','retrying','needs_attention'))::int AS open,
            count(*) FILTER (WHERE status IN ('retrying','needs_attention','uncertain'))::int AS failing
       FROM cl.print_jobs`,
  );
  const r = rows[0];
  if (!r || r.printers === 0) return { status: 'unknown', openJobs: r?.open ?? 0 };
  return { status: r.failing > 0 ? 'error' : 'ok', openJobs: r.open };
}

export async function probeDisk(path: string): Promise<DiskStatus> {
  try {
    const s = await statfs(path);
    if (s.blocks <= 0) return { freePercent: null, status: 'unknown' };
    const freePercent = Math.round((s.bavail / s.blocks) * 1_000) / 10;
    return { freePercent, status: diskLevel(freePercent) };
  } catch {
    return { freePercent: null, status: 'unknown' };
  }
}

/** Whether a volume is mounted at `path` (e.g. the USB backup drive `B:\`). */
export async function probePathPresent(path: string | undefined): Promise<boolean> {
  if (path === undefined) return false;
  try {
    await statfs(path);
    return true;
  } catch {
    return false;
  }
}

export interface InternetTarget {
  host: string;
  port: number;
}

/** `host:port`, or `off` (never probe; reports offline). */
export function parseInternetTarget(value: string): InternetTarget | null {
  if (value === 'off') return null;
  const match = /^([^\s:]+):(\d{1,5})$/.exec(value);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid internet check target "${value}"`);
  return { host: match[1], port: Number(match[2]) };
}

/** A TCP connection that opens within the timeout means the shop is online. */
export function probeInternet(
  target: InternetTarget | null,
  timeoutMs = 2_000,
): Promise<InternetStatus> {
  if (target === null) return Promise.resolve('offline');
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (status: InternetStatus): void => {
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(timeoutMs, () => {
      done('offline');
    });
    socket.once('connect', () => {
      done('online');
    });
    socket.once('error', () => {
      done('offline');
    });
  });
}

export interface HealthProbes {
  database: () => Promise<DatabaseStatus>;
  worker: () => Promise<WorkerStatus>;
  disk: () => Promise<DiskStatus>;
  backupDrivePresent: () => Promise<boolean>;
  internet: () => Promise<InternetStatus>;
}

export interface HealthOptions {
  db: Queryable;
  readiness: Readiness;
  version?: string;
  /** Volume to watch (the one holding the database). Default: root of the working directory. */
  diskPath?: string;
  backupDrivePath?: string;
  internetTarget?: InternetTarget | null;
  /** Replaces individual probes (tests). */
  probes?: Partial<HealthProbes>;
}

export interface SystemHealth {
  api: 'ok' | 'degraded';
  database: DatabaseStatus;
  worker: { status: WorkerStatus['status']; lastHeartbeatAt: string | null };
  printer: { status: 'ok' | 'error' | 'unknown'; openJobs: number };
  backup: { lastSuccessAt: string | null; lastVerifiedAt: string | null; usbDrivePresent: boolean };
  disk: DiskStatus;
  internet: InternetStatus;
  warnings: Record<string, string>;
  version: string;
  checkedAt: string;
}

export class HealthMonitor {
  private readonly readiness: Readiness;
  private readonly version: string;
  private readonly database: Cached<DatabaseStatus>;
  private readonly disk: Cached<DiskStatus>;
  private readonly backupDrive: Cached<boolean>;
  private readonly internet: Cached<InternetStatus>;
  private readonly worker: () => Promise<WorkerStatus>;
  private readonly printer: () => Promise<{ status: 'ok' | 'error' | 'unknown'; openJobs: number }>;

  constructor(options: HealthOptions) {
    const { db, probes = {} } = options;
    const diskPath = options.diskPath ?? parse(process.cwd()).root;
    const target = options.internetTarget === undefined ? null : options.internetTarget;
    this.readiness = options.readiness;
    this.version = options.version ?? '0.0.0';
    this.database = new Cached(1_000, probes.database ?? (() => probeDatabase(db)));
    this.disk = new Cached(10_000, probes.disk ?? (() => probeDisk(diskPath)));
    this.backupDrive = new Cached(
      10_000,
      probes.backupDrivePresent ?? (() => probePathPresent(options.backupDrivePath)),
    );
    this.internet = new Cached(60_000, probes.internet ?? (() => probeInternet(target)));
    this.worker = probes.worker ?? (() => workerStatus(db));
    this.printer = () => printerStatus(db);
  }

  /** Database status for `/health/ready` (cached 1 s). */
  databaseStatus(): Promise<DatabaseStatus> {
    return this.database.get();
  }

  /** The health page. Throws if the database fails mid-check (mapped to 503). */
  async system(): Promise<SystemHealth> {
    const [database, disk, usbDrivePresent, internet] = await Promise.all([
      this.database.get(),
      this.disk.get(),
      this.backupDrive.get(),
      this.internet.get(),
    ]);
    const worker = await this.worker();
    const { blockers, warnings } = this.readiness.snapshot();
    const healthy =
      Object.keys(blockers).length === 0 && Object.keys(warnings).length === 0 && database === 'ok';
    return {
      api: healthy ? 'ok' : 'degraded',
      database,
      worker: {
        status: worker.status,
        lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
      },
      printer: await this.printer(),
      // Filled in by the backup phase (dump records).
      backup: { lastSuccessAt: null, lastVerifiedAt: null, usbDrivePresent },
      disk,
      internet,
      warnings,
      version: this.version,
      checkedAt: new Date().toISOString(),
    };
  }
}
