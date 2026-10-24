/**
 * Takeaway waiting to pay (ORDER_STATE_MACHINE.md §8.5, D-40; Counter prototype "Takeaway
 * queue"). Orders from the counter QR wait here until the guest pays: take the money
 * first, then press **Accept & pay**, which accepts, prepares the bill, records the
 * payment and settles in one step. If it fails (an item just ran out) nothing was
 * recorded and the money goes back. Unpaid orders cancel themselves after 30 minutes.
 */
import { Decimal, money } from '@cl/shared';
import { useEffect, useState, type SubmitEvent } from 'react';
import { ApiError, messageOf } from '../../api/client.ts';
import { CheckField, Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useTakeawayQueue, type TakeawayOrder } from './counter-api.ts';
import { METHODS, tenderOptions, type Method } from './PaymentPanel.tsx';
import { useCommand } from './useCommand.ts';

/** The time now, refreshed every second (for countdowns). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

const countdown = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
};

export function TakeawayQueue({ enabled }: { enabled: boolean }) {
  const queue = useTakeawayQueue(enabled);
  const now = useNow();
  const items = queue.data?.items ?? [];
  const [paid, setPaid] = useState<Paid | null>(null);
  if (!enabled || (queue.isSuccess && items.length === 0 && paid === null)) return null;
  return (
    <section className="stack" aria-labelledby="takeaway-queue">
      <h2 id="takeaway-queue">Takeaway · waiting to pay ({items.length})</h2>
      <p className="muted">
        Orders from the counter QR. Take the money first, then press Accept &amp; pay. Unpaid orders
        cancel themselves after {queue.data?.expiryMinutes ?? 30} minutes.
      </p>
      {queue.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(queue.error)}
        </div>
      ) : null}
      {paid ? (
        <div role="status" className="banner banner-success">
          Accepted and paid · {paid.invoiceNo}
          {paid.change && Number(paid.change) > 0 ? ` · change ${rupees(paid.change)}` : ''} ·{' '}
          {paid.receiptQueued ? 'kitchen ticket and receipt printing.' : 'sent to the kitchen.'}
        </div>
      ) : null}
      {items.map((o) => (
        <TakeawayCard
          key={o.roundId}
          order={o}
          msLeft={Date.parse(o.expiresAt) - now}
          onPaid={setPaid}
        />
      ))}
    </section>
  );
}

interface Paid {
  invoiceNo: string | null;
  change: string | null;
  receiptQueued: boolean;
}

function TakeawayCard({
  order,
  msLeft,
  onPaid,
}: {
  order: TakeawayOrder;
  msLeft: number;
  onPaid: (paid: Paid) => void;
}) {
  const writes = useWritesAllowed();
  const [method, setMethod] = useState<Method>('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [seen, setSeen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('Item just ran out');
  const acceptPay = useCommand<Paid>(onPaid);
  const reject = useCommand();

  const name = order.customerName ?? order.sessionNo;
  const transfer = method === 'jazzcash' || method === 'easypaisa' || method === 'bank';
  const tenderedOk =
    /^\d{1,9}(\.\d{1,2})?$/.test(tendered.trim()) && new Decimal(tendered.trim()).gte(order.total);
  const ready =
    writes &&
    !acceptPay.isPending &&
    (method === 'cash' ? tenderedOk : transfer ? reference.trim() !== '' && seen : true);
  const label = METHODS.find((m) => m.id === method)?.label ?? '';

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!ready) return;
    const ref = reference.trim();
    acceptPay.mutate({
      path: `/rounds/${order.roundId}/accept-and-pay`,
      body: {
        payments: [
          {
            method: method === 'cash' ? 'cash' : method === 'card' ? 'card_manual' : 'transfer',
            amount: order.total,
            ...(method === 'cash' ? { tendered: tendered.trim() } : {}),
            ...(transfer ? { provider: method, confirmed: seen } : {}),
            ...(ref && method !== 'cash' ? { reference: ref } : {}),
          },
        ],
      },
    });
  };

  const failed = acceptPay.error;
  return (
    <form
      className="card stack"
      noValidate
      onSubmit={submit}
      aria-label={`Takeaway ${order.roundRef} for ${name}`}
    >
      <div className="section-head">
        <h3>
          {order.roundRef} · {name}
        </h3>
        <span className={`chip ${msLeft < 5 * 60_000 ? 'chip-danger' : 'chip-warning'}`}>
          Unpaid · cancels in {countdown(msLeft)}
        </span>
      </div>
      <ul className="stack stack-tight">
        {order.lines.map((l, i) => (
          <li key={i} className="cart-line">
            <span>
              {l.qty}× {l.description}
              {l.modifiers.length > 0 ? (
                <span className="muted"> · {l.modifiers.join(', ')}</span>
              ) : null}
            </span>
            <span className="cart-price">{rupees(l.amount)}</span>
          </li>
        ))}
      </ul>
      <strong>Total {rupees(order.total)}</strong>
      <div
        className="method-tiles"
        role="group"
        aria-label={`Payment method for ${order.roundRef}`}
      >
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            className="method-tile"
            aria-pressed={method === m.id}
            onClick={() => {
              setMethod(m.id);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {method === 'cash' ? (
        <>
          <Field
            label="Cash received"
            inputMode="decimal"
            value={tendered}
            onChange={(e) => {
              setTendered(e.target.value);
            }}
          />
          <div className="row" role="group" aria-label="Quick amounts">
            {tenderOptions(order.total).map((t, i) => (
              <button
                key={t}
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setTendered(t);
                }}
              >
                {i === 0 ? 'Exact' : rupees(t)}
              </button>
            ))}
          </div>
          {tenderedOk ? (
            <p className="change-due">
              Change{' '}
              <strong>
                {rupees(money.format(new Decimal(tendered.trim()).minus(order.total)))}
              </strong>
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Field
            label={method === 'card' ? 'Approval code (optional)' : `${label} transaction ID`}
            maxLength={32}
            autoComplete="off"
            value={reference}
            hint={method === 'card' ? 'Never the card number.' : undefined}
            onChange={(e) => {
              setReference(e.target.value);
            }}
          />
          {transfer ? (
            <CheckField
              label="I checked the money arrived in the shop's account"
              checked={seen}
              onChange={setSeen}
            />
          ) : null}
        </>
      )}
      {failed ? (
        <div role="alert" className="banner banner-danger">
          Not accepted. No payment was recorded: return the money. {messageOf(failed)}
          {failed instanceof ApiError && failed.code === 'INSUFFICIENT_STOCK'
            ? ' Reject the order so the guest can choose again.'
            : ''}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary btn-lg" disabled={!ready}>
          {acceptPay.isPending ? 'Sending…' : `Accept & pay · ${rupees(order.total)}`}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes}
          onClick={() => {
            setRejecting(!rejecting);
          }}
        >
          Reject…
        </button>
      </div>
      {rejecting ? (
        <div className="row">
          <Field
            label="Reason the guest sees"
            maxLength={200}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn btn-danger"
            disabled={!writes || reason.trim().length < 3 || reject.isPending}
            onClick={() => {
              reject.mutate({
                path: `/rounds/${order.roundId}/reject`,
                body: { reason: reason.trim() },
              });
            }}
          >
            Reject order
          </button>
        </div>
      ) : null}
    </form>
  );
}
