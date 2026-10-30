/**
 * Scheduled e-mails (Phase 6 step 6.6; AT-21, AT-104; P6-4), against a local test mail
 * server over STARTTLS (no internet). The mailbox password is sealed and never comes back;
 * a due period is made once (also with two workers at once); while the server cannot be
 * reached the e-mail waits with its reason on screen and goes out when it is back; a
 * refused or failed e-mail is tried again with the same Message-ID.
 */
import { readFileSync, statSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendDue, scanSchedules } from '../../src/modules/mail/index.ts';
import { backoffMinutes } from '../../src/modules/mail/deliveries.ts';
import { duePeriods } from '../../src/modules/mail/schedules.ts';
import { addDays } from '../../src/modules/reports/index.ts';
import { loadSecretKey, seal, unseal } from '../../src/platform/secret-box.ts';
import { businessDateOf } from '../../src/platform/settings.ts';
import { race, raceRuns, repeatRace } from '../support/concurrency.ts';
import { urlFor } from '../support/db.ts';
import { identityFixture, OWNER, type Client, type IdentityFixture } from '../support/identity.ts';
import { header, startMailServer, type TestMailServer } from '../support/mail-server.ts';

let fx: IdentityFixture;
let owner: Client;
let manager: Client;
let smtp: TestMailServer;
let today = '';

type Body = Record<string, unknown>;
async function call(client: Client, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) {
  const res = await client.call({
    method,
    url: `/api/staff/v1${url}`,
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json<Body>() };
}
/** 08:05 on the shop clock (Asia/Karachi, UTC+5) of a calendar date. */
const at = (date: string, time = '08:05') => new Date(`${date}T${time}:00+05:00`);
const account = (password: string) => ({
  host: '127.0.0.1',
  port: smtp.port,
  security: 'starttls',
  username: smtp.user,
  fromAddress: 'reports@shop.example.test',
  fromName: 'Coffee Lounge',
  password,
});
const deliveries = async () =>
  (await call(owner, 'GET', '/report-deliveries')).body['items'] as Body[];

beforeAll(async () => {
  smtp = await startMailServer();
  fx = await identityFixture({ sessionRole: 'cl_app', mailTls: smtp.tls });
  owner = await fx.loggedIn(OWNER.username, OWNER.password);
  await fx.addUser('ml-mgr', ['manager']);
  manager = await fx.loggedIn('ml-mgr');
  today = await businessDateOf(fx.pool, new Date());
}, 120_000);
afterAll(async () => {
  await fx.close();
  await smtp.stop();
});

describe('the sealed mailbox password (P6-4)', () => {
  it('opens only with its key and for its purpose; the key file is the owner’s alone', () => {
    const key = loadSecretKey(fx.mail.keyFile);
    const sealed = seal(key, 'mail_account.password', 'hunter2');
    expect(sealed).not.toContain('hunter2');
    expect(unseal(key, 'mail_account.password', sealed)).toBe('hunter2');
    expect(() => unseal(key, 'other.secret', sealed)).toThrow();
    expect(() => unseal(Buffer.alloc(32, 1), 'mail_account.password', sealed)).toThrow();
    expect(loadSecretKey(fx.mail.keyFile).equals(key)).toBe(true);
    expect(readFileSync(fx.mail.keyFile, 'utf8').trim()).toHaveLength(44);
    if (process.platform !== 'win32') expect(statSync(fx.mail.keyFile).mode & 0o077).toBe(0);
  });
});

describe('the mailbox (owner only)', () => {
  it('is saved sealed, never shown again, and audited without the password', async () => {
    expect((await call(owner, 'GET', '/mail/account')).body).toEqual({ configured: false });
    const missing = { ...account(''), password: undefined };
    expect((await call(owner, 'PUT', '/mail/account', missing)).status).toBe(400);
    const saved = await call(owner, 'PUT', '/mail/account', account(smtp.password));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, passwordSet: true, port: smtp.port });
    expect(JSON.stringify(saved.body)).not.toContain(smtp.password);
    const shown = await call(owner, 'GET', '/mail/account');
    expect(JSON.stringify(shown.body)).not.toContain(smtp.password);
    const { rows } = await fx.pool.query<{ password_sealed: string }>(
      'SELECT password_sealed FROM cl.mail_account',
    );
    expect(rows[0]?.password_sealed.startsWith('v1:')).toBe(true);
    expect(rows[0]?.password_sealed).not.toContain(smtp.password);
    const { rows: audit } = await fx.pool.query<{ text: string }>(
      `SELECT concat(before::text, after::text) AS text FROM cl.audit_events WHERE action = 'mail.account_update'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.text).not.toContain(smtp.password);
    expect(audit[0]?.text).toContain('"passwordChanged": true');
    // Changing the sender keeps the saved password.
    const renamed = await call(owner, 'PUT', '/mail/account', {
      ...missing,
      fromName: 'Coffee Lounge reports',
    });
    expect(renamed.status).toBe(200);
    expect((await call(manager, 'GET', '/mail/account')).status).toBe(403);
  });

  it('“send a test” shows the provider’s answer', async () => {
    const ok = await call(owner, 'POST', '/mail/test', { to: 'owner@example.test' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(smtp.received.at(-1)?.to).toEqual(['owner@example.test']);
    expect(header(smtp.received.at(-1)?.raw ?? '', 'Subject')).toBe(
      'Coffee Lounge reports: test e-mail',
    );
    await call(owner, 'PUT', '/mail/account', account('wrong-password'));
    const refused = await call(owner, 'POST', '/mail/test', { to: 'owner@example.test' });
    expect(refused.status).toBe(400);
    expect(String(refused.body['detail'])).toMatch(/refused the user name or app password/);
    await call(owner, 'PUT', '/mail/account', account(smtp.password));
  });
});

describe('schedules', () => {
  it('check their report, time, weekday and recipients', async () => {
    const base = {
      reportType: 'day-end',
      frequency: 'daily',
      sendAt: '08:00',
      recipients: ['owner@example.test'],
    };
    const bad = [
      { ...base, sendAt: '02:00' },
      { ...base, frequency: 'weekly', weekday: 1 },
      { ...base, reportType: 'sales-by-day', frequency: 'weekly' },
      { ...base, recipients: ['owner@example.test, someone@else.test'] },
      { ...base, recipients: ['"Boss" <boss@example.test>'] },
      { ...base, reportType: 'bill-lines' },
      { ...base, reportType: 'sales-by-day', filters: { from: '2026-01-01' } },
    ];
    for (const b of bad)
      expect((await call(owner, 'POST', '/report-schedules', b)).status, JSON.stringify(b)).toBe(
        400,
      );
    expect((await call(manager, 'POST', '/report-schedules', base)).status).toBe(403);
  });

  it('due periods: yesterday after its time; last week on its weekday; last month on the 1st', () => {
    const daily = {
      frequency: 'daily' as const,
      send_at: '08:00',
      weekday: null,
      starts_on: '2026-10-01',
    };
    expect(
      duePeriods(daily, '2026-10-20', { date: '2026-10-20', time: '07:59' }).at(-1),
    ).toMatchObject({ to: '2026-10-18' });
    expect(
      duePeriods(daily, '2026-10-20', { date: '2026-10-20', time: '08:00' }).at(-1),
    ).toMatchObject({ from: '2026-10-19', to: '2026-10-19' });
    expect(duePeriods(daily, '2026-10-20', { date: '2026-10-20', time: '09:00' })).toHaveLength(7);
    expect(
      duePeriods({ ...daily, starts_on: '2026-10-19' }, '2026-10-20', {
        date: '2026-10-20',
        time: '09:00',
      }),
    ).toHaveLength(1);
    const weekly = {
      frequency: 'weekly' as const,
      send_at: '08:00',
      weekday: 1,
      starts_on: '2026-10-01',
    };
    // Monday 26 Oct: the week of 19–25 Oct goes out.
    expect(duePeriods(weekly, '2026-10-26', { date: '2026-10-26', time: '08:30' }).at(-1)).toEqual({
      from: '2026-10-19',
      to: '2026-10-25',
      due: '2026-10-26 08:00',
    });
    const monthly = {
      frequency: 'monthly' as const,
      send_at: '08:00',
      weekday: null,
      starts_on: '2026-09-01',
    };
    expect(
      duePeriods(monthly, '2026-11-01', { date: '2026-11-01', time: '08:30' }).map((p) => p.from),
    ).toEqual(['2026-09-01', '2026-10-01']);
    expect([1, 2, 3, 4, 7, 8].map(backoffMinutes)).toEqual([1, 2, 4, 8, 60, 60]);
  });
});

describe('the e-mail queue (AT-21, AT-104)', () => {
  it('offline: made once, queued with the reason, sent when the server is back', async () => {
    const created = await call(owner, 'POST', '/report-schedules', {
      reportType: 'day-end',
      frequency: 'daily',
      sendAt: '08:00',
      recipients: ['owner@example.test', 'partner@example.test'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const morning = at(addDays(today, 1));
    expect(await scanSchedules(fx.pool, morning)).toEqual({ made: 1, failed: 0 });
    expect(await scanSchedules(fx.pool, morning)).toEqual({ made: 0, failed: 0 });

    await smtp.stop(); // "the internet is down"
    expect(await sendDue(fx.pool, fx.mail, morning)).toMatchObject({ sent: 0, waiting: 2 });
    let items = await deliveries();
    expect(items).toHaveLength(2);
    for (const d of items) {
      expect(d).toMatchObject({ status: 'queued', attempts: 1, title: 'Day-end report' });
      expect(String(d['lastError'])).toMatch(/Cannot reach the mail server/);
    }
    const ids = Object.fromEntries(items.map((d) => [String(d['recipient']), d['messageId']]));
    // Not due again until a minute later.
    expect(await sendDue(fx.pool, fx.mail, morning)).toMatchObject({ sent: 0, waiting: 0 });

    await smtp.listen();
    const before = smtp.received.length;
    expect(await sendDue(fx.pool, fx.mail, new Date(morning.getTime() + 60_000))).toMatchObject({
      sent: 2,
    });
    const mails = smtp.received.slice(before);
    expect(mails.map((m) => m.to[0]).sort()).toEqual([
      'owner@example.test',
      'partner@example.test',
    ]);
    for (const m of mails) {
      expect(header(m.raw, 'Message-ID')).toBe(ids[m.to[0] ?? '']);
      expect(m.raw).toContain(`filename=day-end_${today}.pdf`);
      expect(header(m.raw, 'Subject')).toBe(
        `Coffee Lounge: Day-end report, business date ${today}`,
      );
    }
    items = await deliveries();
    expect(items.every((d) => d['status'] === 'sent' && d['lastError'] === null)).toBe(true);
  });

  it('a temporary refusal is retried with the same Message-ID; a refused address waits for a retry', async () => {
    await call(owner, 'POST', '/report-schedules', {
      reportType: 'sales-by-day',
      frequency: 'daily',
      sendAt: '09:00',
      recipients: ['owner@example.test'],
    });
    const morning = at(addDays(today, 1), '09:05');
    expect(await scanSchedules(fx.pool, morning)).toMatchObject({ made: 1 });
    smtp.refuseNext(1, 451);
    expect(await sendDue(fx.pool, fx.mail, morning)).toMatchObject({ waiting: 1 });
    const [waiting] = (await deliveries()).filter((d) => d['reportType'] === 'sales-by-day');
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1 });
    expect(String(waiting?.['lastError'])).toMatch(/451/);
    const before = smtp.received.length;
    expect(await sendDue(fx.pool, fx.mail, new Date(morning.getTime() + 60_000))).toMatchObject({
      sent: 1,
    });
    expect(header(smtp.received[before]?.raw ?? '', 'Message-ID')).toBe(waiting?.['messageId']);
    expect(smtp.received[before]?.raw).toMatch(/filename=sales-by-day_\d{4}-\d{2}-\d{2}\.pdf/);

    // A permanent refusal: failed, shown, and sent with the same Message-ID once retried.
    await call(owner, 'POST', '/report-schedules', {
      reportType: 'payment-mix',
      frequency: 'daily',
      sendAt: '10:00',
      recipients: ['nobody@example.test'],
    });
    const later = at(addDays(today, 1), '10:05');
    await scanSchedules(fx.pool, later);
    smtp.refuseNext(1, 550);
    expect(await sendDue(fx.pool, fx.mail, later)).toMatchObject({ failed: 1 });
    const [failed] = (await deliveries()).filter((d) => d['reportType'] === 'payment-mix');
    expect(failed).toMatchObject({ status: 'failed' });
    expect(String(failed?.['lastError'])).toMatch(/refused this address/);
    expect(
      (await call(manager, 'POST', `/report-deliveries/${String(failed?.['id'])}/retry`)).status,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', `/report-deliveries/${String(failed?.['id'])}/retry`)).status,
    ).toBe(200);
    const n = smtp.received.length;
    await sendDue(fx.pool, fx.mail, later);
    expect(header(smtp.received[n]?.raw ?? '', 'Message-ID')).toBe(failed?.['messageId']);
    const { rows } = await fx.pool.query(
      `SELECT 1 FROM cl.audit_events WHERE action = 'report_delivery.retry'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('a schedule whose author lost the report keeps a failed run with the reason', async () => {
    await fx.addUser('ml-mgr2', ['manager']);
    const { rows } = await fx.pool.query<{ id: string }>(
      `SELECT id::text FROM cl.users WHERE username = 'ml-mgr2'`,
    );
    await fx.pool.query(
      `INSERT INTO cl.report_schedules (report_type, frequency, send_at, recipients, created_by, starts_on)
       VALUES ('ledger', 'daily', '11:00', ARRAY['owner@example.test'], $1, $2)`,
      [rows[0]?.id, today],
    );
    expect(await scanSchedules(fx.pool, at(addDays(today, 1), '11:05'))).toMatchObject({
      failed: 1,
    });
    const [run] = (await deliveries()).filter((d) => d['reportType'] === 'ledger');
    expect(run).toMatchObject({ status: 'not_made', recipient: null });
    expect(String(run?.['lastError'])).toMatch(/may no longer open/);
  });
});

describe('CT: two workers on one due schedule', () => {
  it(`make one run and one e-mail per recipient (×${String(raceRuns())})`, async () => {
    // The other schedules are paused, so each scan has only this one to make.
    await fx.pool.query('UPDATE cl.report_schedules SET is_active = false');
    await repeatRace(raceRuns(), async (run) => {
      const day = addDays(today, 10 + run);
      const { rows: created } = await fx.pool.query<{ id: string }>(
        `INSERT INTO cl.report_schedules (report_type, frequency, send_at, recipients, created_by, starts_on)
         VALUES ('payment-mix', 'daily', '12:00', ARRAY['a@example.test','b@example.test'], $1, $2)
         RETURNING id::text`,
        [fx.ownerId, day],
      );
      const id = created[0]?.id;
      const outcomes = await race({
        connectionString: urlFor(fx.db.name),
        contenders: 2,
        body: async (c) => {
          await c.barrier.wait();
          return scanSchedules(c.pool, at(addDays(day, 1), '12:05'));
        },
      });
      expect(outcomes.every((o) => o.ok)).toBe(true);
      expect(outcomes.reduce((n, o) => n + (o.ok ? o.value.made : 0), 0)).toBe(1);
      const { rows } = await fx.pool.query<{ runs: number; mails: number }>(
        `SELECT count(DISTINCT r.id)::int AS runs, count(d.id)::int AS mails
           FROM cl.report_runs r LEFT JOIN cl.report_deliveries d ON d.run_id = r.id
          WHERE r.schedule_id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ runs: 1, mails: 2 });
      await fx.pool.query('UPDATE cl.report_schedules SET is_active = false WHERE id = $1', [id]);
    });
  }, 300_000);
});
