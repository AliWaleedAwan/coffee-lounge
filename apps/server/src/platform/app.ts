/**
 * The two HTTP listeners (02-architecture §2.7, API.md §1):
 *  - customer (guest phones, plain HTTP on 8080): only /api/customer routes
 *  - staff (registered devices, HTTPS/HTTP2 on 8443): only /api/staff routes
 * Routes are registered per listener, so a staff route can never be reached on the
 * customer port and vice versa. Both share the platform behaviour below.
 */
import { readFileSync } from 'node:fs';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from 'fastify';
import type pg from 'pg';
import type { Config } from './config.ts';
import { CORRELATION_HEADER, correlationIdFor } from './correlation.ts';
import { problem, registerErrorHandling, sendProblem } from './errors.ts';
import { HealthMonitor } from './health.ts';
import type { Readiness } from './readiness.ts';
import { appShellFallback, registerWebApp } from './web-app.ts';

export interface PlatformDeps {
  config: Pick<Config, 'LOG_LEVEL' | 'STAFF_TLS_CERT' | 'STAFF_TLS_KEY'>;
  pool: pg.Pool;
  readiness: Readiness;
  /** Health probes; by default only the database probe is used here. */
  health?: HealthMonitor;
  /** Built staff web app to serve on the staff listener (apps/web/dist). */
  staffWebRoot?: string;
  /** false silences logs (tests). */
  logging?: boolean;
}

export interface RouteRegistrations {
  customer?: FastifyPluginAsync;
  staff?: FastifyPluginAsync;
}

export const CUSTOMER_PREFIX = '/api/customer/v1';
export const STAFF_PREFIX = '/api/staff/v1';
const BODY_LIMIT = 64 * 1024;

function createListener(
  name: 'customer' | 'staff',
  deps: PlatformDeps & { health: HealthMonitor },
  routes: FastifyPluginAsync | undefined,
  prefix: string,
): FastifyInstance {
  const options: FastifyServerOptions & Record<string, unknown> = {
    logger: deps.logging === false ? false : { level: deps.config.LOG_LEVEL, name },
    genReqId: correlationIdFor,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }),
    bodyLimit: BODY_LIMIT,
    trustProxy: false,
  };
  if (name === 'staff' && deps.config.STAFF_TLS_CERT && deps.config.STAFF_TLS_KEY) {
    options['http2'] = true;
    options['https'] = {
      allowHTTP1: true,
      cert: readFileSync(deps.config.STAFF_TLS_CERT),
      key: readFileSync(deps.config.STAFF_TLS_KEY),
    };
  }
  const app = Fastify(options) as unknown as FastifyInstance;

  const webRoot = name === 'staff' ? deps.staffWebRoot : undefined;
  registerErrorHandling(app, webRoot ? appShellFallback : undefined);

  app.addHook('onRequest', async (request, reply) => {
    // Only the API waits for readiness: the web app loads and shows "Server starting…".
    if (!request.url.startsWith('/api/') || deps.readiness.isReady()) return;
    const { blockers } = deps.readiness.snapshot();
    await sendProblem(
      reply,
      problem('SERVER_STARTING', Object.values(blockers).join(' '), request.id, { blockers }),
    );
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header(CORRELATION_HEADER, request.id);
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('Cache-Control')) void reply.header('Cache-Control', 'no-store');
  });

  app.get('/health/live', async () => ({ status: 'live' }));
  // Readiness gate plus a live (1 s cached) database probe. Public, so no error detail.
  app.get('/health/ready', async (request, reply) => {
    const state = deps.readiness.snapshot();
    if (!deps.readiness.isReady()) {
      return sendProblem(
        reply,
        problem('SERVER_STARTING', Object.values(state.blockers).join(' '), request.id, state),
      );
    }
    const database = await deps.health.databaseStatus();
    if (database !== 'ok') {
      return sendProblem(
        reply,
        problem('DATABASE_UNAVAILABLE', 'The server cannot reach its database.', request.id, {
          database,
        }),
      );
    }
    return { status: 'ready', database, warnings: state.warnings };
  });

  if (webRoot) registerWebApp(app, webRoot);
  if (routes) void app.register(routes, { prefix });
  return app;
}

export function buildApps(
  deps: PlatformDeps,
  routes: RouteRegistrations = {},
): { customer: FastifyInstance; staff: FastifyInstance } {
  const shared = {
    ...deps,
    health: deps.health ?? new HealthMonitor({ db: deps.pool, readiness: deps.readiness }),
  };
  return {
    customer: createListener('customer', shared, routes.customer, CUSTOMER_PREFIX),
    staff: createListener('staff', shared, routes.staff, STAFF_PREFIX),
  };
}
