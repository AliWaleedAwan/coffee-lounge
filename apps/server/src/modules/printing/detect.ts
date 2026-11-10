/**
 * The Windows print queues this PC knows (Phase 8 step 8.6). The server is the counter PC, so
 * tablets and phones see the same list. Its service account may not see every queue on a real
 * PC (PLAN.md §7), so typing the name stays possible, and a failure here is never fatal.
 */
import { execFile } from 'node:child_process';
import { WINDOWS_POWERSHELL } from './transports.ts';

export interface DetectedQueue {
  name: string;
  driver: string;
  port: string;
}

export type QueueDetection =
  { supported: false; queues: [] } | { supported: true; queues: DetectedQueue[]; problem?: string };

export type QueueLister = () => Promise<string>;

const SCRIPT = 'Get-Printer | Select-Object Name,DriverName,PortName | ConvertTo-Json -Compress';

/** ConvertTo-Json gives one object for one printer, an array for more, nothing for none. */
export function parseQueues(output: string): DetectedQueue[] {
  const text = output.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  return list.flatMap((entry) => {
    const { Name, DriverName, PortName } = (entry ?? {}) as Record<string, unknown>;
    if (typeof Name !== 'string' || !Name) return [];
    return [
      {
        name: Name,
        driver: typeof DriverName === 'string' ? DriverName : '',
        port: typeof PortName === 'string' ? PortName : '',
      },
    ];
  });
}

const powershellQueues: QueueLister = () =>
  new Promise((resolve, reject) => {
    execFile(
      WINDOWS_POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        if (error) reject(new Error(error.message));
        else resolve(stdout);
      },
    );
  });

export async function detectQueues(
  list: QueueLister = powershellQueues,
  platform: string = process.platform,
): Promise<QueueDetection> {
  if (platform !== 'win32' && list === powershellQueues) return { supported: false, queues: [] };
  try {
    return { supported: true, queues: parseQueues(await list()) };
  } catch {
    return {
      supported: true,
      queues: [],
      problem: 'Windows would not list its printers. Type the printer name instead.',
    };
  }
}
