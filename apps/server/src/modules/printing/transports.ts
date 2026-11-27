/**
 * Getting bytes to the printer (PRINTING_HARDWARE.md §2, §5): raw TCP 9100 for a network
 * printer, or a Windows print queue in RAW mode for a USB printer. Every send ends in one
 * of three outcomes, which the job lifecycle relies on:
 *
 *   sent       the printer (TCP) or the spooler accepted every byte. Not proof of paper.
 *   not_sent   nothing reached the printer: safe to retry.
 *   uncertain  bytes may have reached it: never resend automatically (AT-28); staff
 *              confirm or ask for a labelled reprint.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { join } from 'node:path';
import { SERVER_ROOT } from '../../platform/paths.ts';

export type SendResult = { outcome: 'sent' } | { outcome: 'not_sent' | 'uncertain'; error: string };

export interface PrinterTarget {
  name: string;
  connection: 'spooler' | 'tcp';
  address: string;
  supports_status: boolean;
}

export interface Transport {
  send(printer: PrinterTarget, bytes: Buffer): Promise<SendResult>;
}

const DLE = 0x10;
const EOT = 0x04;

/** ESC/POS real-time status (DLE EOT 1 and 2): why the printer is offline, if it is. */
export function offlineReason(status1: number, status2: number): string | null {
  if ((status1 & 0x08) === 0) return null;
  if (status2 & 0x20) return 'Out of paper';
  if (status2 & 0x04) return 'Cover open';
  if (status2 & 0x40) return 'Printer error';
  return 'Printer offline';
}

/** What staff read on the banner, instead of a socket error code. */
export function networkError(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'The printer is not answering. Check that it is on and its cable is plugged in.';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return 'The printer cannot be reached on the network.';
    case 'ECONNRESET':
    case 'EPIPE':
      return 'The printer dropped the connection.';
    default:
      return `Printer connection failed (${e.code ?? e.message})`;
  }
}

export function tcpTransport(
  options: { timeoutMs?: number; statusTimeoutMs?: number } = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 1_500;
  return {
    send(printer, bytes) {
      const [host = '', port = '9100'] = printer.address.split(':');
      return new Promise<SendResult>((resolve) => {
        let jobStarted = false;
        let settled = false;
        const replies: number[] = [];
        let statusWait: ((ok: boolean) => void) | null = null;
        const socket = net.connect({ host, port: Number(port) });
        const finish = (result: SendResult) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(result);
        };
        const failed = (error: string) => {
          finish(jobStarted ? { outcome: 'uncertain', error } : { outcome: 'not_sent', error });
        };
        socket.setTimeout(timeoutMs, () => {
          failed(jobStarted ? 'The printer stopped taking data' : 'The printer did not answer');
        });
        socket.on('error', (e: NodeJS.ErrnoException) => {
          failed(networkError(e));
        });
        socket.on('data', (chunk: Buffer) => {
          replies.push(...chunk);
          if (statusWait && replies.length >= 2) statusWait(true);
        });
        socket.on('close', () => {
          if (!settled) {
            if (jobStarted) finish({ outcome: 'sent' });
            else failed('The printer closed the connection');
          }
        });
        socket.on('connect', () => {
          void (async () => {
            if (printer.supports_status) {
              socket.write(Buffer.from([DLE, EOT, 1, DLE, EOT, 2]));
              const answered = await new Promise<boolean>((r) => {
                statusWait = r;
                setTimeout(() => {
                  r(false);
                }, statusTimeoutMs);
              });
              statusWait = null;
              if (answered) {
                const reason = offlineReason(replies[0] ?? 0, replies[1] ?? 0);
                if (reason) {
                  finish({ outcome: 'not_sent', error: reason });
                  return;
                }
              }
            }
            jobStarted = true;
            // Every byte handed over (a jammed printer never gets here: writes back up and time
            // out). A printer may keep the connection open, so do not wait for it to close; an
            // error in the next second still makes the job uncertain.
            socket.end(bytes, () => {
              setTimeout(() => {
                finish({ outcome: 'sent' });
              }, 1_000);
            });
          })();
        });
      });
    },
  };
}

export const RAWPRINT_SCRIPT = join(SERVER_ROOT, 'assets', 'rawprint.ps1');

/** Windows PowerShell by its full path: a PC's PATH may have lost the Windows folders. */
export const WINDOWS_POWERSHELL = join(
  process.env['SystemRoot'] ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

export function spoolerTransport(
  options: { timeoutMs?: number; script?: string; powershell?: string } = {},
): Transport {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    send(printer, bytes) {
      if (process.platform !== 'win32' && options.powershell === undefined) {
        return Promise.resolve({
          outcome: 'not_sent',
          error: 'Windows print queues exist only on Windows',
        });
      }
      return new Promise<SendResult>((resolve) => {
        const child = spawn(
          options.powershell ?? WINDOWS_POWERSHELL,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            options.script ?? RAWPRINT_SCRIPT,
            '-PrinterName',
            printer.address,
          ],
          { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
        );
        let stderr = '';
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          child.kill();
          resolve({ outcome: 'uncertain', error: 'The print queue did not answer in time' });
        }, timeoutMs);
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString();
        });
        child.on('error', (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({ outcome: 'not_sent', error: `Cannot run PowerShell: ${e.message}` });
        });
        child.on('close', (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const error = stderr.trim().slice(0, 300) || `exit code ${String(code)}`;
          if (code === 0) resolve({ outcome: 'sent' });
          else if (code === 10 || code === 11 || code === 30)
            resolve({ outcome: 'not_sent', error });
          else resolve({ outcome: 'uncertain', error });
        });
        child.stdin.end(bytes.toString('base64'));
      });
    },
  };
}

export function defaultTransports(): Record<PrinterTarget['connection'], Transport> {
  return { tcp: tcpTransport(), spooler: spoolerTransport() };
}
