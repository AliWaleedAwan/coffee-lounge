/**
 * Staff API client (API.md §2, §6). Same-origin only: cookies carry the device and
 * session; every write sends `X-CL-Request: 1` (CSRF rule). Errors arrive as
 * problem+json and become ApiError with the stable `code`. Every response also tells
 * the connection store whether the server and its database are reachable. Reads made
 * while nobody is using the device carry `X-CL-Background: 1` (see activity.ts).
 */
import { isErrorCode, type ErrorCode } from '@cl/shared';
import { connection } from '../connection/store.ts';
import { userRecentlyActive } from './activity.ts';

export const API_BASE = '/api/staff/v1';

export type ClientErrorCode = ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fields: FieldError[];
  readonly retryAfterSeconds: number | null;
  readonly body: Record<string, unknown>;

  constructor(
    status: number,
    code: ClientErrorCode,
    message: string,
    extra: {
      fields?: FieldError[];
      retryAfterSeconds?: number | null;
      body?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = extra.fields ?? [];
    this.retryAfterSeconds = extra.retryAfterSeconds ?? null;
    this.body = extra.body ?? {};
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFields(value: unknown): FieldError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f: unknown) =>
    isRecord(f) && typeof f['path'] === 'string' && typeof f['message'] === 'string'
      ? [{ path: f['path'], message: f['message'] }]
      : [],
  );
}

/** Turns a non-2xx response into an ApiError, reporting reachability on the way. */
export async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON (e.g. a proxy error page)
  }
  const record = isRecord(body) ? body : {};
  const rawCode = typeof record['code'] === 'string' ? record['code'] : '';
  const code: ClientErrorCode = isErrorCode(rawCode) ? rawCode : 'UNEXPECTED_RESPONSE';
  const detail =
    typeof record['detail'] === 'string' ? record['detail'] : `The server answered ${res.status}.`;
  if (code === 'SERVER_STARTING') connection.report({ type: 'api_starting', detail });
  else if (code === 'DATABASE_UNAVAILABLE') connection.report({ type: 'api_database' });
  else connection.report({ type: 'api_ok' });
  const retryAfter = Number(res.headers.get('retry-after'));
  return new ApiError(res.status, code, detail, {
    fields: toFields(record['fields']),
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    body: record,
  });
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-cl-request'] = '1';
  else if (!userRecentlyActive()) headers['x-cl-background'] = '1';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    connection.report({ type: 'api_network_error' });
    throw new ApiError(0, 'NETWORK_ERROR', 'The server cannot be reached.');
  }
  if (!res.ok) throw await errorFrom(res);
  connection.report({ type: 'api_ok' });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** A message fit to show under a form, from any error. */
export function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds !== null) {
      return `${error.message} (about ${Math.ceil(error.retryAfterSeconds / 60)} min)`;
    }
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}
