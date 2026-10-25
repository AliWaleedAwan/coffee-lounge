/**
 * Live operations (UI_UX.md §6 Manager: "Live operations · Approvals inbox"). How the shop
 * is doing now, and the inbox of what waits for a manager: orders nobody accepted, cash
 * shifts with a variance, failed deliveries, refunds due, items waiting for pickup, tables
 * open a long time, printers that stopped. Each item links to where it is dealt with;
 * alerts can be noted as seen. Updates live.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api, messageOf } from '../../api/client.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { Loading } from '../../components/Loading.tsx';

interface InboxItem {
  kind: string;
  alertId: string | null;
  acknowledged: boolean;
  title: string;
  detail: string;
  at: string;
  link: string;
}

interface Operations {
  businessDate: string;
  tables: { total: number; occupied: number; billRequested: number };
  orders: { pending: number; escalated: number; openTickets: number };
  bills: { open: number; preparedUnpaid: string };
  sales: { settled: number; total: string };
  takeaway: { unpaid: number };
  deliveries: { waiting: number; out: number };
  shift: { cashier: string; openedAt: string } | null;
  inbox: InboxItem[];
}

const time = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function OperationsScreen() {
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const ops = useQuery({
    queryKey: ['operations'],
    queryFn: ({ signal }) => api<Operations>('/operations', { signal }),
    meta: {
      topics: ['approvals', 'floor', 'cashier', 'kitchen', 'deliveries', 'alerts', 'printers'],
    },
  });
  const seen = useMutation({
    mutationFn: (alertId: string) =>
      api(`/alerts/${alertId}/acknowledge`, { method: 'POST', body: {} }),
    onSettled: () => client.invalidateQueries({ queryKey: ['operations'] }),
  });
  const o = ops.data;
  return (
    <>
      <h1>Live operations</h1>
      {ops.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(ops.error)}
        </div>
      ) : null}
      {!o ? (
        ops.isError ? null : (
          <Loading label="Loading live operations" />
        )
      ) : (
        <>
          <div className="grid-tiles" role="list" aria-label="Right now">
            <Tile
              label="Tables in use"
              value={`${String(o.tables.occupied)} of ${String(o.tables.total)}`}
              sub={
                o.tables.billRequested
                  ? `${String(o.tables.billRequested)} asked for the bill`
                  : 'No bill requests'
              }
            />
            <Tile
              label="Orders waiting"
              value={String(o.orders.pending)}
              sub={
                o.orders.escalated
                  ? `${String(o.orders.escalated)} waiting too long`
                  : 'None waiting too long'
              }
              warn={o.orders.escalated > 0}
            />
            <Tile label="Kitchen tickets open" value={String(o.orders.openTickets)} />
            <Tile
              label="Bills open"
              value={String(o.bills.open)}
              sub={`${rupees(o.bills.preparedUnpaid)} prepared, not paid`}
            />
            <Tile
              label={`Sales today (${o.businessDate})`}
              value={rupees(o.sales.total)}
              sub={`${String(o.sales.settled)} bills paid`}
            />
            <Tile label="Takeaway waiting to pay" value={String(o.takeaway.unpaid)} />
            <Tile
              label="Deliveries"
              value={`${String(o.deliveries.out)} out`}
              sub={`${String(o.deliveries.waiting)} waiting to go`}
            />
            <Tile
              label="Cash shift"
              value={o.shift ? o.shift.cashier : 'Not open'}
              sub={
                o.shift
                  ? `since ${time.format(new Date(o.shift.openedAt))}`
                  : 'Cash cannot be taken'
              }
              warn={!o.shift}
            />
          </div>
          <section className="stack" aria-labelledby="inbox">
            <h2 id="inbox">Needs a manager ({o.inbox.filter((i) => !i.acknowledged).length})</h2>
            {o.inbox.length === 0 ? <p className="muted">Nothing waiting. All good.</p> : null}
            {seen.isError ? (
              <div role="alert" className="banner banner-danger">
                {messageOf(seen.error)}
              </div>
            ) : null}
            <ul className="stack stack-tight" role="list">
              {o.inbox.map((i, n) => (
                <li
                  key={`${i.kind}:${i.alertId ?? String(n)}`}
                  className={`card inbox-item${i.acknowledged ? ' inbox-seen' : ''}`}
                >
                  <div className="section-head">
                    <strong>{i.title}</strong>
                    <span className="muted">{time.format(new Date(i.at))}</span>
                  </div>
                  {i.detail ? <p className="muted">{i.detail}</p> : null}
                  <div className="row">
                    <Link to={i.link}>
                      Open <span className="visually-hidden">{i.title}</span>
                    </Link>
                    {i.alertId && !i.acknowledged ? (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!writes || seen.isPending}
                        onClick={() => {
                          if (i.alertId) seen.mutate(i.alertId);
                        }}
                      >
                        Mark as seen <span className="visually-hidden">{i.title}</span>
                      </button>
                    ) : null}
                    {i.acknowledged ? <span className="chip">Seen</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div role="listitem" className={`card stack stack-tight tile${warn ? ' tile-warn' : ''}`}>
      <span className="muted">{label}</span>
      <strong className="tile-value">{value}</strong>
      {sub ? <span className="muted">{sub}</span> : null}
    </div>
  );
}
