import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../connection/store.ts';
import { noteUserActivity } from './activity.ts';
import { api, ApiError, messageOf } from './client.ts';

const problem = (
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  connection.report({ type: 'api_ok' });
  connection.report({ type: 'stream_stopped' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const sentHeaders = (call = 0): Record<string, string> =>
  (fetchMock.mock.calls[call]?.[1] as RequestInit).headers as Record<string, string>;

describe('staff API client', () => {
  it('sends the CSRF header and JSON body on writes, same-origin', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api('/auth/logout', { method: 'POST', body: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/staff/v1/auth/logout');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
    expect(sentHeaders()).toMatchObject({
      'x-cl-request': '1',
      'content-type': 'application/json',
    });
    expect(sentHeaders()['x-cl-background']).toBeUndefined();
  });

  it('marks reads as background unless the user has just used the device', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
    noteUserActivity(Date.now() - 60_000);
    await api('/auth/me');
    expect(sentHeaders(0)['x-cl-background']).toBe('1');
    expect(sentHeaders(0)['x-cl-request']).toBeUndefined();
    noteUserActivity();
    await api('/auth/me');
    expect(sentHeaders(1)['x-cl-background']).toBeUndefined();
  });

  it('turns problem+json into ApiError with code, fields and Retry-After', async () => {
    fetchMock.mockResolvedValue(
      problem(
        429,
        {
          code: 'RATE_LIMITED',
          detail: 'Too many failed attempts.',
          fields: [{ path: 'pin', message: 'x' }, 7],
        },
        { 'retry-after': '120' },
      ),
    );
    const error = await api('/auth/pin-switch', { method: 'POST', body: {} }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    const e = error as ApiError;
    expect([e.status, e.code, e.message, e.retryAfterSeconds]).toEqual([
      429,
      'RATE_LIMITED',
      'Too many failed attempts.',
      120,
    ]);
    expect(e.fields).toEqual([{ path: 'pin', message: 'x' }]);
    expect(messageOf(e)).toBe('Too many failed attempts. (about 2 min)');
    expect(messageOf(new Error('raw internals'))).toBe('Something went wrong. Please try again.');
  });

  it('reports the connection state from responses', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api('/auth/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    expect(connection.getSnapshot().status).toBe('reconnecting');

    fetchMock.mockResolvedValueOnce(
      problem(503, { code: 'SERVER_STARTING', detail: 'Clock behind' }),
    );
    await expect(api('/auth/me')).rejects.toMatchObject({ code: 'SERVER_STARTING' });
    expect(connection.getSnapshot()).toMatchObject({ status: 'starting', detail: 'Clock behind' });

    fetchMock.mockResolvedValueOnce(problem(503, { code: 'DATABASE_UNAVAILABLE', detail: 'x' }));
    await expect(api('/auth/me')).rejects.toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    expect(connection.getSnapshot().status).toBe('database_unavailable');

    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await api('/auth/me');
    expect(connection.getSnapshot().status).toBe('online');
  });

  it('keeps unknown or non-JSON errors generic', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad gateway</html>', { status: 502 }));
    await expect(api('/x')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
      message: 'The server answered 502.',
    });
  });
});
