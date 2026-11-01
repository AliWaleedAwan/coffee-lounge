/**
 * Continuous local copy (docs/phase-8/DEMO.md): `pg_receivewal --synchronous` keeps a second
 * copy of PostgreSQL's change log in a folder on this PC, flushed at every commit. It appends
 * to the current file instead of making a new backup, and sleeps while nothing changes, so it
 * costs next to nothing. It guards against a damaged database, not a dead disk: the backup
 * drive and the off-site copy still do that (BACKUP_RECOVERY.md). Only the newest segments are
 * kept, and the slot's limit (max_slot_wal_keep_size, install.ps1) stops a stopped copy from
 * filling the disk. A restore reads this folder for what the drive does not have yet.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const LIVE_SLOT = 'cl_live_copy';
/** 64 × 16 MB: about 1 GB, always far more than the time since the last dump. */
const KEEP_SEGMENTS = 64;
const RESTART_MS = 30_000;
const PRUNE_MS = 600_000;

export interface LiveWalOptions {
  dir: string;
  replicationUrl: string;
  pgBinDir?: string | undefined;
  log: (message: string) => void;
}

/** Finished segments beyond the newest `keep`; the one being written (.partial) always stays. */
export function pruneLiveWal(dir: string, keep = KEEP_SEGMENTS): number {
  const done = readdirSync(dir)
    .filter((f) => /^[0-9A-F]{24}$/.test(f))
    .sort();
  const old = done.slice(0, Math.max(0, done.length - keep));
  for (const f of old) rmSync(join(dir, f), { force: true });
  return old.length;
}

export class LiveWal {
  private child: ChildProcess | null = null;
  private restart: NodeJS.Timeout | null = null;
  private prune: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly options: LiveWalOptions;

  constructor(options: LiveWalOptions) {
    this.options = options;
  }

  private tool(): string {
    const name = process.platform === 'win32' ? 'pg_receivewal.exe' : 'pg_receivewal';
    return this.options.pgBinDir ? join(this.options.pgBinDir, name) : name;
  }

  private run(args: string[], onExit: (code: number | null) => void): ChildProcess {
    const child = spawn(
      this.tool(),
      [`--dbname=${this.options.replicationUrl}`, '--no-password', ...args],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let err = '';
    child.stderr.on('data', (c: Buffer) => {
      err = (err + c.toString()).slice(-500);
    });
    child.on('error', (e) => {
      err = e.message;
    });
    child.on('close', (code) => {
      if (code !== 0 && !this.stopped) this.options.log(`live copy stopped: ${err.trim()}`);
      onExit(code);
    });
    return child;
  }

  start(): void {
    mkdirSync(this.options.dir, { recursive: true });
    this.prune = setInterval(() => {
      try {
        pruneLiveWal(this.options.dir);
      } catch (e) {
        this.options.log(`live copy prune: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, PRUNE_MS);
    this.prune.unref();
    this.launch();
  }

  private launch(): void {
    if (this.stopped) return;
    // The slot makes PostgreSQL hold what the copy has not received yet, across restarts.
    this.child = this.run(['--create-slot', '--if-not-exists', `--slot=${LIVE_SLOT}`], () => {
      this.child = this.run(
        [`--directory=${this.options.dir}`, `--slot=${LIVE_SLOT}`, '--synchronous'],
        () => {
          this.child = null;
          if (this.stopped) return;
          this.restart = setTimeout(() => {
            this.launch();
          }, RESTART_MS);
          this.restart.unref();
        },
      );
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restart) clearTimeout(this.restart);
    if (this.prune) clearInterval(this.prune);
    this.child?.kill();
  }
}
