/**
 * Pickup (D-33, UI_UX.md §6): what the kitchen has made, oldest first. "Picked up" is
 * the moment stock is consumed, so it is a single tap held for 5 seconds with Undo
 * (useHeldAction). Items waiting longer than 30 minutes are marked.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { permissionSet } from '../../auth/session.ts';
import { useSignedIn } from '../Shell.tsx';
import { api, messageOf } from '../../api/client.ts';
import { HeldToast, useHeldAction } from '../../components/HeldAction.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';

interface PickupTicket {
  id: string;
  ticketNo: string;
  where: string;
  acceptedAt: string;
  uncollected: boolean;
  lines: {
    orderLineId: string;
    qty: number;
    open: number;
    item: string;
    variant: string;
    modifiers: string[];
    notes: string | null;
  }[];
}

const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export function PickupScreen() {
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const queue = useQuery({
    queryKey: ['pickup'],
    queryFn: ({ signal }) => api<{ tickets: PickupTicket[] }>('/pickup', { signal }),
    meta: { topics: ['kitchen'] },
  });
  const { hold, undo, toast, dismiss } = useHeldAction(() => {
    void client.invalidateQueries({ queryKey: ['pickup'] });
  });
  const pick = (label: string, path: string, body: object) => {
    hold(label, () => api(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  };
  const canReprint = permissionSet(useSignedIn()).has('kitchen.reprint');
  const reprint = useMutation({
    mutationFn: (ticketId: string) =>
      api(`/tickets/${ticketId}/reprint`, { method: 'POST', body: {} }),
  });
  const tickets = queue.data?.tickets ?? [];
  return (
    <>
      <h1>Pickup</h1>
      {queue.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(queue.error)}
        </div>
      ) : null}
      {reprint.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(reprint.error)}
        </div>
      ) : null}
      {queue.data && tickets.length === 0 ? (
        <p className="muted">Nothing is waiting to be picked up.</p>
      ) : null}
      <ol className="stack" role="list">
        {tickets.map((t) => {
          const headingId = `ticket-${t.id}`;
          return (
            <li key={t.id} className="card stack round-card" aria-labelledby={headingId}>
              <div className="section-head">
                <h2 id={headingId}>{t.where}</h2>
                <span className="muted">
                  {t.ticketNo} · {time.format(new Date(t.acceptedAt))}
                </span>
                {t.uncollected ? (
                  <span className="chip chip-danger">Waiting over 30 min</span>
                ) : null}
                {canReprint ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!writes || reprint.isPending}
                    onClick={() => {
                      reprint.mutate(t.id);
                    }}
                  >
                    Reprint <span className="visually-hidden">ticket {t.ticketNo}</span>
                  </button>
                ) : null}
              </div>
              <ul className="stack stack-tight" role="list">
                {t.lines
                  .filter((l) => l.open > 0)
                  .map((l) => (
                    <li key={l.orderLineId} className="cart-line">
                      <span>
                        <strong>
                          {l.open} × {l.item}
                        </strong>{' '}
                        · {l.variant}
                        {l.modifiers.length > 0 ? (
                          <span className="muted"> ({l.modifiers.join(', ')})</span>
                        ) : null}
                        {l.notes ? <span className="muted"> “{l.notes}”</span> : null}
                      </span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!writes}
                        onClick={() => {
                          pick(
                            `Picked up ${String(l.open)} × ${l.item} for ${t.where}`,
                            `/lines/${l.orderLineId}/pickup`,
                            { qty: l.open },
                          );
                        }}
                      >
                        Picked up{' '}
                        <span className="visually-hidden">
                          {l.item} for {t.where}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
              {t.lines.filter((l) => l.open > 0).length > 1 ? (
                <div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!writes}
                    onClick={() => {
                      pick(`Picked up everything for ${t.where}`, `/tickets/${t.id}/pickup`, {});
                    }}
                  >
                    All picked up <span className="visually-hidden">for {t.where}</span>
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <HeldToast toast={toast} onUndo={undo} onDismiss={dismiss} />
    </>
  );
}
