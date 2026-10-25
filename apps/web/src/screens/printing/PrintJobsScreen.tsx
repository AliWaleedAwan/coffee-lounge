/**
 * Print jobs (PRINTING_HARDWARE.md §5–§6): what has not printed yet. After fixing paper
 * or a cable, Retry all prints the waiting jobs in order, once. A job the printer may or
 * may not have printed asks "Did it print?": Yes closes it; No prints a labelled reprint.
 */
import { messageOf } from '../../api/client.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { usePrinterStatus, usePrintJobs, usePrintWrite, type PrintJob } from './printing-api.ts';

const STATUS: Record<PrintJob['status'], { text: string; chip: string }> = {
  queued: { text: 'Waiting', chip: 'chip chip-info' },
  sending: { text: 'Sending', chip: 'chip chip-info' },
  retrying: { text: 'Trying again', chip: 'chip chip-warning' },
  needs_attention: { text: 'Needs attention', chip: 'chip chip-danger' },
  uncertain: { text: 'Did it print?', chip: 'chip chip-warning' },
};

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function PrintJobsScreen() {
  const writes = useWritesAllowed();
  const jobs = usePrintJobs();
  const printers = usePrinterStatus(true);
  const act = usePrintWrite();
  const items = jobs.data?.items ?? [];
  return (
    <>
      <h1>Print jobs</h1>
      {jobs.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(jobs.error)}
        </div>
      ) : null}
      {act.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(act.error)}
        </div>
      ) : null}
      {(printers.data?.printers ?? [])
        .filter((p) => p.state !== 'ok')
        .map((p) => (
          <div key={p.id} className="card row">
            <span>
              <strong>{p.name}</strong>: {p.lastError ?? 'not printing'}. Fix the paper, cover or
              cable first.
            </span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!writes || act.isPending}
              onClick={() => {
                act.mutate({ path: `/printers/${p.id}/retry-all` });
              }}
            >
              Retry all on {p.name}
            </button>
          </div>
        ))}
      {jobs.data && items.length === 0 ? <p className="muted">Everything has printed.</p> : null}
      {items.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Printer</th>
              <th scope="col">Since</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((j) => (
              <tr key={j.id}>
                <td>
                  {j.document}
                  {j.copyNo > 1 ? <span className="muted"> · reprint {j.copyNo}</span> : null}
                </td>
                <td>{j.printer}</td>
                <td>{time.format(new Date(j.createdAt))}</td>
                <td>
                  <span className={STATUS[j.status].chip}>{STATUS[j.status].text}</span>
                  {j.lastError ? <div className="muted">{j.lastError}</div> : null}
                </td>
                <td>
                  <div className="row">
                    {j.status === 'needs_attention' || j.status === 'retrying' ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!writes || act.isPending}
                        onClick={() => {
                          act.mutate({ path: `/print-jobs/${j.id}/retry` });
                        }}
                      >
                        Retry <span className="visually-hidden">{j.document}</span>
                      </button>
                    ) : null}
                    {j.status === 'uncertain' ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={!writes || act.isPending}
                          onClick={() => {
                            act.mutate({
                              path: `/print-jobs/${j.id}/resolve-uncertain`,
                              body: { outcome: 'printed' },
                            });
                          }}
                        >
                          Yes, it printed <span className="visually-hidden">{j.document}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!writes || act.isPending}
                          onClick={() => {
                            act.mutate({
                              path: `/print-jobs/${j.id}/resolve-uncertain`,
                              body: { outcome: 'reprint' },
                            });
                          }}
                        >
                          No, print again <span className="visually-hidden">{j.document}</span>
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
