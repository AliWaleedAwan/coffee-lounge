/**
 * The shop's mailbox (P6-4; I-17): the owner types the provider's address and an app
 * password on the owner screen. The password is sealed (platform/secret-box.ts) before it
 * reaches the database, never read back to any screen, and never written to logs or audit
 * lines. Mail leaves only over TLS (implicit on 465, STARTTLS required otherwise) and with
 * the provider's certificate checked.
 */
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import nodemailer from 'nodemailer';
import { writeAudit, type AuditContext } from '../../platform/audit.ts';
import type { Queryable } from '../../platform/db/pool.ts';
import type { Tx } from '../../platform/db/tx.ts';
import { AppError } from '../../platform/errors.ts';
import { loadSecretKey, seal, unseal } from '../../platform/secret-box.ts';

const PURPOSE = 'mail_account.password';

export interface MailDeps {
  /** MAIL_KEY_FILE: the key that seals the password. */
  keyFile: string;
  /** Extra TLS settings (tests: trust the local test server's certificate authority). */
  tls?: ConnectionOptions;
}

export interface AccountInput {
  host: string;
  port: number;
  security: 'starttls' | 'tls';
  username: string;
  fromAddress: string;
  fromName: string;
  /** Left out to keep the one already saved. */
  password?: string | undefined;
  expectedVersion?: number | undefined;
}

interface AccountRow {
  host: string;
  port: number;
  security: 'starttls' | 'tls';
  username: string;
  from_address: string;
  from_name: string;
  password_sealed: string;
  updated_at: Date;
  version: number;
}

async function row(db: Queryable): Promise<AccountRow | null> {
  const { rows } = await db.query<AccountRow>(
    `SELECT host, port, security, username, from_address, from_name, password_sealed, updated_at, version
       FROM cl.mail_account WHERE id = 1`,
  );
  return rows[0] ?? null;
}

/** What the owner screen shows: everything but the password, which is only "set". */
export async function readAccount(db: Queryable) {
  const r = await row(db);
  if (!r) return { configured: false as const };
  return {
    configured: true as const,
    host: r.host,
    port: r.port,
    security: r.security,
    username: r.username,
    fromAddress: r.from_address,
    fromName: r.from_name,
    passwordSet: true,
    updatedAt: r.updated_at.toISOString(),
    version: r.version,
  };
}

export async function saveAccount(
  tx: Tx,
  ctx: AuditContext & { userId: string },
  deps: MailDeps,
  input: AccountInput,
) {
  const before = await row(tx);
  if (before && input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
    throw new AppError('STALE_STATE', 'Someone else changed the mailbox first; reload and retry');
  }
  if (!before && !input.password) {
    throw new AppError('VALIDATION_FAILED', 'Enter the mailbox app password');
  }
  const sealed = input.password
    ? seal(loadSecretKey(deps.keyFile), PURPOSE, input.password)
    : (before?.password_sealed ?? '');
  await tx.query(
    `INSERT INTO cl.mail_account (id, host, port, security, username, from_address, from_name, password_sealed, updated_by)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET host = $1, port = $2, security = $3, username = $4,
       from_address = $5, from_name = $6, password_sealed = $7, updated_by = $8`,
    [
      input.host,
      input.port,
      input.security,
      input.username,
      input.fromAddress,
      input.fromName,
      sealed,
      ctx.userId,
    ],
  );
  await writeAudit(tx, ctx, {
    action: 'mail.account_update',
    entityType: 'mail_account',
    entityId: '1',
    ...(before
      ? {
          before: {
            host: before.host,
            port: before.port,
            security: before.security,
            username: before.username,
            from: before.from_address,
          },
        }
      : {}),
    // Never the password: only whether it changed.
    after: {
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      from: input.fromAddress,
      passwordChanged: Boolean(input.password),
    },
  });
  return readAccount(tx);
}

export interface Mailer {
  from: { name: string; address: string };
  /** For Message-IDs: the domain of the sending address. */
  domain: string;
  send(message: {
    to: string;
    subject: string;
    text: string;
    messageId: string;
    attachments?: { filename: string; content: Buffer; contentType: string }[];
  }): Promise<void>;
  close(): void;
}

/** A connection to the mailbox, or null when the owner has not set one up. */
export async function openMailer(db: Queryable, deps: MailDeps): Promise<Mailer | null> {
  const r = await row(db);
  if (!r) return null;
  const pass = unseal(loadSecretKey(deps.keyFile), PURPOSE, r.password_sealed);
  const transport = nodemailer.createTransport({
    host: r.host,
    port: r.port,
    secure: r.security === 'tls',
    requireTLS: r.security === 'starttls',
    auth: { user: r.username, pass },
    tls: { minVersion: 'TLSv1.2', ...(isIP(r.host) ? {} : { servername: r.host }), ...deps.tls },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  });
  const from = { name: r.from_name, address: r.from_address };
  return {
    from,
    domain: r.from_address.split('@')[1] ?? 'coffee-lounge.local',
    async send(m) {
      await transport.sendMail({
        from,
        to: m.to,
        subject: m.subject,
        text: m.text,
        messageId: m.messageId,
        ...(m.attachments ? { attachments: m.attachments } : {}),
      });
    },
    close() {
      transport.close();
    },
  };
}

/** A recipient: one plain address, nothing a mail client could read as more than one. */
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;

export interface SendFailure {
  /** Shown on screen; never contains the password. */
  message: string;
  /** The address was refused: trying again will not help. */
  permanent: boolean;
}

/** What went wrong, in words for the owner (AT-104: errors visible). */
export function describeFailure(error: unknown): SendFailure {
  const e = error as { code?: string; responseCode?: number; response?: string; message?: string };
  const said = (e.response ?? e.message ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
  if (e.code === 'EAUTH') {
    return {
      message: `The mailbox refused the user name or app password (${said})`,
      permanent: false,
    };
  }
  if (
    [
      'ECONNECTION',
      'ETIMEDOUT',
      'ESOCKET',
      'EDNS',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EGREETING',
    ].includes(e.code ?? '')
  ) {
    return {
      message: 'Cannot reach the mail server (no internet?); it will be tried again',
      permanent: false,
    };
  }
  if (e.code === 'ETLS' || /certificate|TLS|SSL/i.test(said)) {
    return {
      message: `The secure connection to the mail server failed (${said})`,
      permanent: false,
    };
  }
  if (e.responseCode !== undefined && e.responseCode >= 550 && e.responseCode <= 553) {
    return { message: `The mail server refused this address (${said})`, permanent: true };
  }
  return { message: `The mail server said: ${said}`, permanent: false };
}
