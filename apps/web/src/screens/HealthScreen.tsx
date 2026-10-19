/**
 * System health (API.md §5.8, AT-120). No automatic polling: an authenticated request
 * counts as activity and would keep the session from locking. It refreshes on focus,
 * on `system` hints, and on the Refresh button.
 */
import { useQuery } from '@tanstack/react-query';
import { api, messageOf } from '../api/client.ts';

export interface SystemHealth {
  api: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
  worker: { status: 'ok' | 'stale' | 'down'; lastHeartbeatAt: string | null };
  printer: { status: 'ok' | 'error' | 'unknown'; openJobs: number };
  backup: { lastSuccessAt: string | null; lastVerifiedAt: string | null; usbDrivePresent: boolean };
  disk: { freePercent: number | null; status: 'ok' | 'warning' | 'critical' | 'unknown' };
  internet: 'online' | 'offline';
  warnings: Record<string, string>;
  version: string;
  checkedAt: string;
}

type Tone = 'ok' | 'warning' | 'danger' | 'info';

interface Row {
  label: string;
  value: string;
  tone: Tone;
  note?: string;
}

const time = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string | null): string => (iso ? time.format(new Date(iso)) : 'never');

export function healthRows(h: SystemHealth): Row[] {
  return [
    {
      label: 'Server',
      value: h.api === 'ok' ? 'Running' : 'Needs attention',
      tone: h.api === 'ok' ? 'ok' : 'warning',
      note: `Version ${h.version}`,
    },
    {
      label: 'Database',
      value: h.database === 'ok' ? 'Connected' : 'Not reachable',
      tone: h.database === 'ok' ? 'ok' : 'danger',
    },
    {
      label: 'Background worker',
      value: { ok: 'Running', stale: 'Stopped responding', down: 'Not running' }[h.worker.status],
      tone: h.worker.status === 'ok' ? 'ok' : 'danger',
      note: `Last heartbeat: ${when(h.worker.lastHeartbeatAt)}`,
    },
    {
      label: 'Disk space',
      value: h.disk.freePercent === null ? 'Unknown' : `${h.disk.freePercent.toFixed(1)} % free`,
      tone: { ok: 'ok', warning: 'warning', critical: 'danger', unknown: 'info' }[
        h.disk.status
      ] as Tone,
      ...(h.disk.status === 'warning' || h.disk.status === 'critical'
        ? { note: 'Free up space or ask the technician.' }
        : {}),
    },
    {
      label: 'Backup drive',
      value: h.backup.usbDrivePresent ? 'Plugged in' : 'Missing',
      tone: h.backup.usbDrivePresent ? 'ok' : 'warning',
      note: `Last backup: ${when(h.backup.lastSuccessAt)}`,
    },
    {
      label: 'Printer',
      value: { ok: 'Ready', error: 'Problem', unknown: 'Not set up yet' }[h.printer.status],
      tone: { ok: 'ok', error: 'danger', unknown: 'info' }[h.printer.status] as Tone,
      note: `${h.printer.openJobs} jobs waiting`,
    },
    {
      label: 'Internet',
      value: h.internet === 'online' ? 'Online' : 'Offline',
      tone: h.internet === 'online' ? 'ok' : 'info',
      note: 'The shop works without internet.',
    },
  ];
}

const CHIP: Record<Tone, string> = {
  ok: 'chip chip-ok',
  warning: 'chip chip-warning',
  danger: 'chip chip-danger',
  info: 'chip chip-info',
};

export function HealthScreen() {
  const health = useQuery({
    queryKey: ['system', 'health'],
    queryFn: ({ signal }) => api<SystemHealth>('/system/health', { signal }),
    meta: { topics: ['system'] },
  });

  return (
    <>
      <h1>System health</h1>
      {health.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(health.error)}
        </div>
      ) : null}
      {health.data ? (
        <>
          {Object.entries(health.data.warnings).map(([key, text]) => (
            <div key={key} role="alert" className="banner banner-warning">
              {text}
            </div>
          ))}
          <div className="grid-tiles">
            {healthRows(health.data).map((row) => (
              <section key={row.label} className="card stack" aria-label={row.label}>
                <h2>{row.label}</h2>
                <span className={CHIP[row.tone]}>{row.value}</span>
                {row.note ? <p className="muted">{row.note}</p> : null}
              </section>
            ))}
          </div>
          <p className="muted">Checked {when(health.data.checkedAt)}</p>
        </>
      ) : health.isPending ? (
        <p role="status">Loading…</p>
      ) : null}
      <div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          {health.isFetching ? 'Checking…' : 'Refresh'}
        </button>
      </div>
    </>
  );
}
