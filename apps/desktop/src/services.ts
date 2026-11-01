/**
 * Start-up screen (Phase 8 step 8.5): the Windows services behind the counter app, as the
 * Counter user may see and start them. Only these fixed names and only `sc query` and
 * `sc start` are ever run; nothing from a page reaches the command line. Pure apart from
 * the injected `sc`, so it can be tested without Windows.
 */
import { readFile, writeFile } from 'node:fs/promises';

export type RowId = 'database' | 'server' | 'jobs' | 'printer';
export type RowState = 'ok' | 'working' | 'problem';

export interface ServiceRow {
  id: RowId;
  label: string;
  state: RowState;
  /** Plain words for the person at the counter. */
  message: string;
}

export interface ScResult {
  /** Exit code; null when sc.exe itself could not be run. */
  code: number | null;
  stdout: string;
}
export type Sc = (args: readonly string[]) => Promise<ScResult>;

type Status = 'running' | 'stopped' | 'pending' | 'missing' | 'unknown';

interface Managed {
  id: RowId;
  label: string;
  service: string;
  /** Row that has to be running first. */
  needs?: RowId;
}

const MANAGED: readonly Managed[] = [
  { id: 'database', label: 'Database', service: 'postgresql-x64-17' },
  { id: 'server', label: 'Server', service: 'coffeelounge-api', needs: 'database' },
  { id: 'jobs', label: 'Background jobs', service: 'coffeelounge-worker', needs: 'database' },
];
const SPOOLER = 'Spooler';

export const MAX_START_ATTEMPTS = 3;
export const START_RETRY_MS = 15_000;

const ERROR_SERVICE_ALREADY_RUNNING = 1056;
const ERROR_ACCESS_DENIED = 5;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;

/** Reads the state number, as the words around it change with the Windows language. */
export function parseScQuery(result: ScResult): Status {
  if (result.code === ERROR_SERVICE_DOES_NOT_EXIST) return 'missing';
  if (result.code !== 0) return 'unknown';
  const match = /^\s*\S+\s*:\s*([1-7])\s+[A-Z_]+/m.exec(result.stdout);
  switch (match?.[1]) {
    case '4':
      return 'running';
    case '1':
      return 'stopped';
    case undefined:
      return 'unknown';
    default:
      return 'pending'; // starting, stopping, paused and on their way
  }
}

const TECHNICIAN = 'Call the technician to run the installer again.';

export class ServiceSupervisor {
  private readonly attempts = new Map<string, { count: number; at: number }>();
  private readonly refused = new Set<string>();
  private readonly sc: Sc;
  private readonly inMaintenance: () => boolean;
  private readonly now: () => number;

  constructor(sc: Sc, inMaintenance: () => boolean, now: () => number = Date.now) {
    this.sc = sc;
    this.inMaintenance = inMaintenance;
    this.now = now;
  }

  /** "Try again now": a person asked, so the attempts count from zero. */
  resetAttempts(): void {
    this.attempts.clear();
    this.refused.clear();
  }

  /** Looks at every service once and starts what has stopped; returns what to show. */
  async check(onStart?: (service: string, result: ScResult) => void): Promise<ServiceRow[]> {
    const rows: ServiceRow[] = [];
    const running = new Set<RowId>();
    for (const item of MANAGED) {
      const status = parseScQuery(await this.sc(['query', item.service]));
      if (status === 'running') {
        running.add(item.id);
        this.attempts.delete(item.service);
        this.refused.delete(item.service);
      }
      const needsRunning = !item.needs || running.has(item.needs);
      rows.push({
        id: item.id,
        label: item.label,
        ...(await this.next(item, status, needsRunning, onStart)),
      });
    }
    rows.push(await this.printerRow());
    return rows;
  }

  private async next(
    item: Managed,
    status: Status,
    needsRunning: boolean,
    onStart?: (service: string, result: ScResult) => void,
  ): Promise<{ state: RowState; message: string }> {
    switch (status) {
      case 'running':
        return { state: 'ok', message: 'Running' };
      case 'pending':
        return { state: 'working', message: 'Starting…' };
      case 'missing':
        return { state: 'problem', message: `${item.label} is not installed. ${TECHNICIAN}` };
      case 'unknown':
        return {
          state: 'problem',
          message: `This PC would not say whether ${item.label.toLowerCase()} is running. ${TECHNICIAN}`,
        };
      case 'stopped':
        break;
    }
    // An upgrade or restore stops these on purpose (same flag as watchdog.ps1).
    if (this.inMaintenance()) {
      return { state: 'working', message: 'An update is running. Please wait for it to finish.' };
    }
    if (!needsRunning) return { state: 'working', message: 'Waiting for the database…' };
    if (this.refused.has(item.service)) return refusedMessage(item);

    const tried = this.attempts.get(item.service) ?? { count: 0, at: 0 };
    if (tried.count >= MAX_START_ATTEMPTS) {
      return {
        state: 'problem',
        message: `${item.label} will not start. Restart this PC; if this screen comes back, call the technician.`,
      };
    }
    if (tried.count > 0 && this.now() - tried.at < START_RETRY_MS) {
      return { state: 'working', message: 'Starting…' };
    }
    this.attempts.set(item.service, { count: tried.count + 1, at: this.now() });
    const result = await this.sc(['start', item.service]);
    onStart?.(item.service, result);
    if (result.code === ERROR_ACCESS_DENIED) {
      this.refused.add(item.service);
      return refusedMessage(item);
    }
    if (result.code === 0 || result.code === ERROR_SERVICE_ALREADY_RUNNING) {
      return { state: 'working', message: 'Starting…' };
    }
    return { state: 'working', message: 'Trying to start it…' };
  }

  /**
   * The Windows print service only: whether the printer itself answers is on the Health page
   * once logged in. Bills wait in the queue, so this never holds the app back and the app
   * never starts it.
   */
  private async printerRow(): Promise<ServiceRow> {
    const status = parseScQuery(await this.sc(['query', SPOOLER]));
    return {
      id: 'printer',
      label: 'Printer',
      ...(status === 'running'
        ? { state: 'ok' as const, message: 'Windows print service running' }
        : {
            state: 'problem' as const,
            message: 'The Windows print service is not running. Bills wait until it is.',
          }),
    };
  }
}

function refusedMessage(item: Managed): { state: RowState; message: string } {
  return {
    state: 'problem',
    message: `This Windows account may not start ${item.label.toLowerCase()}. ${TECHNICIAN}`,
  };
}

/** The app can open once the database and server run; background jobs are shown, not awaited. */
export function coreRunning(rows: readonly ServiceRow[]): boolean {
  return ['database', 'server'].every((id) => rows.find((r) => r.id === id)?.state === 'ok');
}

const STATE_NUMBER: Record<string, number> = { stopped: 1, starting: 2, running: 4 };

/**
 * Stands in for sc.exe in development tests (CL_SC_STATE_FILE): a JSON map of service to
 * `stopped`, `starting`, `running`, or `denied` (stopped, and may not be started).
 */
export function fakeSc(file: string): Sc {
  return async (args) => {
    const states = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    const [verb, name = ''] = args;
    const state = states[name];
    if (state === undefined) return { code: ERROR_SERVICE_DOES_NOT_EXIST, stdout: '' };
    if (verb === 'start') {
      if (state === 'denied') return { code: ERROR_ACCESS_DENIED, stdout: '' };
      states[name] = 'running';
      await writeFile(file, JSON.stringify(states));
      return { code: 0, stdout: '' };
    }
    const number = STATE_NUMBER[state] ?? 1;
    return {
      code: 0,
      stdout: `SERVICE_NAME: ${name}\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : ${String(number)}  ${state.toUpperCase()}\n`,
    };
  };
}
