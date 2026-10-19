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
