/**
 * Print jobs end to end (PRINTING_HARDWARE.md §5, §6) against the TCP printer simulator:
 * accepted rounds print their kitchen ticket; paper-out holds the queue and Retry all
 * prints in order, once (AT-57); a dropped connection or a worker that died mid-send
 * leaves the job uncertain and never resends it (AT-28, AT-16); reprints are labelled.
 * The Windows spooler path is proven on the Windows CI runner (deploy/windows/tests).
 */
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  dispatchPrinter,
  spoolerTransport,
  tcpTransport,
  type Transport,
} from '../../src/modules/printing/index.ts';
import { pruneLogs } from '../../src/worker/maintenance.ts';
import { PrinterSimulator } from '../support/escpos/simulator.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';

let fx: IdentityFixture;
let owner: Client;
let sim: PrinterSimulator;
let printerId = '';
let variantId = '';
/** Jobs of the current test only. */
let since = '0';
const unused: Transport = { send: () => Promise.reject(new Error('not used')) };

const url = (path: string) => `/api/staff/v1${path}`;
async function staff(method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) {
  const res = await owner.call({
    method,
    url: url(path),
    ...(payload ? { payload } : {}),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
  return { status: res.statusCode, body: res.body ? res.json<Record<string, unknown>>() : {} };
}

/** Runs the worker's dispatcher for the printer, as the print:dispatch task does. */
function dispatch(now?: Date) {
  return dispatchPrinter(fx.pool, printerId, {
    transports: { tcp: tcpTransport({ timeoutMs: 1_500, statusTimeoutMs: 500 }), spooler: unused },
    ...(now ? { now: () => now } : {}),
  });
}

async function jobs() {
  const { rows } = await fx.pool.query<{
    id: string;
    document_type: string;
    copy_no: number;
    status: string;
    attempts: number;
    next_attempt_at: Date | null;
  }>(
    `SELECT id::text, document_type, copy_no, status, attempts, next_attempt_at FROM cl.print_jobs
      WHERE printer_id = $1 AND status <> 'cancelled' AND id > $2 ORDER BY print_jobs.id`,
    [printerId, since],
  );
  return rows;
}

let tableNo = 0;
async function acceptedRound(): Promise<{ ticketNo: string; ticketId: string }> {
  tableNo += 1;
  const t = await staff('POST', '/tables', {
    code: `P${String(tableNo)}`,
    name: `Print ${String(tableNo)}`,
  });
  const s = await staff('POST', `/tables/${String(t.body['id'])}/sessions`, {});
  const r = await staff('POST', `/sessions/${String(s.body['id'])}/rounds`, {
    lines: [{ variantId, qty: 2, modifierOptionIds: [], notes: 'extra hot' }],
  });
  expect(r.status).toBe(201);
  const { rows } = await fx.pool.query<{ id: string; ticket_no: string }>(
    'SELECT id::text, ticket_no FROM cl.kitchen_tickets WHERE round_id = $1',
    [r.body['id']],
  );
  return { ticketNo: rows[0]?.ticket_no ?? '', ticketId: rows[0]?.id ?? '' };
}

beforeAll(async () => {
  fx = await identityFixture({ sessionRole: 'cl_app' });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  sim = new PrinterSimulator();
  await sim.start();
  const p = await staff('POST', '/printers', {
    name: 'Counter printer',
    connection: 'tcp',
    address: `127.0.0.1:${String(sim.port)}`,
    supportsStatus: true,
  });
  expect(p.status).toBe(201);
  printerId = String(p.body['id']);
  const { rows } = await fx.pool.query<{ id: string }>(
    'SELECT id::text FROM cl.stations ORDER BY stations.id LIMIT 1',
  );
  expect((await staff('PUT', `/stations/${rows[0]?.id ?? ''}/printer`, { printerId })).status).toBe(
    204,
  );
  const cat = await staff('POST', '/menu/categories', { name: 'Print tests' });
  const item = await staff('POST', '/menu/items', {
    categoryId: cat.body['id'],
    name: 'Flat white',
    variants: [{ name: 'Regular', price: '550' }],
  });
  variantId = (item.body['variantIds'] as string[])[0] ?? '';
});
afterAll(async () => {
  await sim.stop();
  await fx.close();
});
beforeEach(async () => {
  // Each test starts with an empty queue and a healthy printer.
  await fx.pool.query(
    `UPDATE cl.print_jobs SET status = 'cancelled' WHERE status NOT IN ('sent','cancelled')`,
  );
  sim.state = { paper: 'ok', coverOpen: false, cutterError: false };
  sim.faults = { dropAfterBytes: null, stall: false, resetConnections: false };
  sim.clear();
  const { rows } = await fx.pool.query<{ max: string | null }>(
    'SELECT max(id)::text AS max FROM cl.print_jobs',
  );
  since = rows[0]?.max ?? '0';
});

describe('kitchen tickets print on acceptance', () => {
  it('queues the ticket in the acceptance and prints it once, without prices (AT-83)', async () => {
    const { ticketNo } = await acceptedRound();
    expect((await jobs()).map((j) => [j.document_type, j.status])).toEqual([
      ['kitchen_ticket', 'queued'],
    ]);
    expect(await dispatch()).toBe(1);
    expect(sim.jobs).toHaveLength(1);
    const text = sim.jobs[0]?.decoded().text ?? '';
    expect(text).toContain(ticketNo);
    expect(text).toContain('2 x Flat white (Regular)');
    expect(text).toContain('** NOTE: extra hot **');
    expect(text).not.toMatch(/\bRs\b|\d\.\d{2}\b/);
    expect(await dispatch()).toBe(0); // nothing printed twice
    expect(sim.jobs).toHaveLength(1);
  });
});

describe('one printer out of paper (AT-57, PRINTING_HARDWARE.md §6)', () => {
  it('holds a ticket and the job behind it, then prints both in order, once', async () => {
    sim.state.paper = 'out';
    const first = await acceptedRound();
    expect((await staff('POST', `/printers/${printerId}/test`, {})).status).toBe(202);
    let now = new Date();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await dispatch(now)).toBe(0);
      const [head, behind] = await jobs();
      expect(behind?.status).toBe('queued'); // held behind the head
      if (attempt < 5) {
        expect(head).toMatchObject({ status: 'retrying', attempts: attempt });
        now = new Date((head?.next_attempt_at ?? now).getTime() + 1);
      } else {
        expect(head).toMatchObject({ status: 'needs_attention', attempts: 5 });
      }
    }
    expect(sim.jobs.filter((j) => j.bytes.length > 6)).toHaveLength(0); // only status queries reached it
    const status = await staff('GET', '/printers/status');
    expect(status.body['printers']).toEqual([
      expect.objectContaining({
        id: printerId,
        state: 'needs_attention',
        openJobs: 2,
        lastError: 'Out of paper',
      }),
    ]);

    sim.state.paper = 'ok';
    expect((await staff('POST', `/printers/${printerId}/retry-all`, {})).body).toEqual({
      requeued: 1,
    });
    expect(await dispatch()).toBe(2);
    const printed = sim.jobs
      .filter((j) => j.printed && j.bytes.length > 6)
      .map((j) => j.decoded().text);
    expect(printed).toHaveLength(2);
    expect(printed[0]).toContain(first.ticketNo);
    expect(printed[1]).toContain('TEST PRINT');
  });
});

describe('a send that may or may not have printed (AT-28, AT-16)', () => {
  it('a connection dropped mid-job is uncertain, is never resent, and a reprint is labelled', async () => {
    const { ticketNo } = await acceptedRound();
    sim.faults.dropAfterBytes = 40;
    await dispatch();
    expect((await jobs()).map((j) => j.status)).toEqual(['uncertain']);
    sim.faults.dropAfterBytes = null;
    expect(await dispatch()).toBe(0);
    expect(sim.jobs.filter((j) => j.bytes.length > 6)).toHaveLength(1); // no automatic duplicate

    const [job] = (await staff('GET', '/print-jobs')).body['items'] as {
      id: string;
      document: string;
      status: string;
    }[];
    expect(job).toMatchObject({ document: ticketNo, status: 'uncertain' });
    const resolved = await staff('POST', `/print-jobs/${job?.id ?? ''}/resolve-uncertain`, {
      outcome: 'reprint',
    });
    expect(resolved.body['reprintJobId']).toBeTruthy();
    expect(await dispatch()).toBe(1);
    const reprint = sim.jobs.at(-1)?.decoded().text ?? '';
    expect(reprint.split('\n')[0]).toBe('*** REPRINT #2 ***');
    expect(reprint).toContain(ticketNo);
  });

  it('a worker that died while sending leaves the job uncertain; the next job still prints', async () => {
    await acceptedRound();
    const [job] = await jobs();
    await fx.pool.query(
      `UPDATE cl.print_jobs SET status = 'sending', claimed_at = now() - interval '5 minutes', attempts = 1 WHERE id = $1`,
      [job?.id],
    );
    const next = await acceptedRound();
    expect(await dispatch()).toBe(1);
    expect((await jobs()).map((j) => j.status)).toEqual(['uncertain', 'sent']);
    expect(sim.jobs.map((j) => j.decoded().text).filter((t) => t.includes('KITCHEN'))).toHaveLength(
      1,
    );
    expect(sim.jobs.at(-1)?.decoded().text).toContain(next.ticketNo);
    const jobId = (await jobs())[0]?.id ?? '';
    expect(
      (await staff('POST', `/print-jobs/${jobId}/resolve-uncertain`, { outcome: 'printed' }))
        .status,
    ).toBe(200);
    expect((await jobs()).map((j) => j.status)).toEqual(['sent', 'sent']);
  });

  it('an unplugged printer: nothing sent, the job waits and retries; the order is unaffected (AT-16)', async () => {
    await sim.stop();
    try {
      await acceptedRound();
      await dispatch();
      const [job] = await jobs();
      expect(job).toMatchObject({ status: 'retrying', attempts: 1 });
      const pending = await fx.pool.query(
        `SELECT count(*)::int AS n FROM cl.order_rounds WHERE status = 'accepted'`,
      );
      expect((pending.rows[0] as { n: number }).n).toBeGreaterThan(0);
    } finally {
      await sim.start(); // a new port: point the printer at it
      await fx.pool.query('UPDATE cl.printers SET address = $2 WHERE id = $1', [
        printerId,
        `127.0.0.1:${String(sim.port)}`,
      ]);
    }
  });
});

describe('reprints and test prints', () => {
  it('a kitchen reprint is a new labelled copy (K5)', async () => {
    const { ticketId } = await acceptedRound();
    await dispatch();
    expect((await staff('POST', `/tickets/${ticketId}/reprint`, {})).status).toBe(202);
    expect((await staff('POST', `/tickets/${ticketId}/reprint`, {})).status).toBe(202);
    expect(
      (await jobs())
        .filter((j) => j.document_type === 'kitchen_ticket')
        .map((j) => j.copy_no)
        .slice(-3),
    ).toEqual([1, 2, 3]);
    await dispatch();
    expect(sim.jobs.at(-1)?.decoded().text.split('\n')[0]).toBe('*** REPRINT #3 ***');
  });
});

describe('Windows spooler transport (exit codes)', () => {
  const fakePowerShell = (code: number): { powershell: string; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-ps-'));
    const out = join(dir, 'stdin.txt');
    const script = join(dir, 'powershell.sh');
    writeFileSync(
      script,
      `#!/bin/sh\ncat > "${out}"\necho "fake failure" 1>&2\nexit ${String(code)}\n`,
    );
    chmodSync(script, 0o755);
    return { powershell: script, out };
  };
  const printer = {
    name: 'USB',
    connection: 'spooler' as const,
    address: 'SNC-101',
    supports_status: false,
  };

  it.runIf(process.platform !== 'win32')(
    'maps the helper exit codes to sent, not sent and uncertain',
    async () => {
      const outcome = async (code: number) => {
        const fake = fakePowerShell(code);
        const result = await spoolerTransport({
          powershell: fake.powershell,
          timeoutMs: 5_000,
        }).send(printer, Buffer.from('hello'));
        return { result, input: existsSync(fake.out) ? readFileSync(fake.out, 'utf8') : '' };
      };
      const ok = await outcome(0);
      expect(ok.result).toEqual({ outcome: 'sent' });
      expect(Buffer.from(ok.input, 'base64').toString()).toBe('hello');
      expect((await outcome(10)).result).toMatchObject({
        outcome: 'not_sent',
        error: 'fake failure',
      });
      expect((await outcome(20)).result).toMatchObject({ outcome: 'uncertain' });
      expect((await outcome(1)).result).toMatchObject({ outcome: 'uncertain' });
    },
  );
});

describe('log retention (W-3)', () => {
  it('deletes log files older than 30 days and keeps the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-logs-'));
    const old = join(dir, 'coffeelounge-api.20260901.out.log');
    const recent = join(dir, 'coffeelounge-api.20261020.out.log');
    writeFileSync(old, 'old');
    writeFileSync(recent, 'recent');
    const now = new Date('2026-10-22T00:00:00Z');
    utimesSync(old, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    utimesSync(recent, new Date('2026-10-20T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
    expect(await pruneLogs(dir, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});
