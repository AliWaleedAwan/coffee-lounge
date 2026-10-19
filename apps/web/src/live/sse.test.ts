import { describe, expect, it } from 'vitest';
import { SseParser } from './sse.ts';

describe('SSE parser', () => {
  it('reads named events with ids and keeps the last id across messages', () => {
    const p = new SseParser();
    const out = p.push('id: 7\nevent: round.decided\ndata: {"a":1}\n\ndata: plain\n\n');
    expect(out).toEqual([
      { lastEventId: '7', event: 'round.decided', data: '{"a":1}' },
      { lastEventId: '7', event: 'message', data: 'plain' },
    ]);
  });

  it('joins multi-line data, ignores comments and unknown fields, honours retry', () => {
    const p = new SseParser();
    const out = p.push(': heartbeat\n\nretry: 3000\nfoo: bar\ndata: one\ndata:two\n\n');
    expect(out).toEqual([{ lastEventId: '', event: 'message', data: 'one\ntwo' }]);
    expect(p.retryMs).toBe(3000);
  });

  it('handles CRLF and CR line ends and messages split across chunks', () => {
    const p = new SseParser();
    expect(p.push('id: 1\r\nevent: a\r')).toEqual([]);
    expect(p.push('\ndata: x\r\n\r')).toEqual([]); // lone CR at the end may be half of CRLF
    expect(p.push('\nevent: b\rdata: y\r\r\n')).toEqual([
      { lastEventId: '1', event: 'a', data: 'x' },
      { lastEventId: '1', event: 'b', data: 'y' },
    ]);
  });

  it('dispatches nothing for a block without data and ignores ids containing NUL', () => {
    const p = new SseParser();
    expect(p.push('event: resync\n\n')).toEqual([]);
    expect(p.push('id: 5\u0000\ndata: z\n\n')).toEqual([
      { lastEventId: '', event: 'message', data: 'z' },
    ]);
    expect(p.push('retry: soon\n\n')).toEqual([]);
    expect(p.retryMs).toBeNull();
  });

  it('dispatches control events that carry a data line', () => {
    const p = new SseParser();
    expect(p.push('event: resync\ndata: {"reason":"reload"}\n\n')).toEqual([
      { lastEventId: '', event: 'resync', data: '{"reason":"reload"}' },
    ]);
  });
});
