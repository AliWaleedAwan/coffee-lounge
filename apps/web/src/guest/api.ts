/**
 * Guest API client (API.md §5.1): same origin as the customer listener, cookies only,
 * no staff headers. Errors arrive as problem+json and become GuestError with the code.
 */
export const GUEST_API = '/api/customer/v1';

export class GuestError extends Error {
  override name = 'GuestError';
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function guestApi<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${GUEST_API}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new GuestError(
      0,
      'NETWORK_ERROR',
      'No connection to the shop. Check you are on the shop Wi-Fi and try again.',
    );
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // not JSON
    }
    const code = typeof body['code'] === 'string' ? body['code'] : 'UNEXPECTED_RESPONSE';
    const detail =
      typeof body['detail'] === 'string'
        ? body['detail']
        : 'Something went wrong. Please try again.';
    throw new GuestError(res.status, code, detail, body);
  }
  return (await res.json()) as T;
}

/** sessionStorage that never throws (private mode, storage full). */
export const memo = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = sessionStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not kept across reloads; the app still works
    }
  },
};
