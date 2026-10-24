/**
 * The till's cash shift (FINANCE_REPORTING.md §5, UI_UX.md "Cash shift"): open with the
 * counted float, record paid-in and paid-out with a reason, close by counting the till.
 * Expected cash = float + cash sales − cash refunds + paid-in − paid-out; the difference
 * from the count is the variance, which needs a reason and someone other than the cashier
 * to approve it (AT-37): a manager's PIN now, or later from the list below.
 * Card and transfers are shown for checking against their slips; they are not till cash.
 */
import { Decimal, money } from '@cl/shared';
import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { messageOf } from '../../api/client.ts';
import { permissionSet, type Me } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useSignedIn } from '../Shell.tsx';
import { ApprovalFields, approvalReady, noApproval } from './Approval.tsx';
import { useShift, useShifts, type Shift, type ShiftDetail } from './counter-api.ts';
import { approve, useCommand } from './useCommand.ts';

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/** May this person act on that shift? Cashiers only on their own (RBAC.md §1.3). */
function mayOperate(me: Me, shift: Shift): boolean {
  const grant = me.permissions.find((p) => p.key === 'cash_shifts.operate');
  return grant !== undefined && (grant.scopes === 'all' || shift.cashierUserId === me.user.id);
}

export function ShiftScreen() {
  const me = useSignedIn();
  const permissions = permissionSet(me);
  const current = useShift(true);
  const shifts = useShifts(true);
  const [closed, setClosed] = useState<{
    shiftId: string;
    status: string;
    variance: string;
    reportQueued: boolean;
  } | null>(null);
  const shift = current.data?.shift ?? null;
  return (
    <>
      <p>
        <Link to="/counter">← Bills &amp; payments</Link>
      </p>
      <h1>Cash shift</h1>
      {current.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(current.error)}
        </div>
      ) : null}
      {closed ? <Closed result={closed} /> : null}
      {current.isSuccess && shift === null ? (
        <OpenShift
          onOpened={() => {
            setClosed(null);
          }}
        />
      ) : null}
      {shift ? (
        <div className="counter">
          <Figures shift={shift} />
          {mayOperate(me, shift) ? (
            <div className="stack">
              <Movement shift={shift} />
              <CloseShift shift={shift} onClosed={setClosed} />
            </div>
          ) : (
            <p className="muted">
              {shift.cashier}’s shift is open on {shift.till}. They (or a manager) close it before
              you open yours.
            </p>
          )}
        </div>
      ) : null}
      <ShiftList
        items={shifts.data?.items ?? []}
        canApprove={permissions.has('cash_shifts.approve_variance')}
        meId={me.user.id}
      />
    </>
  );
}

function Figures({ shift }: { shift: ShiftDetail }) {
  return (
    <section className="card stack" aria-labelledby="figures">
      <h2 id="figures">
        {shift.till} · {shift.cashier} · since{' '}
        {new Date(shift.openedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })}
      </h2>
      <dl className="totals">
        <dt>Opening float</dt>
        <dd>{rupees(shift.openingFloat)}</dd>
        <dt>Cash sales ({shift.cashPayments})</dt>
        <dd>{rupees(shift.cashSales)}</dd>
        <dt>Cash refunds</dt>
        <dd>− {rupees(shift.cashRefunds)}</dd>
        <dt>Paid in</dt>
        <dd>{rupees(shift.paidIn)}</dd>
        <dt>Paid out</dt>
        <dd>− {rupees(shift.paidOut)}</dd>
        <dt className="total">Expected cash in the till</dt>
        <dd className="total">{rupees(shift.expectedCash)}</dd>
      </dl>
      <h3>Not in the till: check against the slips</h3>
      <dl className="totals">
        <dt>Card (HBL settlement slip)</dt>
        <dd>{rupees(shift.card)}</dd>
        <dt>JazzCash</dt>
        <dd>{rupees(shift.transfers.jazzcash)}</dd>
        <dt>Easypaisa</dt>
        <dd>{rupees(shift.transfers.easypaisa)}</dd>
        <dt>Bank transfer</dt>
        <dd>{rupees(shift.transfers.bank)}</dd>
      </dl>
      {shift.movements.length > 0 ? (
        <>
          <h3>Paid in and out</h3>
          <ul className="muted">
            {shift.movements.map((m) => (
              <li key={m.id}>
                {m.kind === 'paid_in' ? 'In' : 'Out'} {rupees(m.amount)} · {m.reason} · {m.by}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function OpenShift({ onOpened }: { onOpened: () => void }) {
  const writes = useWritesAllowed();
  const [float, setFloat] = useState('');
  const open = useCommand(onOpened);
  const ok = AMOUNT.test(float.trim());
  return (
    <form
      className="card stack"
      noValidate
      aria-labelledby="open-shift"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && writes)
          open.mutate({ path: '/cash-shifts', body: { openingFloat: float.trim() } });
      }}
    >
      <h2 id="open-shift">Open a shift</h2>
      <p className="muted">Count the cash in the till first: that is the opening float.</p>
      <Field
        label="Opening float (Rs)"
        inputMode="decimal"
        value={float}
        onChange={(e) => {
          setFloat(e.target.value);
        }}
      />
      {open.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(open.error)}
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!ok || !writes || open.isPending}
        >
          Open shift
        </button>
      </div>
    </form>
  );
}

function Movement({ shift }: { shift: ShiftDetail }) {
  const writes = useWritesAllowed();
  const [kind, setKind] = useState('paid_out');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const add = useCommand<{ expectedCash: string }>(() => {
    setDone(
      `${kind === 'paid_in' ? 'Paid in' : 'Paid out'} ${rupees(money.format(new Decimal(amount)))} recorded.`,
    );
    setAmount('');
    setReason('');
  });
  const ok = AMOUNT.test(amount.trim()) && Number(amount) > 0 && reason.trim().length >= 3;
  return (
    <form
      className="card stack"
      noValidate
      aria-labelledby="movement"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || !writes) return;
        setDone(null);
        add.mutate({
          path: `/cash-shifts/${shift.id}/movements`,
          body: { kind, amount: amount.trim(), reason: reason.trim() },
        });
      }}
    >
      <h2 id="movement">Paid in or out</h2>
      <div className="row">
        <SelectField
          label="Money"
          value={kind}
          options={[
            { value: 'paid_out', label: 'Paid out of the till' },
            { value: 'paid_in', label: 'Paid into the till' },
          ]}
          onChange={setKind}
        />
        <Field
          label="Amount (Rs)"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
        />
      </div>
      <Field
        label="What for"
        maxLength={120}
        placeholder="e.g. Milk top-up, receipt kept"
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(add.error)}
        </div>
      ) : null}
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!ok || !writes || add.isPending}
        >
          Record
        </button>
      </div>
    </form>
  );
}

function CloseShift({
  shift,
  onClosed,
}: {
  shift: ShiftDetail;
  onClosed: (r: {
    shiftId: string;
    status: string;
    variance: string;
    reportQueued: boolean;
  }) => void;
}) {
  const writes = useWritesAllowed();
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [approveNow, setApproveNow] = useState(false);
  const [approval, setApproval] = useState(noApproval);
  const [error, setError] = useState<string | null>(null);
  const close = useCommand<{
    shiftId: string;
    status: string;
    variance: string;
    reportQueued: boolean;
  }>(onClosed);
  const countedOk = AMOUNT.test(counted.trim());
  const variance = countedOk ? new Decimal(counted.trim()).minus(shift.expectedCash) : null;
  const off = variance !== null && !variance.isZero();
  const ready =
    writes &&
    !close.isPending &&
    countedOk &&
    (!off || reason.trim().length >= 3) &&
    (!off || !approveNow || approvalReady(approval));

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const stepUpId =
        off && approveNow
          ? await approve({
              action: 'shift.variance',
              entityType: 'cash_shift',
              entityId: shift.id,
              username: approval.username,
              pin: approval.pin,
              reason: reason.trim(),
            })
          : undefined;
      await close.mutateAsync({
        path: `/cash-shifts/${shift.id}/close`,
        body: {
          countedCash: counted.trim(),
          ...(off ? { varianceReason: reason.trim() } : {}),
          ...(stepUpId ? { stepUpId } : {}),
        },
      });
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <form
      className="card stack"
      noValidate
      aria-labelledby="close-shift"
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <h2 id="close-shift">Close the shift</h2>
      {shift.withRiders.length > 0 ? (
        <div role="status" className="banner banner-warning">
          Still with riders, not in the till:{' '}
          {shift.withRiders.map((r) => `${r.rider} ${rupees(r.amount)}`).join(', ')}. Record their
          return first, or it goes into the next shift.
        </div>
      ) : null}
      <p className="muted">Count every note and coin in the till, then enter the total.</p>
      <Field
        label="Counted cash (Rs)"
        inputMode="decimal"
        value={counted}
        onChange={(e) => {
          setCounted(e.target.value);
        }}
      />
      {variance !== null ? (
        <p aria-live="polite" className={off ? 'banner banner-warning' : 'banner banner-success'}>
          {off
            ? `The till is ${rupees(money.format(variance.abs()))} ${variance.isNegative() ? 'short' : 'over'} (expected ${rupees(shift.expectedCash)}).`
            : 'The till balances.'}
        </p>
      ) : null}
      {off ? (
        <>
          <Field
            label="Why the difference"
            maxLength={120}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={approveNow}
              onChange={(e) => {
                setApproveNow(e.target.checked);
              }}
            />
            A manager approves now on this device
          </label>
          {approveNow ? (
            <ApprovalFields legend="Manager approval" value={approval} onChange={setApproval} />
          ) : (
            <p className="muted">Otherwise a manager approves it later from their own login.</p>
          )}
        </>
      ) : null}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {close.isPending ? 'Closing…' : 'Close shift'}
        </button>
      </div>
    </form>
  );
}

function Closed({
  result,
}: {
  result: { shiftId: string; status: string; variance: string; reportQueued: boolean };
}) {
  const writes = useWritesAllowed();
  const reprint = useCommand<{ copyNo: number }>();
  return (
    <div role="status" className="banner banner-success stack">
      <strong>
        Shift closed.{' '}
        {result.status === 'approved'
          ? Number(result.variance) === 0
            ? 'The till balanced.'
            : `Variance ${rupees(result.variance)} approved.`
          : `Variance ${rupees(result.variance)} is waiting for a manager’s approval.`}
      </strong>
      <span>
        {result.reportQueued
          ? 'The shift report is printing.'
          : 'No receipt printer is set, so no report printed.'}
      </span>
      {reprint.isError ? <span role="alert">{messageOf(reprint.error)}</span> : null}
      {result.reportQueued ? (
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes || reprint.isPending}
            onClick={() => {
              reprint.mutate({ path: `/cash-shifts/${result.shiftId}/report/reprint` });
            }}
          >
            {reprint.isSuccess ? 'Reprint sent' : 'Reprint report'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ShiftList({
  items,
  canApprove,
  meId,
}: {
  items: Shift[];
  canApprove: boolean;
  meId: string;
}) {
  const writes = useWritesAllowed();
  const approveShift = useCommand();
  const done = items.filter((s) => s.status !== 'open');
  if (done.length === 0) return null;
  return (
    <section className="stack" aria-labelledby="past-shifts">
      <h2 id="past-shifts">Closed shifts</h2>
      {approveShift.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(approveShift.error)}
        </div>
      ) : null}
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Cashier</th>
            <th scope="col">Closed</th>
            <th scope="col" className="num">
              Expected
            </th>
            <th scope="col" className="num">
              Counted
            </th>
            <th scope="col" className="num">
              Variance
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {done.map((s) => (
            <tr key={s.id}>
              <td>{s.cashier}</td>
              <td>{s.closedAt ? new Date(s.closedAt).toLocaleString() : ''}</td>
              <td className="num">{rupees(s.expectedCash)}</td>
              <td className="num">{s.countedCash ? rupees(s.countedCash) : ''}</td>
              <td className="num">
                {s.variance ? rupees(s.variance) : ''}
                {s.varianceReason ? <div className="muted">{s.varianceReason}</div> : null}
              </td>
              <td>
                {s.status === 'approved' ? (
                  <span className="chip chip-ok">
                    {s.approvedBy ? `Approved by ${s.approvedBy}` : 'Balanced'}
                  </span>
                ) : canApprove && s.cashierUserId !== meId ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!writes || approveShift.isPending}
                    onClick={() => {
                      approveShift.mutate({ path: `/cash-shifts/${s.id}/approve` });
                    }}
                  >
                    Approve variance <span className="visually-hidden">of {s.cashier}</span>
                  </button>
                ) : (
                  <span className="chip chip-warning">Waiting for approval</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
