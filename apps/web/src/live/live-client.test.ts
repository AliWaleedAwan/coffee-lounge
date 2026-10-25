import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveClient, type LiveClientOptions, type LiveHint } from './live-client.ts';

/** A controllable streaming response. */
function streamResponse(status = 200) {
  let push: (text: string) => void = () => undefined;
  let end: () => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => {
        controller.enqueue(encoder.encode(text));
      };
      end = () => {
        controller.close();
      };
      fail = (e) => {
        controller.error(e);
      };
    },
  });
  return { response: new Response(body, { status }), push, end, fail };
}

interface Harness {
  client: LiveClient;
  calls: { url: string; headers: Record<string, string> }[];
  hints: LiveHint[];
  log: string[];
  streams: ReturnType<typeof streamResponse>[];
}

function harness(
  responses: (() => Response | Promise<Response>)[],
  extra: Partial<LiveClientOptions> = {},
): Harness {
  const calls: Harness['calls'] = [];
  const hints: LiveHint[] = [];
  const log: string[] = [];
  const streams: Harness['streams'] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const next = responses.shift();
    if (!next) return new Promise<Response>(() => undefined); // hang
    return next();
  });
  const client = new LiveClient({
    url: '/api/staff/v1/events',
    fetchImpl,
    retryMs: 5,
    random: () => 0.5,
    onHint: (h) => hints.push(h),
    onResync: () => log.push('resync'),
    onOpen: () => log.push('open'),
    onLost: () => log.push('lost'),
    onRefused: (status) => log.push(`refused ${String(status)}`),
    ...extra,
  });
  return { client, calls, hints, log, streams };
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let active: LiveClient | undefined;
afterEach(() => {
  active?.stop();
});

describe('live client', () => {
  it('parses hints and marks the stream as background traffic', async () => {
    const s = streamResponse();
    const h = harness([() => s.response]);
    active = h.client;
    h.client.start();
    await until(() => h.log.includes('open'));
    s.push(
      'retry: 3000\n\nid: 41\nevent: round.decided\ndata: {"entity":{"type":"round","id":"812","version":3},"topics":["approvals","table:5"]}\n\n',
    );
    await until(() => h.hints.length === 1);
    expect(h.hints[0]).toEqual({
      id: '41',
      event: 'round.decided',
      topics: ['approvals', 'table:5'],
      entity: { type: 'round', id: '812', version: 3 },
    });
    expect(h.calls[0]?.headers).toMatchObject({
      accept: 'text/event-stream',
      'x-cl-background': '1',
    });
    expect(h.calls[0]?.headers['last-event-id']).toBeUndefined();
  });

  it('reconnects after a drop with Last-Event-ID and asks views to refetch', async () => {
    const first = streamResponse();
    const second = streamResponse();
    const h = harness([() => first.response, () => second.response]);
    active = h.client;
    h.client.start();
    await until(() => h.log.includes('open'));
    first.push('id: 9\nevent: x.y\ndata: {"topics":["floor"]}\n\n');
    await until(() => h.hints.length === 1);
    first.fail(new Error('network gone'));
    await until(() => h.calls.length === 2 && h.log.filter((l) => l === 'open').length === 2);
    expect(h.calls[1]?.headers['last-event-id']).toBe('9');
    expect(h.log).toEqual(['open', 'lost', 'open', 'resync']);
  });

  it('passes on resync requests and stops for good when the session ends', async () => {
    const s = streamResponse();
    const h = harness([() => s.response]);
    active = h.client;
    h.client.start();
    await until(() => h.log.includes('open'));
    s.push('event: resync\ndata: {"reason":"reload your views"}\n\n');
    await until(() => h.log.includes('resync'));
    s.push('event: session_ended\ndata: {}\n\n');
    await until(() => h.log.includes('refused 401'));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls).toHaveLength(1); // no reconnection attempt
  });

  it('does not retry a refused stream (401/403)', async () => {
    const h = harness([() => new Response(null, { status: 403 })]);
    active = h.client;
    h.client.start();
    await until(() => h.log.includes('refused 403'));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls).toHaveLength(1);
    expect(h.log).toEqual(['refused 403']);
  });

  it('backs off while the server is unreachable and reports the loss once', async () => {
    const timeouts: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: () => void, ms?: number) => {
        // Only the client's reconnection delays (the test's own polling uses 5 ms).
        if (typeof ms === 'number' && ms >= 50) timeouts.push(ms);
        return realSetTimeout(fn, 1);
      });
    try {
      const down = () => Promise.reject(new TypeError('Failed to fetch'));
      const s = streamResponse();
      const h = harness([down, down, down, () => s.response], { retryMs: 100, maxRetryMs: 300 });
      active = h.client;
      h.client.start();
      await until(() => h.log.includes('open'));
      expect(h.log).toEqual(['lost', 'open', 'resync']);
      expect(timeouts.slice(0, 3)).toEqual([100, 200, 300]); // doubled, capped
    } finally {
      spy.mockRestore();
    }
  });
});
