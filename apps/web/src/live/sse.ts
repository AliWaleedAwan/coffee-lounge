/**
 * Server-Sent Events parser (WHATWG "event stream interpretation"). The app reads the
 * stream with fetch instead of EventSource: EventSource only reports named events that
 * were registered in advance, and the hint names grow with every phase (API.md §7).
 */
export interface SseMessage {
  /** Last event id seen so far (persists across messages, as in EventSource). */
  lastEventId: string;
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private data: string[] = [];
  private event = '';
  private hasData = false;
  lastEventId = '';
  /** Reconnection delay the server asked for (`retry:`), if any. */
  retryMs: number | null = null;

  /** Feeds decoded text; returns the messages completed by it. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone \r at the very end might be the first half of \r\n: wait for more.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message) messages.push(message);
    }
    return messages;
  }

  private line(line: string): SseMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null; // comment (heartbeat)
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        this.hasData = true;
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
    return null;
  }

  private dispatch(): SseMessage | null {
    const message = this.hasData
      ? {
          lastEventId: this.lastEventId,
          event: this.event || 'message',
          data: this.data.join('\n'),
        }
      : null;
    this.data = [];
    this.event = '';
    this.hasData = false;
    return message;
  }
}
