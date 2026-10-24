/**
 * Bills & payments at the counter (UI_UX.md §4 "Counter PC: list + detail"; journey J5:
 * lock bill → cash with change → settled in four actions). Fully keyboard-operable
 * (AT-87): `/` finds a table, `↑↓` move, `Enter` opens, `F2` prepares (locks) the bill,
 * `F4` cash, `F5` card, `Esc` closes a sheet or goes back to the list.
 */
import { Decimal, money } from '@cl/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useSignedIn } from '../Shell.tsx';
import { ApprovalFields, approvalReady, noApproval } from './Approval.tsx';
import {
  useBill,
  useOpenBills,
  useShift,
  type Bill,
  type OpenBill,
  type PaymentResult,
  type Shift,
} from './counter-api.ts';
import { DiscountSheet, type SheetMode } from './DiscountSheet.tsx';
import { TakeawayQueue } from './TakeawayQueue.tsx';
import { PaymentPanel, type Method } from './PaymentPanel.tsx';
import { approve, useCommand } from './useCommand.ts';
import { Loading } from '../../components/Loading.tsx';

const where = (b: { tableName: string | null; customerName: string | null; sessionNo: string }) =>
  b.tableName ?? (b.customerName ? `Takeaway · ${b.customerName}` : `Takeaway ${b.sessionNo}`);

function statusChip(b: OpenBill) {
  if (b.invoiceStatus === 'locked') return <span className="chip chip-info">Bill ready</span>;
  if (b.billRequested) return <span className="chip chip-warning">Asked for the bill</span>;
  if (b.pendingRounds > 0) return <span className="chip chip-warning">Order waiting</span>;
  return null;
}

export function CounterScreen() {
  const permissions = permissionSet(useSignedIn());
  const canPay = permissions.has('payments.collect');
  const bills = useOpenBills();
  const shift = useShift(permissions.has('cash_shifts.operate'));
  const [params, setParams] = useSearchParams();
  const selected = params.get('session');
  const bill = useBill(selected);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [method, setMethod] = useState<Method>('cash');
  const [paid, setPaid] = useState<PaymentResult | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const payField = useRef<HTMLInputElement>(null);
  const lock = useCommand();

  const items = (bills.data?.items ?? []).filter((b) => {
    const q = query.trim().toLowerCase();
    return q === '' || `${where(b)} ${b.sessionNo}`.toLowerCase().includes(q);
  });
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  const open = (sessionId: string | null) => {
    setSheet(null);
    setPaid(null);
    lock.reset();
    setParams(sessionId ? { session: sessionId } : {});
  };
  const prepare = () => {
    const b = bill.data;
    if (b?.invoice.status !== 'open' || lock.isPending) return;
    lock.mutate({ path: `/invoices/${b.invoice.id}/lock` });
  };
  const choose = (m: Method) => {
    setMethod(m);
    requestAnimationFrame(() => payField.current?.focus());
  };

  // Keyboard shortcuts for the whole screen (AT-87). The latest handler is kept in a ref
  // so the listener is attached once.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        search.current?.focus();
      } else if (e.key === 'F2') {
        e.preventDefault();
        prepare();
      } else if (e.key === 'F4' || e.key === 'F5') {
        e.preventDefault();
        if (bill.data?.invoice.status === 'locked' && canPay)
          choose(e.key === 'F4' ? 'cash' : 'card');
      } else if (e.key === 'Escape') {
        if (sheet) setSheet(null);
        else search.current?.focus();
      }
    };
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      keys.current(e);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, []);

  const activeId = items[activeIndex] ? `bill-${items[activeIndex].sessionId}` : undefined;
  return (
    <>
      <h1>Bills &amp; payments</h1>
      <div className="section-head">
        <ShiftBar shift={shift.data?.shift ?? null} loaded={shift.isSuccess} />
        {permissions.has('orders.create') ? <NewTakeaway /> : null}
      </div>
      <TakeawayQueue enabled={permissions.has('orders.accept') && canPay} />
      <div className="counter">
        <section className="stack" aria-labelledby="open-bills">
          <h2 id="open-bills">Open tables</h2>
          <Field
            ref={search}
            label="Find a table or order ( / )"
            role="combobox"
            aria-expanded="true"
            aria-controls="bill-list"
            aria-activedescendant={activeId}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                setActive(Math.max(0, Math.min(items.length - 1, activeIndex + step)));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const b = items[activeIndex];
                if (b) open(b.sessionId);
              }
            }}
          />
          {bills.isError ? (
            <div role="alert" className="banner banner-danger">
              {messageOf(bills.error)}
            </div>
          ) : null}
          <ul id="bill-list" role="listbox" aria-label="Open tables" className="bill-list">
            {items.map((b, i) => (
              <li
                key={b.sessionId}
                id={`bill-${b.sessionId}`}
                role="option"
                aria-selected={i === activeIndex}
                aria-current={b.sessionId === selected ? 'true' : undefined}
                className="bill-row"
                onClick={() => {
                  setActive(i);
                  open(b.sessionId);
                }}
              >
                <span className="bill-row-name">{where(b)}</span>
                <span className="bill-row-total">{rupees(b.total)}</span>
                <span className="muted">
                  {b.items} item{b.items === 1 ? '' : 's'} · {b.sessionNo}
                </span>
                {statusChip(b)}
              </li>
            ))}
          </ul>
          {bills.isPending ? <Loading label="Loading open tables" /> : null}
          {bills.isSuccess && items.length === 0 ? (
            <p className="muted">{query ? 'No table matches.' : 'No open tables.'}</p>
          ) : null}
        </section>

        <section className="stack" aria-labelledby="bill-heading">
          {selected === null ? (
            <>
              <h2 id="bill-heading">Bill</h2>
              <p className="muted">
                Choose a table: press <kbd>/</kbd>, type its name, <kbd>Enter</kbd>.
              </p>
            </>
          ) : bill.isError ? (
            <>
              <h2 id="bill-heading">Bill</h2>
              <div role="alert" className="banner banner-danger">
                {messageOf(bill.error)}
              </div>
            </>
          ) : bill.data ? (
            <BillPanel
              bill={bill.data}
              paid={paid}
              sheet={sheet}
              onSheet={setSheet}
              onPrepare={prepare}
              preparing={lock.isPending}
              prepareError={lock.isError ? messageOf(lock.error) : null}
              payment={
                canPay && bill.data.invoice.status === 'locked' ? (
                  <PaymentPanel
                    bill={bill.data}
                    shift={shift.data?.shift ?? null}
                    method={method}
                    onMethod={choose}
                    focusRef={payField}
                    onPaid={(r) => {
                      if (r.settled) setPaid(r);
                    }}
                  />
                ) : null
              }
              onNext={() => {
                open(null);
                setQuery('');
                setActive(0);
                search.current?.focus();
              }}
            />
          ) : (
            <Loading label="Loading the bill" />
          )}
        </section>
      </div>
    </>
  );
}

/** A takeaway for a guest at the counter: opens it and goes to its order screen. */
function NewTakeaway() {
  const writes = useWritesAllowed();
  const navigate = useNavigate();
  const create = useCommand<{ id: string }>((s) => {
    void navigate(`/sessions/${s.id}`);
  });
  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!writes || create.isPending}
        onClick={() => {
          create.mutate({ path: '/sessions/takeaway' });
        }}
      >
        New takeaway
      </button>
      {create.isError ? <span role="alert">{messageOf(create.error)}</span> : null}
    </div>
  );
}

function ShiftBar({ shift, loaded }: { shift: Shift | null; loaded: boolean }) {
  const writes = useWritesAllowed();
  const [float, setFloat] = useState('');
  const openShift = useCommand();
  if (!loaded) return null;
  if (shift) {
    return (
      <p className="muted">
        Cash shift open · {shift.cashier} · cash in the till {rupees(shift.expectedCash)} ·{' '}
        <Link to="/counter/shift">Cash shift</Link>
      </p>
    );
  }
  const ok = /^\d{1,9}(\.\d{1,2})?$/.test(float.trim());
  return (
    <form
      className="banner banner-warning row"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && writes)
          openShift.mutate({ path: '/cash-shifts', body: { openingFloat: float.trim() } });
      }}
    >
      <span>No cash shift is open. Count the float to take cash.</span>
      <Field
        label="Opening float (Rs)"
        inputMode="decimal"
        value={float}
        onChange={(e) => {
          setFloat(e.target.value);
        }}
      />
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={!ok || !writes || openShift.isPending}
      >
        Open shift
      </button>
      {openShift.isError ? <span role="alert">{messageOf(openShift.error)}</span> : null}
    </form>
  );
}

function BillPanel({
  bill,
  paid,
  sheet,
  onSheet,
  onPrepare,
  preparing,
  prepareError,
  payment,
  onNext,
}: {
  bill: Bill;
  paid: PaymentResult | null;
  sheet: SheetMode | null;
  onSheet: (s: SheetMode | null) => void;
  onPrepare: () => void;
  preparing: boolean;
  prepareError: string | null;
  payment: ReactNode;
  onNext: () => void;
}) {
  const permissions = permissionSet(useSignedIn());
  const writes = useWritesAllowed();
  const inv = bill.invoice;
  const canDiscount = permissions.has('discounts.apply') && inv.status !== 'settled';
  const canComp = permissions.has('discounts.comp') && inv.status !== 'settled';
  const paidSome = Number(inv.paidTotal) > 0;
  const editable = !(inv.status === 'locked' && paidSome);

  return (
    <>
      <div className="section-head">
        <h2 id="bill-heading">{where(bill.session)} · bill</h2>
        <span
          className={`chip ${inv.status === 'settled' ? 'chip-ok' : inv.status === 'locked' ? 'chip-info' : ''}`}
        >
          {inv.status === 'settled'
            ? `Paid · ${inv.invoiceNo ?? ''}`
            : inv.status === 'locked'
              ? 'Ready to pay'
              : 'Open'}
        </span>
      </div>
      {bill.pendingRounds > 0 && inv.status === 'open' ? (
        <div role="status" className="banner banner-warning">
          An order from this table is waiting for approval. Accept or reject it before preparing the
          bill. <Link to="/approvals">Open approvals</Link>
        </div>
      ) : null}
      {bill.unpickedUnits > 0 && inv.status !== 'settled' ? (
        <p className="muted">
          Note: {bill.unpickedUnits} item{bill.unpickedUnits === 1 ? '' : 's'} not picked up yet.
          You can still take payment.
        </p>
      ) : null}

      <table className="data bill-lines">
        <caption className="visually-hidden">Items on the bill</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.orderLineId}>
              <td>
                {l.billableQty}× {l.description}
                {l.modifiers.length > 0 ? (
                  <div className="muted">{l.modifiers.join(', ')}</div>
                ) : null}
                {l.isComp ? <span className="chip chip-ok"> Free (comp)</span> : null}
                {Number(l.manualDiscount) > 0 && !l.isComp ? (
                  <div className="muted">Item discount −{rupees(l.manualDiscount)}</div>
                ) : null}
              </td>
              <td className="num">
                {beforeBillShare(l) !== l.gross ? (
                  <span className="strike">{rupees(l.gross)}</span>
                ) : null}{' '}
                {rupees(beforeBillShare(l))}
              </td>
              <td>
                {canComp && editable && !l.isComp ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!writes}
                    onClick={() => {
                      onSheet({ kind: 'comp', lineId: l.orderLineId });
                    }}
                  >
                    Comp <span className="visually-hidden">{l.description}</span>
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {bill.lines.length === 0 ? <p className="muted">Nothing on the bill yet.</p> : null}

      <dl className="totals">
        <dt>Subtotal</dt>
        <dd>{rupees(inv.subtotal)}</dd>
        {bill.discounts
          .filter((d) => d.kind !== 'comp' || d.orderLineId === null)
          .map((d) => (
            <DiscountRow key={d.id} d={d} removable={canDiscount && editable} />
          ))}
        {bill.discounts
          .filter((d) => d.kind === 'comp')
          .map((d) => (
            <DiscountRow key={d.id} d={d} removable={canComp && editable} />
          ))}
        <dt>Tax</dt>
        <dd>Rs 0</dd>
        {Number(inv.roundingAdjustment) !== 0 ? (
          <>
            <dt>Rounding</dt>
            <dd>{rupees(inv.roundingAdjustment)}</dd>
          </>
        ) : null}
        <dt className="total">Total</dt>
        <dd className="total">{rupees(inv.total)}</dd>
        {paidSome ? (
          <>
            <dt>Paid</dt>
            <dd>{rupees(inv.paidTotal)}</dd>
            <dt>Due</dt>
            <dd>{rupees(inv.due)}</dd>
          </>
        ) : null}
      </dl>
      {bill.payments.length > 0 ? (
        <ul className="muted">
          {bill.payments.map((p) => (
            <li key={p.id}>
              {p.method === 'cash'
                ? 'Cash'
                : p.method === 'card_manual'
                  ? 'Card'
                  : (p.provider ?? 'Transfer')}{' '}
              {rupees(p.amount)}
              {p.reference ? ` · ref ${p.reference}` : ''}
              {p.change ? ` · change ${rupees(p.change)}` : ''} · {p.receivedBy}
            </li>
          ))}
        </ul>
      ) : null}

      {sheet ? (
        <DiscountSheet
          bill={bill}
          mode={sheet}
          onClose={() => {
            onSheet(null);
          }}
        />
      ) : null}

      {inv.status === 'open' ? (
        <div className="stack">
          {prepareError ? (
            <div role="alert" className="banner banner-danger">
              {prepareError}
            </div>
          ) : null}
          <div className="row">
            {permissions.has('invoices.lock') ? (
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={!writes || preparing || bill.lines.length === 0}
                onClick={onPrepare}
              >
                {preparing ? 'Preparing…' : 'Prepare bill and take payment'} <kbd>F2</kbd>
              </button>
            ) : null}
            {canDiscount && !sheet ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!writes || bill.lines.length === 0}
                onClick={() => {
                  onSheet({ kind: 'discount', lineId: null });
                }}
              >
                Discount…
              </button>
            ) : null}
          </div>
          <p className="muted">
            While the bill is prepared, guests at this table can't add items, so nothing is missed.
          </p>
        </div>
      ) : null}

      {inv.status === 'locked' ? (
        <>
          {canDiscount && editable && !sheet ? (
            <div className="row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!writes}
                onClick={() => {
                  onSheet({ kind: 'discount', lineId: null });
                }}
              >
                Discount…
              </button>
            </div>
          ) : null}
          {payment}
          {permissions.has('invoices.reopen') ? <Reopen bill={bill} /> : null}
        </>
      ) : null}

      {inv.status === 'settled' ? <Settled bill={bill} paid={paid} onNext={onNext} /> : null}
    </>
  );
}

/** What a line costs before its share of bill discounts (that share shows in the totals). */
function beforeBillShare(l: Bill['lines'][number]): string {
  return money.format(new Decimal(l.net).plus(l.discountAlloc));
}

function DiscountRow({ d, removable }: { d: Bill['discounts'][number]; removable: boolean }) {
  const writes = useWritesAllowed();
  const remove = useCommand();
  const label =
    d.kind === 'comp'
      ? `Comp · ${d.reason}`
      : `Discount · ${d.reason}${d.kind === 'percent' ? ` ${String(Number(d.value))}%` : ''} (${d.appliedBy}${d.approvedBy ? `, approved by ${d.approvedBy}` : ''})`;
  return (
    <>
      <dt>
        {label}
        {removable ? (
          <button
            type="button"
            className="btn btn-ghost btn-inline"
            disabled={!writes || remove.isPending}
            onClick={() => {
              remove.mutate({
                path: `/discounts/${d.id}/void`,
                body: { reason: 'Removed at the counter' },
              });
            }}
          >
            Remove <span className="visually-hidden">{label}</span>
          </button>
        ) : null}
      </dt>
      <dd>−{rupees(d.amount)}</dd>
    </>
  );
}

function Reopen({ bill }: { bill: Bill }) {
  const writes = useWritesAllowed();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);
  const reopen = useCommand(() => {
    setOpen(false);
  });
  const paidSome = Number(bill.invoice.paidTotal) > 0;
  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-ghost"
        disabled={!writes}
        onClick={() => {
          setOpen(true);
        }}
      >
        Reopen bill (add or change items)
      </button>
    );
  }
  const ready =
    writes &&
    !reopen.isPending &&
    (!paidSome || (reason.trim().length >= 3 && approvalReady(approval)));
  return (
    <form
      className="card stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setError(null);
        void (async () => {
          try {
            const stepUpId = paidSome
              ? await approve({
                  action: 'invoice.reopen_with_payments',
                  entityType: 'invoice',
                  entityId: bill.invoice.id,
                  username: approval.username,
                  pin: approval.pin,
                  reason: reason.trim(),
                })
              : undefined;
            await reopen.mutateAsync({
              path: `/invoices/${bill.invoice.id}/reopen`,
              body: {
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                ...(stepUpId ? { stepUpId } : {}),
              },
            });
          } catch (err) {
            setError(messageOf(err));
          }
        })();
      }}
    >
      <h3>Reopen the bill</h3>
      {paidSome ? (
        <>
          <p className="muted">
            {rupees(bill.invoice.paidTotal)} is already paid; it stays paid. Another manager or the
            owner approves.
          </p>
          <Field
            label="Reason"
            maxLength={120}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <ApprovalFields
            legend="Approval on this device"
            value={approval}
            onChange={setApproval}
          />
        </>
      ) : (
        <p className="muted">Guests can order again; prepare the bill once more to take payment.</p>
      )}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-secondary" disabled={!ready}>
          Reopen
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Back
        </button>
      </div>
    </form>
  );
}

function Settled({
  bill,
  paid,
  onNext,
}: {
  bill: Bill;
  paid: PaymentResult | null;
  onNext: () => void;
}) {
  const permissions = permissionSet(useSignedIn());
  const writes = useWritesAllowed();
  const [copy, setCopy] = useState<number | null>(null);
  const reprint = useCommand<{ copyNo: number }>((r) => {
    setCopy(r.copyNo);
  });
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    next.current?.focus();
  }, []);
  return (
    <div role="status" className="banner banner-success stack">
      <strong>
        Paid · {bill.invoice.invoiceNo}
        {paid?.change ? ` · change ${rupees(paid.change)}` : ''}
      </strong>
      <span>
        {paid && !paid.receiptQueued
          ? 'No receipt printer is set: reprint the receipt once one is.'
          : 'Receipt printing.'}{' '}
        {bill.session.tableName ? `${bill.session.tableName} is now free.` : ''}
      </span>
      {copy ? <span>Reprint #{copy} sent to the printer.</span> : null}
      {reprint.isError ? <span role="alert">{messageOf(reprint.error)}</span> : null}
      <div className="row">
        <button ref={next} type="button" className="btn btn-primary" onClick={onNext}>
          Next customer
        </button>
        {permissions.has('receipts.reprint') ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes || reprint.isPending}
            onClick={() => {
              reprint.mutate({ path: `/invoices/${bill.invoice.id}/receipt/reprint` });
            }}
          >
            Reprint receipt
          </button>
        ) : null}
      </div>
    </div>
  );
}
