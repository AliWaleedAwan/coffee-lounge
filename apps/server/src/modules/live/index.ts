/**
 * Live-update streams (API.md §7), Server-Sent Events. Hints only; clients refetch
 * through the API.
 *
 *  GET /api/staff/v1/events     topics by the user's permissions; ends with the session.
 *  GET /api/customer/v1/events  a guest phone: its own session and the menu, nothing
 *                               else; ends with the visit (step 3.11).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { AppError } from '../../platform/errors.ts';
import { controlFrame, type LiveHub, type Subscriber } from '../../platform/live-hub.ts';
import {
  ENTRY_COOKIE,
  GUEST_COOKIE,
  guestFromToken,
  looksLikeToken,
  resolveEntry,
} from '../floor/index.ts';
import { authOf, sessionStillValid } from '../identity/index.ts';
import { staffTopicPolicy } from './topics.ts';

export { staffTopicPolicy, TOPIC_PERMISSIONS } from './topics.ts';

export interface LiveRouteOptions {
  pool: pg.Pool;
  hub: LiveHub;
  heartbeatMs?: number;
  revalidateMs?: number;
}

/** A slow client whose unsent data passes this is dropped; it reconnects and replays. */
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * Serves one SSE stream: heartbeats, a periodic check that the reader may still listen
 * (`stillValid` returns the event to end with, or null), replay from Last-Event-ID.
 */
function streamRoute(
  app: FastifyInstance,
  options: LiveRouteOptions,
  config: { auth?: 'public' },
  access: (request: FastifyRequest) => Promise<{
    canSee: (topic: string) => boolean;
    stillValid: () => Promise<string | null>;
  }>,
): void {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const revalidateMs = options.revalidateMs ?? 30_000;
  // Streams never finish by themselves, and closing the server waits for open
  // connections: end them first so a service stop does not hang (clients reconnect).
  const openStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of openStreams) close();
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const { canSee, stillValid } = await access(request);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'x-correlation-id': request.id,
    });
    raw.write(`retry: 3000\n\n`);

    let open = true;
    const close = (event?: string): void => {
      if (!open) return;
      open = false;
      openStreams.delete(close);
      clearInterval(heartbeat);
      clearInterval(revalidate);
      options.hub.unsubscribe(subscriber.id);
      if (event && !raw.writableEnded) raw.write(controlFrame(event));
      raw.end();
    };

    const subscriber: Subscriber = {
      id: randomUUID(),
      canSee,
      write(frame) {
        if (!open) return false;
        if (raw.writableLength > MAX_BUFFERED_BYTES) {
          request.log.warn('live stream too slow; dropping (client will reconnect)');
          close();
          return false;
        }
        raw.write(frame);
        return true;
      },
    };

    const heartbeat = setInterval(() => {
      if (open) raw.write(': heartbeat\n\n');
    }, heartbeatMs);
    const revalidate = setInterval(() => {
      void stillValid()
        .then((end) => {
          if (end) close(end);
        })
        .catch(() => undefined);
    }, revalidateMs);
    request.raw.on('close', () => {
      close();
    });
    openStreams.add(close);

    const lastEventId = request.headers['last-event-id'];
    await options.hub.subscribe(
      subscriber,
      typeof lastEventId === 'string' ? lastEventId : undefined,
    );
  };
  app.get('/events', { config }, handler);
}

export async function liveRoutes(app: FastifyInstance, options: LiveRouteOptions): Promise<void> {
  streamRoute(app, options, {}, (request) => {
    const auth = authOf(request);
    return Promise.resolve({
      canSee: staffTopicPolicy(auth.permissions),
      stillValid: async () =>
        (await sessionStillValid(options.pool, auth.sessionId)) ? null : 'session_ended',
    });
  });
}

/**
 * The guest stream: `session:<own>` (once the phone has ordered) and `menu`. A phone that
 * has only scanned the code hears menu changes; it reconnects after its first order.
 */
export async function customerLiveRoutes(
  app: FastifyInstance,
  options: LiveRouteOptions & { now?: () => Date },
): Promise<void> {
  const now = options.now ?? (() => new Date());
  streamRoute(app, options, { auth: 'public' }, async (request) => {
    const token = request.cookies[GUEST_COOKIE];
    if (token !== undefined) {
      const guest = await guestFromToken(
        options.pool,
        looksLikeToken(token) ? token : 'x'.repeat(22),
      );
      const own = `session:${guest.session.id}`;
      return {
        canSee: (topic) => topic === 'menu' || topic === own,
        stillValid: async () => {
          try {
            await guestFromToken(options.pool, token);
            return null;
          } catch {
            return 'visit_ended';
          }
        },
      };
    }
    const cookie = request.cookies[ENTRY_COOKIE];
    if (!(await resolveEntry(options.pool, cookie, now()))) {
      throw new AppError('VISIT_ENDED', 'Scan the QR code on your table to see the menu.');
    }
    return {
      canSee: (topic) => topic === 'menu',
      stillValid: async () =>
        (await resolveEntry(options.pool, cookie, now())) ? null : 'visit_ended',
    };
  });
}
