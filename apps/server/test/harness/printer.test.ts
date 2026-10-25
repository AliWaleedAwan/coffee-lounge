/** Self-tests for the ESC/POS decoder and the TCP printer simulator (PLAN.md step 2.10). */
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeEscPos } from '../support/escpos/decoder.ts';
import { PrinterSimulator, realtimeStatus } from '../support/escpos/simulator.ts';

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const bytes = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

/** A small kitchen ticket, as the Phase 3 renderer will produce it. */
const TICKET = bytes(
  [ESC, 0x40],
  [ESC, 0x74, 16], // code page 1252
  [ESC, 0x61, 1],
  [ESC, 0x45, 1],
  'KITCHEN  K-1019-118\n',
  [ESC, 0x45, 0],
  [ESC, 0x61, 0],
  '2 x Cappuccino (Regular)\n',
  '    + Oat milk\n',
  [ESC, 0x64, 2],
  [GS, 0x56, 66, 3], // partial cut after feeding 3 lines
);

describe('ESC/POS decoder', () => {
  it('reads text, styles, alignment, feeds and cuts', () => {
    const d = decodeEscPos(TICKET);
    expect(d.text).toBe('KITCHEN  K-1019-118\n2 x Cappuccino (Regular)\n    + Oat milk\n\n');
    expect(d.lines[0]?.style).toMatchObject({ bold: true, align: 'center' });
    expect(d.lines[1]?.style).toMatchObject({ bold: false, align: 'left' });
    expect(d.cuts).toEqual([{ kind: 'partial', feedLines: 3, afterLine: 5 }]);
    expect(d.codePage).toBe(16);
    expect(d.unknown).toEqual([]);
    expect(d.drawerKicks).toBe(0);
  });

  it('decodes the upper half with the selected code page', () => {
    expect(decodeEscPos(bytes([0x9c, 0x0a])).text).toBe('£'); // CP437 default
    expect(decodeEscPos(bytes([ESC, 0x74, 16, 0xa3, 0x0a])).text).toBe('£'); // CP1252
    expect(decodeEscPos(bytes([ESC, 0x74, 16, 0x80, 0x0a])).text).toBe('€');
  });

  it('skips image and barcode payloads instead of printing them as text', () => {
    const raster = bytes(
      [GS, 0x76, 0x30, 0, 2, 0, 3, 0],
      [0x0a, 0x41, 0x0a, 0x42, 0x0a, 0x43],
      'after\n',
    );
    const d = decodeEscPos(raster);
    expect(d.images).toEqual([{ kind: 'raster', widthDots: 16, heightDots: 3 }]);
    expect(d.text).toBe('after');

    const qrData = 'https://192.168.100.250:8080/q/abc';
    const store = [49, 80, 48, ...Buffer.from(qrData)];
    const qr = bytes([GS, 0x28, 0x6b, store.length & 0xff, store.length >> 8], store);
    const code = bytes([GS, 0x6b, 4], 'INV123', [0]);
    const d2 = decodeEscPos(Buffer.concat([qr, code]));
    expect(d2.barcodes).toEqual([
      { kind: '2d', data: qrData },
      { kind: '1d', data: 'INV123' },
    ]);
    expect(d2.text).toBe('');
  });

  it('records drawer pulses, status requests, unknown and truncated commands', () => {
    const d = decodeEscPos(
      bytes(
        [ESC, 0x70, 0, 25, 250],
        [DLE, 0x04, 4],
        [GS, 0x72, 1],
        [ESC, 0x7e],
        'x',
        [0x07],
        [GS, 0x56],
      ),
    );
    expect(d.drawerKicks).toBe(1);
    expect(d.statusRequests).toEqual([
      { command: 'DLE EOT', n: 4 },
      { command: 'GS r', n: 1 },
    ]);
    expect(d.unknown).toEqual([
      { offset: 11, bytes: [ESC, 0x7e], reason: 'unsupported ESC command' },
      { offset: 14, bytes: [0x07], reason: 'control character' },
      { offset: 15, bytes: [GS, 0x56], reason: 'truncated command' },
    ]);
    expect(d.text).toBe('x');
  });
});

describe('printer simulator (TCP)', () => {
  let printer: PrinterSimulator;
  beforeEach(async () => {
    printer = new PrinterSimulator();
    await printer.start();
  });
  afterEach(async () => {
    await printer.stop();
  });

  /** Sends one job the way the worker will: connect, write, end. */
  function send(
    data: Buffer,
    { readReplies = 0, timeoutMs = 2_000 }: { readReplies?: number; timeoutMs?: number } = {},
  ): Promise<{ replies: number[] }> {
    return new Promise((resolve, reject) => {
      const replies: number[] = [];
      const socket = net.connect(printer.port, '127.0.0.1');
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error('timeout'));
      });
      socket.on('data', (chunk: Buffer) => replies.push(...chunk));
      socket.on('error', reject);
      socket.on('close', () => {
        resolve({ replies });
      });
      socket.write(data, () => {
        if (readReplies === 0) socket.end();
        else {
          const check = setInterval(() => {
            if (replies.length >= readReplies) {
              clearInterval(check);
              socket.end();
            }
          }, 5);
        }
      });
    });
  }

  it('captures each connection as one job, byte for byte, in order', async () => {
    await send(TICKET);
    await send(bytes('second\n', [GS, 0x56, 1]));
    await printer.waitForJobs(2);
    expect(printer.jobs.map((j) => j.id)).toEqual([1, 2]);
    expect(printer.jobs[0]?.bytes.equals(TICKET)).toBe(true);
    expect(printer.jobs[0]).toMatchObject({ complete: true, dropped: false, printed: true });
    expect(printer.jobs[1]?.decoded().cuts).toEqual([
      { kind: 'partial', feedLines: 0, afterLine: 1 },
    ]);
  });

  it('answers status requests from its paper and cover state', async () => {
    const ask = bytes([DLE, 0x04, 1], [DLE, 0x04, 2], [DLE, 0x04, 4], [GS, 0x72, 1]);
    const ok = await send(ask, { readReplies: 4 });
    expect(ok.replies).toEqual([0x12, 0x12, 0x12, 0x00]);

    printer.state = { paper: 'out', coverOpen: false, cutterError: false };
    const out = await send(ask, { readReplies: 4 });
    expect(out.replies).toEqual([0x1a, 0x32, 0x7e, 0x0f]); // offline, paper end, sensor, GS r

    printer.state = { paper: 'ok', coverOpen: true, cutterError: false };
    expect((await send(bytes([DLE, 0x04, 2]), { readReplies: 1 })).replies).toEqual([0x16]);
    expect(realtimeStatus(3, { paper: 'ok', coverOpen: false, cutterError: true })).toBe(0x1a);
  });

  it('answers a status request split across two TCP packets', async () => {
    const replies: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(printer.port, '127.0.0.1', () => {
        socket.setNoDelay(true);
        socket.write(Buffer.of(DLE));
        setTimeout(() => socket.write(Buffer.of(0x04, 4)), 50);
      });
      socket.on('data', (c: Buffer) => {
        replies.push(...c);
        socket.end();
      });
      socket.on('close', () => {
        resolve();
      });
      socket.on('error', reject);
    });
    expect(replies).toEqual([0x12]);
  });

  it('accepts bytes while out of paper but nothing is printed (sent ≠ printed)', async () => {
    printer.state = { paper: 'out', coverOpen: false, cutterError: false };
    await send(TICKET);
    await printer.waitForJobs(1);
    expect(printer.jobs[0]).toMatchObject({ complete: true, printed: false });
  });

  it('drops a job part-way, as a printer losing power mid-send', async () => {
    printer.faults.dropAfterBytes = 10;
    const big = Buffer.concat(Array.from({ length: 200 }, () => TICKET));
    await expect(send(big)).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNRESET|EPIPE/) as unknown,
    });
    await printer.waitForJobs(1);
    expect(printer.jobs[0]).toMatchObject({ complete: false, dropped: true, printed: false });
    expect(printer.jobs[0]?.bytes.length).toBe(10);
  });

  it('stops reading when stalled, so the sender’s writes back up (and time out)', async () => {
    printer.faults.stall = true;
    const huge = Buffer.alloc(32 * 1024 * 1024, 0x41);
    await expect(send(huge, { timeoutMs: 500 })).rejects.toThrow('timeout');
  });

  it('resets connections on demand and refuses them when switched off', async () => {
    printer.faults.resetConnections = true;
    await expect(send(TICKET)).rejects.toMatchObject({
      code: expect.stringMatching(/ECONNRESET|EPIPE/) as unknown,
    });
    const port = printer.port;
    await printer.stop();
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          resolve('connected');
        });
        socket.on('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
