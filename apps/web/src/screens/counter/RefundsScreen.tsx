/**
 * Refunds and payment-method corrections (ORDER_STATE_MACHINE.md P2, D-13; Phase 5 step
 * 5.2). Find a settled bill, then for one of its payments either give money back (by that
 * payment's method, for chosen lines or an amount) or say how it was really paid. Someone
 * else approves on this device with their PIN. The bill itself never changes; each refund
 * prints a slip. `?invoice=<id>` opens a bill; `&full=1` fills in everything still paid
 * (a cancelled prepaid delivery, P5-5).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { ApprovalFields, approvalReady, noApproval } from './Approval.tsx';
import { approve, useCommand } from './useCommand.ts';

type Method = 'cash' | 'card_manual' | 'transfer';
type Provider = 'bank' | 'jazzcash' | 'easypaisa';

interface Payment {
  id: string;
  takenMethod: Method;
  method: Method;
  provider: Provider | null;
  reference: string | null;
  amount: string;
  refunded: string;
  refundable: string;
  corrected: boolean;
  inOpenShift: boolean;
}
interface RefundRow {
  id: string;
  refundNo: string;
  kind: 'refund' | 'method_correction';
  paymentId: string;
  amount: string;
  method: Method;
  provider: Provider | null;
  previousMethod: Method | null;
  previousProvider: Provider | null;
  reference: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string;
  businessDate: string;
}
interface Line {
  id: string;
  description: string;
  qty: number;
  net: string;
  refundedQty: number;
  refundedAmount: string;
}
interface RefundableBill {
  invoice: {
    id: string;
    invoiceNo: string | null;
    status: string;
    total: string;
    paidTotal: string;
    refunded: string;
    businessDate: string | null;
    where: string;
  };
  lines: Line[];
  payments: Payment[];
  refunds: RefundRow[];
  refundDue: string | null;
  reasons: string[];
}
interface FoundBill {
  invoiceId: string;
  invoiceNo: string;
  where: string;
  total: string;
  refunded: string;
  businessDate: string;
}

const PROVIDERS: Record<Provider, string> = {
  bank: 'Bank transfer',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};
const methodName = (m: Method, p: Provider | null): string =>
  m === 'cash' ? 'Cash' : m === 'card_manual' ? 'Card' : p ? PROVIDERS[p] : 'Transfer';
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;
const cents = (v: string): number => Math.round(Number(v) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

export function RefundsScreen() {
  const [params, setParams] = useSearchParams();
  const invoiceId = params.get('invoice');
  const full = params.get('full') === '1';
  return (
    <>
      <h1>Refunds &amp; corrections</h1>
      <p className="muted">
        Money back for a paid bill, or a payment recorded the wrong way. Another person approves
        with their PIN; the bill itself never changes. <Link to="/counter">Back to bills</Link>
      </p>
      {invoiceId ? (
        <BillRefunds
          key={invoiceId}
          invoiceId={invoiceId}
          prefillFull={full}
          onBack={() => {
            setParams({});
          }}
        />
      ) : (
        <FindBill
          onOpen={(id) => {
            setParams({ invoice: id });
          }}
        />
      )}
    </>
  );
}

function FindBill({ onOpen }: { onOpen: (invoiceId: string) => void }) {
  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['refunds', 'bills', q.trim()],
    queryFn: ({ signal }) =>
      api<{ bills: FoundBill[] }>(
        `/refunds/bills?${new URLSearchParams({ q: q.trim() }).toString()}`,
        {
          signal,
        },
      ),
    meta: { topics: ['cashier'] },
    placeholderData: (previous) => previous,
  });
  return (
    <section className="card stack" aria-labelledby="find-head">
      <h2 id="find-head">Find the paid bill</h2>
      <Field
        label="Invoice number, table or guest"
        autoComplete="off"
        maxLength={60}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      {found.isPending ? <Loading label="Loading paid bills" /> : null}
      {found.data && found.data.bills.length === 0 ? (
        <p className="muted">No paid bill matches.</p>
      ) : null}
      {found.data && found.data.bills.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">Where</th>
              <th scope="col">Date</th>
              <th scope="col">Total</th>
              <th scope="col">Refunded</th>
              <th scope="col">
                <span className="visually-hidden">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {found.data.bills.map((b) => (
              <tr key={b.invoiceId}>
                <td>{b.invoiceNo}</td>
                <td>{b.where}</td>
                <td>{b.businessDate}</td>
                <td>{rupees(b.total)}</td>
                <td>{b.refunded === '0.00' ? '' : rupees(b.refunded)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      onOpen(b.invoiceId);
                    }}
                  >
                    Open<span className="visually-hidden"> {b.invoiceNo}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

type Action = { kind: 'refund' | 'method_correction'; payment: Payment; full: boolean } | null;

function BillRefunds({
  invoiceId,
  prefillFull,
  onBack,
}: {
  invoiceId: string;
  prefillFull: boolean;
  onBack: () => void;
}) {
  const writes = useWritesAllowed();
  const bill = useQuery({
    queryKey: ['refunds', 'bill', invoiceId],
    queryFn: ({ signal }) => api<RefundableBill>(`/invoices/${invoiceId}/refunds`, { signal }),
    meta: { topics: ['cashier'] },
  });
  const [action, setAction] = useState<Action>(null);
  const [done, setDone] = useState<string | null>(null);
  // `&full=1` opens the refund of everything still paid until something else is chosen.
  const [prefillUsed, setPrefillUsed] = useState(!prefillFull);
  const reprint = useCommand<{ copyNo: number }>((r) => {
    setDone(`Reprint #${String(r.copyNo)} of the slip sent to the printer.`);
  });
  const b = bill.data;
  const choose = (next: Action): void => {
    setPrefillUsed(true);
    setAction(next);
  };
  const autoPayment = b?.payments.find((p) => Number(p.refundable) > 0);
  const current: Action =
    action ??
    (!prefillUsed && b?.invoice.status === 'settled' && autoPayment
      ? { kind: 'refund', payment: autoPayment, full: true }
      : null);

  if (bill.isPending) return <Loading label="Loading the bill" />;
  if (bill.isError || !b) {
    return (
      <div role="alert" className="banner banner-danger">
        {messageOf(bill.error)}
      </div>
    );
  }
  const settled = b.invoice.status === 'settled';
  return (
    <>
      <section className="card stack" aria-labelledby="bill-head">
        <h2 id="bill-head">
          {b.invoice.invoiceNo ?? 'Bill'} · {b.invoice.where}
        </h2>
        <p>
          Paid {rupees(b.invoice.paidTotal)} on {b.invoice.businessDate ?? '—'}
          {b.invoice.refunded !== '0.00' ? ` · refunded ${rupees(b.invoice.refunded)}` : ''}
          {b.refundDue ? ` · refund due ${rupees(b.refundDue)} (cancelled delivery)` : ''}
        </p>
        {!settled ? (
          <p className="banner banner-warning">
            This bill is not paid in full yet: only a settled bill can be refunded.
          </p>
        ) : null}
        <table className="data" aria-label="Items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Qty</th>
              <th scope="col">Net</th>
              <th scope="col">Refunded</th>
            </tr>
          </thead>
          <tbody>
            {b.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td>{l.qty}</td>
                <td>{rupees(l.net)}</td>
                <td>
                  {l.refundedQty > 0
                    ? `${String(l.refundedQty)} · ${rupees(l.refundedAmount)}`
                    : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="data" aria-label="Payments">
          <thead>
            <tr>
              <th scope="col">Payment</th>
              <th scope="col">Amount</th>
              <th scope="col">Refunded</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {b.payments.map((p) => (
              <tr key={p.id}>
                <td>
                  {methodName(p.method, p.provider)}
                  {p.reference ? ` ref ${p.reference}` : ''}
                  {p.corrected ? (
                    <span className="muted"> (recorded as {methodName(p.takenMethod, null)})</span>
                  ) : null}
                </td>
                <td>{rupees(p.amount)}</td>
                <td>{p.refunded === '0.00' ? '' : rupees(p.refunded)}</td>
                <td>
                  {settled && Number(p.refundable) > 0 ? (
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={!writes}
                        onClick={() => {
                          setDone(null);
                          choose({ kind: 'refund', payment: p, full: false });
                        }}
                      >
                        Refund
                        <span className="visually-hidden">
                          {' '}
                          this {methodName(p.method, p.provider)} payment
                        </span>
                      </button>
                      {p.refunded === '0.00' ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!writes}
                          onClick={() => {
                            setDone(null);
                            choose({ kind: 'method_correction', payment: p, full: false });
                          }}
                        >
                          Correct method
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Find another bill
          </button>
        </div>
      </section>

      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {current?.kind === 'refund' ? (
        <RefundForm
          key={`r${current.payment.id}`}
          bill={b}
          payment={current.payment}
          full={current.full}
          onDone={(msg) => {
            choose(null);
            setDone(msg);
          }}
          onCancel={() => {
            choose(null);
          }}
        />
      ) : null}
      {current?.kind === 'method_correction' ? (
        <CorrectionForm
          key={`c${current.payment.id}`}
          invoiceId={b.invoice.id}
          payment={current.payment}
          onDone={(msg) => {
            choose(null);
            setDone(msg);
          }}
          onCancel={() => {
            choose(null);
          }}
        />
      ) : null}

      {b.refunds.length > 0 ? (
        <section className="card stack" aria-labelledby="done-head">
          <h2 id="done-head">Refunds and corrections of this bill</h2>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">What</th>
                <th scope="col">Amount</th>
                <th scope="col">Why</th>
                <th scope="col">Approved by</th>
                <th scope="col">
                  <span className="visually-hidden">Slip</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {b.refunds.map((r) => (
                <tr key={r.id}>
                  <td>{r.refundNo}</td>
                  <td>
                    {r.kind === 'refund'
                      ? `Refund by ${methodName(r.method, r.provider)}`
                      : `${methodName(r.previousMethod ?? 'cash', r.previousProvider)} → ${methodName(r.method, r.provider)}`}
                  </td>
                  <td>{rupees(r.amount)}</td>
                  <td>{r.reason}</td>
                  <td>
                    {r.approvedBy} <span className="muted">(asked by {r.requestedBy})</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || reprint.isPending}
                      onClick={() => {
                        reprint.mutate({ path: `/refunds/${r.id}/slip/reprint` });
                      }}
                    >
                      Reprint slip<span className="visually-hidden"> {r.refundNo}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reprint.isError ? (
            <div role="alert" className="banner banner-danger">
              {messageOf(reprint.error)}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/** What is left of a line, and the default amount for `qty` of it (whole rest when all). */
function lineLeft(l: Line): { qty: number; cents: number } {
  return { qty: l.qty - l.refundedQty, cents: cents(l.net) - cents(l.refundedAmount) };
}
function lineDefault(l: Line, qty: number): number {
  const left = lineLeft(l);
  if (qty >= left.qty) return left.cents;
  return Math.min(left.cents, Math.round((cents(l.net) * qty) / l.qty));
}

function RefundForm({
  bill,
  payment,
  full,
  onDone,
  onCancel,
}: {
  bill: RefundableBill;
  payment: Payment;
  full: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const writes = useWritesAllowed();
  const open = bill.lines.filter((l) => lineLeft(l).qty > 0 && lineLeft(l).cents > 0);
  const [qty, setQty] = useState<Record<string, number>>(() =>
    full ? Object.fromEntries(open.map((l) => [l.id, lineLeft(l).qty])) : {},
  );
  const linesCents = open.reduce((s, l) => s + (qty[l.id] ? lineDefault(l, qty[l.id] ?? 0) : 0), 0);
  const [amount, setAmount] = useState(full ? payment.refundable : '');
  const [amountTouched, setAmountTouched] = useState(full);
  const shown = amountTouched ? amount : linesCents > 0 ? fromCents(linesCents) : '';
  const [reference, setReference] = useState('');
  // A reason from the owner's list (settings), with details when wanted.
  const cancelled = bill.reasons.find((r) => /cancel/i.test(r)) ?? '';
  const [choice, setChoice] = useState(full && bill.refundDue ? cancelled : '');
  const [details, setDetails] = useState(
    full && bill.refundDue ? 'Delivery cancelled, money back to the guest' : '',
  );
  const reason =
    choice && details.trim() ? `${choice}: ${details.trim()}` : choice || details.trim();
  const reasonOk =
    choice !== '' && reason.length >= 3 && (choice !== 'Other' || details.trim() !== '');
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);
  const refund = useCommand<{ refundNo: string; amount: string; slipQueued: boolean }>(
    (r) => {
      onDone(
        `${r.refundNo}: ${rupees(r.amount)} refunded by ${methodName(payment.method, payment.provider)}. ${
          r.slipQueued ? 'Slip printing.' : 'No receipt printer is set: reprint the slip later.'
        }`,
      );
    },
    [['refunds'], ['ledger']],
  );
  const amountOk =
    AMOUNT.test(shown) && cents(shown) > 0 && cents(shown) <= cents(payment.refundable);
  const linesOk = linesCents <= cents(shown || '0');
  const refOk = payment.method !== 'transfer' || reference.trim() !== '';
  const ready =
    writes &&
    !refund.isPending &&
    amountOk &&
    linesOk &&
    refOk &&
    reasonOk &&
    approvalReady(approval);

  return (
    <form
      className="card stack"
      noValidate
      aria-label="Refund"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setError(null);
        void (async () => {
          try {
            const stepUpId = await approve({
              action: 'refund.approve',
              entityType: 'invoice',
              entityId: bill.invoice.id,
              username: approval.username,
              pin: approval.pin,
              reason,
            });
            const lines = open
              .filter((l) => (qty[l.id] ?? 0) > 0)
              .map((l) => ({
                invoiceLineId: l.id,
                qty: qty[l.id] ?? 0,
                amount: fromCents(lineDefault(l, qty[l.id] ?? 0)),
              }));
            await refund.mutateAsync({
              path: `/invoices/${bill.invoice.id}/refunds`,
              body: {
                kind: 'refund',
                paymentId: payment.id,
                amount: shown,
                reason,
                ...(reference.trim() ? { reference: reference.trim() } : {}),
                ...(lines.length > 0 ? { lines } : {}),
                stepUpId,
              },
            });
          } catch (err) {
            setError(messageOf(err));
          }
        })();
      }}
    >
      <h3>
        Refund by {methodName(payment.method, payment.provider)} · up to{' '}
        {rupees(payment.refundable)}
      </h3>
      {payment.method === 'cash' ? (
        <p className="muted">Paid from the till: the cash shift must be open.</p>
      ) : null}
      {open.length > 0 ? (
        <fieldset className="stack">
          <legend>Items refunded (optional)</legend>
          {open.map((l) => {
            const left = lineLeft(l);
            return (
              <div className="row" key={l.id}>
                <SelectField
                  label={`${l.description} (${String(left.qty)} left)`}
                  value={String(qty[l.id] ?? 0)}
                  options={Array.from({ length: left.qty + 1 }, (_, n) => ({
                    value: String(n),
                    label:
                      n === 0 ? 'None' : `${String(n)} · ${rupees(fromCents(lineDefault(l, n)))}`,
                  }))}
                  onChange={(v) => {
                    setQty({ ...qty, [l.id]: Number(v) });
                    setAmountTouched(false);
                  }}
                />
              </div>
            );
          })}
        </fieldset>
      ) : null}
      <div className="row">
        <Field
          label="Amount to refund (Rs)"
          inputMode="decimal"
          value={shown}
          error={
            shown && !amountOk
              ? `Up to ${rupees(payment.refundable)}`
              : !linesOk
                ? 'Less than the items chosen'
                : null
          }
          onChange={(e) => {
            setAmountTouched(true);
            setAmount(e.target.value.trim());
          }}
        />
        {payment.method !== 'cash' ? (
          <Field
            label={
              payment.method === 'transfer'
                ? 'Transaction ID of the transfer back'
                : 'Terminal refund code (optional)'
            }
            maxLength={32}
            autoComplete="off"
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
            }}
          />
        ) : null}
      </div>
      <div className="row">
        <SelectField
          label="Reason"
          value={choice}
          options={[
            { value: '', label: 'Choose…' },
            ...bill.reasons.map((r) => ({ value: r, label: r })),
          ]}
          onChange={setChoice}
        />
        <Field
          label={choice === 'Other' ? 'What happened' : 'Details (optional)'}
          maxLength={200}
          value={details}
          onChange={(e) => {
            setDetails(e.target.value);
          }}
        />
      </div>
      <ApprovalFields legend="Approval on this device" value={approval} onChange={setApproval} />
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-danger" disabled={!ready}>
          Refund {amountOk ? rupees(shown) : ''}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CorrectionForm({
  invoiceId,
  payment,
  onDone,
  onCancel,
}: {
  invoiceId: string;
  payment: Payment;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const writes = useWritesAllowed();
  const choices = (['cash', 'card_manual', 'transfer'] as const).filter(
    (m) => m === 'transfer' || m !== payment.method,
  );
  const [method, setMethod] = useState<Method>(choices[0] ?? 'card_manual');
  const [provider, setProvider] = useState<Provider>('jazzcash');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);
  const correct = useCommand<{ refundNo: string }>(
    (r) => {
      onDone(
        `${r.refundNo}: the payment now shows ${methodName(method, method === 'transfer' ? provider : null)}.`,
      );
    },
    [['refunds'], ['ledger']],
  );
  const same =
    method === payment.method && (method !== 'transfer' || provider === payment.provider);
  const cashInvolved = method === 'cash' || payment.method === 'cash';
  const ready =
    writes &&
    !correct.isPending &&
    !same &&
    (method !== 'transfer' || reference.trim() !== '') &&
    reason.trim().length >= 3 &&
    approvalReady(approval) &&
    (!cashInvolved || payment.inOpenShift);
  return (
    <form
      className="card stack"
      noValidate
      aria-label="Correct the payment method"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setError(null);
        void (async () => {
          try {
            const stepUpId = await approve({
              action: 'payment.correct',
              entityType: 'invoice',
              entityId: invoiceId,
              username: approval.username,
              pin: approval.pin,
              reason: reason.trim(),
            });
            await correct.mutateAsync({
              path: `/invoices/${invoiceId}/refunds`,
              body: {
                kind: 'method_correction',
                paymentId: payment.id,
                method,
                ...(method === 'transfer' ? { provider } : {}),
                ...(reference.trim() && method !== 'cash' ? { reference: reference.trim() } : {}),
                reason: reason.trim(),
                stepUpId,
              },
            });
          } catch (err) {
            setError(messageOf(err));
          }
        })();
      }}
    >
      <h3>
        Correct the method of {rupees(payment.amount)} recorded as{' '}
        {methodName(payment.method, payment.provider)}
      </h3>
      {cashInvolved && !payment.inOpenShift ? (
        <p className="banner banner-warning">
          This payment was taken in an earlier cash shift. A correction to or from cash can only be
          made while that shift is open; the difference stays as that shift’s variance.
        </p>
      ) : null}
      <div className="row">
        <SelectField
          label="It was really paid by"
          value={method}
          options={choices.map((m) => ({ value: m, label: methodName(m, null) }))}
          onChange={(v) => {
            setMethod(v as Method);
          }}
        />
        {method === 'transfer' ? (
          <SelectField
            label="Provider"
            value={provider}
            options={Object.entries(PROVIDERS).map(([value, label]) => ({ value, label }))}
            onChange={(v) => {
              setProvider(v as Provider);
            }}
          />
        ) : null}
        {method !== 'cash' ? (
          <Field
            label={method === 'transfer' ? 'Transaction ID' : 'Approval code (optional)'}
            maxLength={32}
            autoComplete="off"
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
            }}
          />
        ) : null}
      </div>
      <Field
        label="Reason"
        maxLength={300}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      <ApprovalFields legend="Approval on this device" value={approval} onChange={setApproval} />
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-secondary" disabled={!ready}>
          Correct method
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
