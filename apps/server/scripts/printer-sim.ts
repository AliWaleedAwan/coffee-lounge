/**
 * Stand-in for the shop's receipt printer (TEST_PLAN.md §3: staging VM, manual tests).
 * Listens like a network printer on raw TCP and saves each job as job-<n>.bin with a
 * decoded job-<n>.txt next to it.
 *
 *   node scripts/printer-sim.ts [--port 9100] [--host 127.0.0.1] [--out ./print-captures]
 *     [--paper ok|near_end|out] [--cover-open]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PrinterSimulator, type PaperState } from '../test/support/escpos/simulator.ts';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9100' },
    host: { type: 'string', default: '127.0.0.1' },
    out: { type: 'string', default: 'print-captures' },
    paper: { type: 'string', default: 'ok' },
    'cover-open': { type: 'boolean', default: false },
  },
});
const paper = values.paper as PaperState;
if (!['ok', 'near_end', 'out'].includes(paper)) {
  console.error('--paper must be ok, near_end or out');
  process.exit(1);
}
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

const printer = new PrinterSimulator({
  host: values.host,
  port: Number(values.port),
  onJob: (job) => {
    const d = job.decoded();
    const base = join(out, `job-${String(job.id)}`);
    writeFileSync(`${base}.bin`, job.bytes);
    const summary = [
      `job ${String(job.id)}: ${String(job.bytes.length)} bytes, ${job.complete ? 'complete' : job.dropped ? 'dropped' : 'aborted'}, ${job.printed ? 'printed' : 'NOT printed'}`,
      `cuts: ${d.cuts.map((c) => c.kind).join(', ') || 'none'} · images: ${String(d.images.length)} · drawer pulses: ${String(d.drawerKicks)} · unknown: ${String(d.unknown.length)}`,
      '-'.repeat(48),
      d.text,
      '-'.repeat(48),
    ].join('\n');
    writeFileSync(`${base}.txt`, `${summary}\n`);
    console.log(summary.split('\n').slice(0, 2).join(' | '));
  },
});
printer.state = { paper, coverOpen: values['cover-open'], cutterError: false };
await printer.start();
console.log(`printer simulator on ${values.host}:${String(printer.port)} → ${out}`);
const stop = (): void => {
  void printer.stop().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
