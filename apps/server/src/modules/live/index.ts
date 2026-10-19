/**
 * Staff live-update stream (API.md §7): GET /api/staff/v1/events (Server-Sent Events).
 * Hints only; clients refetch through the API. The customer stream joins in Phase 3
 * with guest access.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { controlFrame, type LiveHub, type Subscriber } from '../../platform/live-hub.ts';
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

export async function liveRoutes(app: FastifyInstance, options: LiveRouteOptions): Promise<void> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const revalidateMs = options.revalidateMs ?? 30_000;
  // Streams never finish by themselves, and closing the server waits for open
  // connections: end them first so a service stop does not hang (clients reconnect).
  const openStreams = new Set<() => void>();
  app.addHook('preClose', async () => {
    for (const close of openStreams) close();
  });

  app.get('/events', async (request, reply) => {
    const auth = authOf(request);
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
      canSee: staffTopicPolicy(auth.permissions),
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
      void sessionStillValid(options.pool, auth.sessionId)
        .then((valid) => {
          if (!valid) close('session_ended');
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
  });
}
