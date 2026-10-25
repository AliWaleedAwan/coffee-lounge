/**
 * Network receipt printer simulator (TEST_PLAN.md §3; PRINTING_HARDWARE.md §2 "ESC/POS
 * over TCP 9100"). Each TCP connection is one job, as with a real raw-port printer. It
 * captures every byte, answers real-time status requests (DLE EOT n, GS r n) from its
 * current state, and can misbehave on purpose: drop the connection mid-job, stop
 * reading (a jammed printer whose buffer is full), or reset every connection.
 */
import net from 'node:net';
import { decodeEscPos, type Decoded } from './decoder.ts';

export type PaperState = 'ok' | 'near_end' | 'out';

export interface PrinterState {
  paper: PaperState;
  coverOpen: boolean;
  /** Autocutter jammed (DLE EOT 3). */
  cutterError: boolean;
}

export interface Faults {
  /** Reset the connection after this many bytes of a job. */
  dropAfterBytes: number | null;
  /** Stop reading new data (the sender's writes back up). */
  stall: boolean;
  /** Accept, then immediately reset every connection. */
  resetConnections: boolean;
}

export interface CapturedJob {
  id: number;
  bytes: Buffer;
  startedAt: Date;
  endedAt: Date | null;
  /** The sender closed the connection normally (FIN) after sending. */
  complete: boolean;
  /** The simulator cut the connection (dropAfterBytes or resetConnections). */
  dropped: boolean;
  /** Paper came out: printer was ready (paper, cover) while the job arrived. */
  printed: boolean;
  /** Status replies sent back during this job, in order. */
  replies: number[];
  decoded(): Decoded;
}

const FIXED = 0x12; // bits 1 and 4 are always set in ESC/POS status bytes

/** Status byte a typical Epson-compatible printer returns for DLE EOT n. */
export function realtimeStatus(n: number, s: PrinterState): number {
  const offline = s.paper === 'out' || s.coverOpen || s.cutterError;
  switch (n) {
    case 1: // printer status
      return FIXED | (offline ? 0x08 : 0);
    case 2: // offline cause
      return (
        FIXED |
        (s.coverOpen ? 0x04 : 0) |
        (s.paper === 'out' ? 0x20 : 0) |
        (s.cutterError ? 0x40 : 0)
      );
    case 3: // error cause
      return FIXED | (s.cutterError ? 0x08 : 0);
    case 4: // paper roll sensor
      return (
        FIXED |
        (s.paper === 'near_end' || s.paper === 'out' ? 0x0c : 0) |
        (s.paper === 'out' ? 0x60 : 0)
      );
    default:
      return FIXED;
  }
}

/** GS r 1: paper sensor status (near end bits 0-1, end bits 2-3). */
export function transmitStatus(n: number, s: PrinterState): number {
  if (n !== 1 && n !== 49) return 0;
  return (s.paper === 'near_end' || s.paper === 'out' ? 0x03 : 0) | (s.paper === 'out' ? 0x0c : 0);
}

export interface SimulatorOptions {
  host?: string;
  /** 0 picks a free port (tests); 9100 is the real printer port. */
  port?: number;
  onJob?: (job: CapturedJob) => void;
}

export class PrinterSimulator {
  readonly jobs: CapturedJob[] = [];
  state: PrinterState = { paper: 'ok', coverOpen: false, cutterError: false };
  faults: Faults = { dropAfterBytes: null, stall: false, resetConnections: false };
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly waiters: { count: number; resolve: () => void }[] = [];
  private readonly options: SimulatorOptions;
  private boundPort = 0;
  private nextId = 1;

  constructor(options: SimulatorOptions = {}) {
    this.options = options;
  }

  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return this.options.host ?? '127.0.0.1';
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;
    const server = net.createServer((socket) => {
      this.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as net.AddressInfo).port;
    return this.boundPort;
  }

  /** Stops listening and cuts open connections (the printer was switched off). */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }

  /** Resolves when at least `count` jobs have finished (closed or dropped). */
  waitForJobs(count: number, timeoutMs = 5_000): Promise<void> {
    if (this.finishedJobs() >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `printer simulator: ${String(this.finishedJobs())} of ${String(count)} jobs finished`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        count,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  clear(): void {
    this.jobs.length = 0;
  }

  private finishedJobs(): number {
    return this.jobs.filter((j) => j.endedAt !== null).length;
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket);
    const chunks: Buffer[] = [];
    let received = 0;
    let tail = Buffer.alloc(0); // last bytes of the previous chunk, for split commands
    const job: CapturedJob = {
      id: this.nextId++,
      bytes: Buffer.alloc(0),
      startedAt: new Date(),
      endedAt: null,
      complete: false,
      dropped: false,
      printed: false,
      replies: [],
      decoded: () => decodeEscPos(job.bytes),
    };
    this.jobs.push(job);

    const finish = (how: 'complete' | 'dropped' | 'aborted'): void => {
      if (job.endedAt) return;
      job.bytes = Buffer.concat(chunks);
      job.endedAt = new Date();
      job.complete = how === 'complete';
      job.dropped = how === 'dropped';
      job.printed =
        how === 'complete' &&
        this.state.paper !== 'out' &&
        !this.state.coverOpen &&
        !this.state.cutterError;
      this.sockets.delete(socket);
      this.options.onJob?.(job);
      const done = this.finishedJobs();
      for (const w of this.waiters.splice(0)) {
        if (done >= w.count) w.resolve();
        else this.waiters.push(w);
      }
    };

    if (this.faults.resetConnections) {
      finish('dropped');
      socket.resetAndDestroy();
      return;
    }
    if (this.faults.stall) socket.pause();

    socket.on('data', (chunk: Buffer) => {
      let data = chunk;
      const limit = this.faults.dropAfterBytes;
      if (limit !== null && received + data.length >= limit) {
        data = data.subarray(0, Math.max(0, limit - received));
        chunks.push(data);
        received += data.length;
        finish('dropped');
        socket.resetAndDestroy();
        return;
      }
      chunks.push(data);
      received += data.length;
      job.bytes = Buffer.concat(chunks);
      this.answerStatusRequests(socket, job, Buffer.concat([tail, data]), tail.length);
      tail = Buffer.from(data.subarray(Math.max(0, data.length - 2)));
    });
    socket.on('end', () => {
      finish('complete');
      socket.end();
    });
    socket.on('error', () => {
      finish('aborted');
    });
    socket.on('close', () => {
      finish('aborted');
    });
  }

  /** Real-time commands are answered as soon as they arrive, wherever they are. */
  private answerStatusRequests(
    socket: net.Socket,
    job: CapturedJob,
    data: Buffer,
    skip: number,
  ): void {
    for (let i = 0; i + 2 < data.length; i++) {
      // Only commands that end in the new data (not already answered from the tail).
      if (i + 2 < skip) continue;
      let reply: number | null = null;
      if (data[i] === 0x10 && data[i + 1] === 0x04)
        reply = realtimeStatus(data[i + 2] ?? 0, this.state);
      else if (data[i] === 0x1d && data[i + 1] === 0x72)
        reply = transmitStatus(data[i + 2] ?? 0, this.state);
      if (reply !== null) {
        job.replies.push(reply);
        socket.write(Buffer.of(reply));
        i += 2;
      }
    }
  }
}
