/**
 * Correlation IDs (API.md §2): a client may send X-Correlation-Id (UUID); otherwise one
 * is generated. It becomes Fastify's request id, appears in every log line and in
 * every error body, and is returned in the response header.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CORRELATION_HEADER = 'x-correlation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function correlationIdFor(request: IncomingMessage): string {
  const supplied = request.headers[CORRELATION_HEADER];
  return typeof supplied === 'string' && UUID.test(supplied)
    ? supplied.toLowerCase()
    : randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
