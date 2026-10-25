/**
 * The red printer banner (PRINTING_HARDWARE.md §6): one printer serves kitchen tickets
 * and receipts, so paper-out stops both. Shown on every staff device; staff who can
 * reprint get a link to the jobs screen to retry or answer "Did it print?".
 */
import { Link } from 'react-router';
import { usePrinterStatus } from './printing-api.ts';

export function PrinterBanner({
  canSee,
  canFix,
  canSetUp,
}: {
  canSee: boolean;
  canFix: boolean;
  canSetUp: boolean;
}) {
  const status = usePrinterStatus(canSee);
  if (!status.data) return null;
  const troubled = status.data.printers.filter((p) => p.state !== 'ok' || p.uncertain > 0);
  return (
    <>
      {troubled.map((p) => (
        <div
          key={p.id}
          role="alert"
          className={p.state === 'ok' ? 'banner banner-warning' : 'banner banner-danger'}
        >
          {p.state === 'ok' ? (
            <>
              Printer “{p.name}”: {p.uncertain} {p.uncertain === 1 ? 'job' : 'jobs'} may not have
              printed.{' '}
            </>
          ) : (
            <>
              Printer “{p.name}”{' '}
              {p.state === 'needs_attention' ? 'needs attention' : 'is not printing'}
              {p.lastError ? `: ${p.lastError}` : ''}. {p.openJobs}{' '}
              {p.openJobs === 1 ? 'job is' : 'jobs are'} waiting; kitchen tickets are on the Pickup
              screen meanwhile.{' '}
            </>
          )}
          {canFix ? (
            <Link to="/print-jobs">Open print jobs</Link>
          ) : (
            'Tell a manager or the cashier.'
          )}
        </div>
      ))}
      {status.data.kitchenPrinterMissing && canSetUp ? (
        <div role="status" className="banner banner-warning">
          No printer is set for kitchen tickets. <Link to="/settings">Set one up</Link>.
        </div>
      ) : null}
    </>
  );
}
