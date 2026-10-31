/**
 * Server configuration from environment variables (WINDOWS_DEPLOYMENT.md §1: the
 * installer writes them to the ACL-protected config file; .env in development).
 */
import { z } from 'zod';

const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);

const schema = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
    HOST: z.string().min(1).default('0.0.0.0'),
    CUSTOMER_PORT: port(8080),
    STAFF_PORT: port(8443),
    STAFF_TLS_CERT: z.string().min(1).optional(),
    STAFF_TLS_KEY: z.string().min(1).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /** How far the PC clock may be behind the latest stored timestamp (WINDOWS_DEPLOYMENT.md §5). */
    CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(120),
    /**
     * Base of the printed QR links, e.g. `http://192.168.100.250:8080` (LOCAL_LAN_HOSTING.md §2).
     * Unset: the LAN address of this PC and CUSTOMER_PORT.
     */
    GUEST_BASE_URL: z
      .string()
      .regex(/^http:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, 'must be http://<address>[:port] with no path')
      .optional(),
    /** Where the services write logs; files older than 30 days are deleted (W-3). Unset: kept. */
    LOG_DIR: z.string().min(1).optional(),
    /** Built staff web app served on the staff listener. Default: apps/web/dist. */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /** Volume whose free space the health page watches (H-14). Default: the install drive. */
    DISK_CHECK_PATH: z.string().min(1).optional(),
    /** Attached bills of expenses (P5-3; installed: `C:\ProgramData\CoffeeLounge\files`). Unset: `.local/files`. */
    FILES_DIR: z.string().min(1).optional(),
    /** Key that seals the mailbox password (P6-4; installed: `C:\ProgramData\CoffeeLounge\config\mail.key`). Unset: `.local/mail.key`. */
    MAIL_KEY_FILE: z.string().min(1).optional(),
    /** The backup public key (step 7.1; installed: `C:\ProgramData\CoffeeLounge\config\backup.pub`). Unset: no backups. */
    BACKUP_PUBLIC_KEY_FILE: z.string().min(1).optional(),
    /** This cluster's own WAL folder on the drive (`B:\\CoffeeLounge\\wal\\<system id>`; step 7.3). Unset: `wal`. */
    BACKUP_WAL_DIR: z.string().min(1).optional(),
    /** The backup login with REPLICATION, for base backups (step 7.2). Unset: no base backups. */
    BACKUP_REPLICATION_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//)
      .optional(),
    /** The scratch database of the weekly test restore, owned by the backup login (step 7.2). */
    RESTORE_TEST_DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//)
      .optional(),
    /** PostgreSQL's bin folder for pg_dump (installed: `C:\Program Files\PostgreSQL\17\bin`). Unset: the PATH. */
    PG_BIN_DIR: z.string().min(1).optional(),
    /** USB backup drive root (H-17: `B:\`). Unset: reported as not present. */
    BACKUP_DRIVE_PATH: z.string().min(1).optional(),
    /** `host:port` reached over TCP to report internet online/offline, or `off`. */
    INTERNET_CHECK_TARGET: z
      .string()
      .regex(/^(off|[^\s:]+:\d{1,5})$/, 'must be host:port or off')
      .default('1.1.1.1:443'),
  })
  .refine((c) => (c.STAFF_TLS_CERT === undefined) === (c.STAFF_TLS_KEY === undefined), {
    message: 'STAFF_TLS_CERT and STAFF_TLS_KEY must be set together',
    path: ['STAFF_TLS_CERT'],
  })
  .refine((c) => c.CUSTOMER_PORT !== c.STAFF_PORT, {
    message: 'CUSTOMER_PORT and STAFF_PORT must differ',
    path: ['STAFF_PORT'],
  });

export type Config = z.infer<typeof schema>;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || 'config'}: ${i.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
