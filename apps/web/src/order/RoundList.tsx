/** The rounds of a visit with their state, for staff and for the guest's status view. */
import type { ReactNode } from 'react';
import { rupees } from './cart.ts';

export interface RoundLine {
  id: string;
  item: string;
  variant: string;
  qty: number;
  notes: string | null;
  modifiers: { name: string; qty: number }[];
  lineTotal: string;
  priceLocked: boolean;
  pickedUp: number;
  served: number;
  cancelled: number;
  open: number;
  voidable: number;
}

/** Where an accepted line is (ORDER_STATE_MACHINE.md §3, derived display status). */
export function lineStatus(
  l: Pick<RoundLine, 'qty' | 'pickedUp' | 'served' | 'cancelled' | 'open'>,
): string {
  if (l.cancelled >= l.qty) return 'Cancelled';
  const cancelled = l.cancelled > 0 ? ` · ${String(l.cancelled)} cancelled` : '';
  if (l.open > 0) {
    return (
      (l.pickedUp === 0
        ? 'Being prepared'
        : `Picked up ${String(l.pickedUp)}, ${String(l.open)} to come`) + cancelled
    );
  }
  return (l.pickedUp > 0 && l.served >= l.pickedUp ? 'Served' : 'Picked up') + cancelled;
}

export interface Round {
  id: string;
  roundNo: number;
  roundRef: string;
  status: string;
  submittedAt: string;
  quotedTotal: string;
  afterBillRequest: boolean;
  reason: string | null;
  mine?: boolean;
  lines: RoundLine[];
}

const STATUS: Record<string, { text: string; chip: string }> = {
  pending_approval: { text: 'Waiting for staff', chip: 'chip chip-warning' },
  accepted: { text: 'Accepted', chip: 'chip chip-ok' },
  rejected: { text: 'Declined', chip: 'chip chip-danger' },
  cancelled: { text: 'Withdrawn', chip: 'chip chip-info' },
  expired: { text: 'Expired', chip: 'chip chip-info' },
};

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function RoundList({
  rounds,
  onWithdraw,
  lineActions,
}: {
  rounds: Round[];
  onWithdraw?: (round: Round) => void;
  /** Staff: actions for each line of an accepted round. */
  lineActions?: (line: RoundLine) => ReactNode;
}) {
  if (rounds.length === 0) return <p className="muted">No orders yet.</p>;
  return (
    <ol className="stack" role="list">
      {[...rounds].reverse().map((r) => {
        const status = STATUS[r.status] ?? { text: r.status, chip: 'chip' };
        return (
          <li key={r.id} className="card stack round-card">
            <div className="section-head">
              <h3>
                Order {r.roundNo}{' '}
                <span className="muted">· {time.format(new Date(r.submittedAt))}</span>
              </h3>
              <span className={status.chip}>{status.text}</span>
              {r.afterBillRequest ? (
                <span className="chip chip-info">After bill request</span>
              ) : null}
              {r.mine ? <span className="chip chip-info">From this phone</span> : null}
            </div>
            {r.status === 'rejected' && r.reason ? <p>Reason: {r.reason}</p> : null}
            <ul className="stack stack-tight" role="list">
              {r.lines.map((l) => (
                <li key={l.id} className="cart-line">
                  <span>
                    {l.qty} × {l.item} · {l.variant}
                    {l.modifiers.length > 0 ? (
                      <span className="muted">
                        {' '}
                        (
                        {l.modifiers
                          .map((m) => (m.qty > 1 ? `${m.name} ×${String(m.qty)}` : m.name))
                          .join(', ')}
                        )
                      </span>
                    ) : null}
                    {l.notes ? <span className="muted"> “{l.notes}”</span> : null}
                  </span>
                  <span className="cart-price">
                    {rupees(l.lineTotal)}
                    {l.priceLocked ? <span className="visually-hidden"> (price held)</span> : null}
                  </span>
                  {r.status === 'accepted' ? (
                    <span className="muted line-status">{lineStatus(l)}</span>
                  ) : null}
                  {r.status === 'accepted' && lineActions ? lineActions(l) : null}
                </li>
              ))}
            </ul>
            {onWithdraw && r.mine && r.status === 'pending_approval' ? (
              <div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    onWithdraw(r);
                  }}
                >
                  Withdraw order {r.roundNo}
                </button>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
