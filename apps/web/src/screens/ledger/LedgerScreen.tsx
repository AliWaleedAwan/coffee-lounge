/**
 * Ledger (FINANCE_REPORTING.md §4; Phase 5 step 5.1): every rupee that moved, by date
 * range and channel, with the running balance of each channel and what each entry came
 * from. The owner may post a manual entry with a reason and reverse one; nothing is
 * ever edited (D-31). Entries from sales, cash, purchases and supplier refunds appear
 * by themselves.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import { rupees } from '../inventory/inventory-api.ts';
import { useSignedIn } from '../Shell.tsx';

type Channel = 'cash' | 'card' | 'transfer' | 'other';
type Provider = 'bank' | 'jazzcash' | 'easypaisa';

interface Entry {
  id: string;
  entryNo: string;
  entryType: string;
  direction: 'in' | 'out';
  amount: string;
  channel: Channel;
  provider: Provider | null;
  businessDate: string;
  sourceType: string;
  source: string;
  link: string | null;
  memo: string | null;
  reversesEntryNo: string | null;
  reversedByEntryNo: string | null;
  createdBy: string | null;
  balanceAfter: string;
}
interface Balance {
  channel: Channel;
  provider: Provider | null;
  opening: string;
  in: string;
  out: string;
  closing: string;
}
interface Ledger {
  from: string;
  to: string;
  balances: Balance[];
  entries: Entry[];
  truncated: boolean;
}

const CHANNELS: Record<Channel, string> = {
  cash: 'Cash',
  card: 'Card',
  transfer: 'Transfer',
  other: 'Other',
};
const PROVIDERS: Record<Provider, string> = {
  bank: 'Bank',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
};
const TYPES: Record<string, string> = {
  sale_receipt: 'Sale',
  refund: 'Refund',
  purchase_payment: 'Purchase',
  expense: 'Expense',
  cash_in: 'Cash in',
  cash_out: 'Cash out',
  adjustment: 'Manual entry',
  reversal: 'Reversal',
};
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;

const channelName = (c: Channel, p: Provider | null) =>
  p ? `${CHANNELS[c]} · ${PROVIDERS[p]}` : CHANNELS[c];

/** A command made once per intent: a retry after a lost answer reuses its key. */
function useLedgerCommand<T>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  const intent = useRef<{ key: string; body: string } | null>(null);
  return useMutation({
    mutationFn: (c: { path: string; body: unknown }) => {
      const body = JSON.stringify([c.path, c.body]);
      if (intent.current?.body !== body) intent.current = { key: crypto.randomUUID(), body };
      return api<T>(c.path, { method: 'POST', body: c.body, idempotencyKey: intent.current.key });
    },
    onSuccess: (result) => {
      intent.current = null;
      onDone?.(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status > 0) intent.current = null;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['ledger'] }),
  });
}

export function LedgerScreen() {
  const canManage = permissionSet(useSignedIn()).has('ledger.manage');
  // Empty means the server's default: this business month up to the shop's business day.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [channel, setChannel] = useState<'' | Channel>('');
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const rangeOk =
    (from === '' || DATE.test(from)) &&
    (to === '' || DATE.test(to)) &&
    (!from || !to || from <= to);
  const params = new URLSearchParams({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(channel ? { channel } : {}),
  }).toString();
  const ledger = useQuery({
    queryKey: ['ledger', params],
    queryFn: ({ signal }) => api<Ledger>(`/ledger${params ? `?${params}` : ''}`, { signal }),
    meta: { topics: ['ledger'] },
    enabled: rangeOk,
    placeholderData: (previous) => previous,
  });
  const shownFrom = from || ledger.data?.from || '';
  const shownTo = to || ledger.data?.to || '';
  const data = ledger.data;

  return (
    <>
      <h1>Ledger</h1>
      <p className="muted">
        Recorded money in and out, by the business date it belongs to. Nothing here is ever edited:
        a mistake is reversed and posted again.
      </p>
      <section className="card stack" aria-label="Period">
        <div className="row">
          <Field
            label="From"
            type="date"
            value={shownFrom}
            max={shownTo}
            onChange={(e) => {
              setFrom(e.target.value);
              setTo(shownTo);
            }}
          />
          <Field
            label="To"
            type="date"
            value={shownTo}
            min={shownFrom}
            onChange={(e) => {
              setTo(e.target.value);
              setFrom(shownFrom);
            }}
          />
          <SelectField
            label="Channel"
            value={channel}
            options={[
              { value: '', label: 'All channels' },
              ...Object.entries(CHANNELS).map(([value, label]) => ({ value, label })),
            ]}
            onChange={(v) => {
              setChannel(v as '' | Channel);
            }}
          />
        </div>
        {!rangeOk ? (
          <div role="alert" className="banner banner-danger">
            The start date must be on or before the end date.
          </div>
        ) : null}
      </section>

      {canManage ? <ManualEntry /> : null}

      {ledger.isPending && rangeOk ? <Loading /> : null}
      {ledger.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(ledger.error)}
        </div>
      ) : null}
      {data ? (
        <>
          <section className="card stack" aria-labelledby="balances-head">
            <h2 id="balances-head">Balances</h2>
            {data.balances.length === 0 ? (
              <p className="muted">No money recorded up to {data.to}.</p>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Channel</th>
                    <th scope="col">Before {data.from}</th>
                    <th scope="col">In</th>
                    <th scope="col">Out</th>
                    <th scope="col">At end of {data.to}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.balances.map((b) => (
                    <tr key={`${b.channel}-${b.provider ?? ''}`}>
                      <th scope="row">{channelName(b.channel, b.provider)}</th>
                      <td>{rupees(b.opening)}</td>
                      <td>{rupees(b.in)}</td>
                      <td>{rupees(b.out)}</td>
                      <td>
                        <strong>{rupees(b.closing)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <Entries data={data} canManage={canManage} />
        </>
      ) : null}
    </>
  );
}

function Entries({ data, canManage }: { data: Ledger; canManage: boolean }) {
  const [reversing, setReversing] = useState<Entry | null>(null);
  return (
    <section className="card stack" aria-labelledby="entries-head">
      <h2 id="entries-head">Entries</h2>
      {data.truncated ? (
        <div role="status" className="banner banner-warning">
          Only the first entries of this period are shown; choose a shorter period to see all.
        </div>
      ) : null}
      {data.entries.length === 0 ? (
        <p className="muted">No entries in this period.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Entry</th>
              <th scope="col">Date</th>
              <th scope="col">What</th>
              <th scope="col">From</th>
              <th scope="col">Channel</th>
              <th scope="col">In</th>
              <th scope="col">Out</th>
              <th scope="col">Balance</th>
              {canManage ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td>{e.entryNo}</td>
                <td>{e.businessDate}</td>
                <td>
                  {TYPES[e.entryType] ?? e.entryType}
                  {e.reversesEntryNo ? (
                    <span className="muted"> of {e.reversesEntryNo}</span>
                  ) : null}
                  {e.reversedByEntryNo ? (
                    <span className="muted"> · reversed by {e.reversedByEntryNo}</span>
                  ) : null}
                </td>
                <td>
                  {e.link ? <Link to={e.link}>{e.source}</Link> : e.source}
                  {e.createdBy ? <span className="muted"> · {e.createdBy}</span> : null}
                </td>
                <td>{channelName(e.channel, e.provider)}</td>
                <td>{e.direction === 'in' ? rupees(e.amount) : ''}</td>
                <td>{e.direction === 'out' ? rupees(e.amount) : ''}</td>
                <td>{rupees(e.balanceAfter)}</td>
                {canManage ? (
                  <td>
                    {e.entryType === 'adjustment' && !e.reversedByEntryNo ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => {
                          setReversing(e);
                        }}
                      >
                        Reverse<span className="visually-hidden"> {e.entryNo}</span>
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted">
        The balance is that of the entry’s own channel{' '}
        {data.entries.some((e) => e.provider) ? '(transfers per provider) ' : ''}after it.
      </p>
      {reversing ? (
        <Reverse
          entry={reversing}
          onClose={() => {
            setReversing(null);
          }}
        />
      ) : null}
    </section>
  );
}

function ManualEntry() {
  const writes = useWritesAllowed();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState<Channel>('cash');
  const [provider, setProvider] = useState<Provider>('bank');
  const [memo, setMemo] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const post = useLedgerCommand<{ entryNo: string }>((result) => {
    setDone(`Posted ${result.entryNo}.`);
    setAmount('');
    setMemo('');
    setOpen(false);
  });
  const amountOk = AMOUNT.test(amount) && Number(amount) > 0;
  const valid = amountOk && memo.trim().length >= 3;

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes) return;
    post.mutate({
      path: '/ledger/entries',
      body: {
        direction,
        amount,
        channel,
        ...(channel === 'transfer' ? { provider } : {}),
        memo: memo.trim(),
      },
    });
  };

  return (
    <section className="card stack" aria-labelledby="manual-head">
      <h2 id="manual-head">Manual entry</h2>
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {!open ? (
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setOpen(true);
              setDone(null);
            }}
          >
            New manual entry
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit} noValidate aria-label="New manual entry">
          <p className="muted">
            For money the system did not record by itself, such as what is in the cash box or the
            bank on the first day. Posted on today’s business date.
          </p>
          <div className="row">
            <SelectField
              label="Direction"
              value={direction}
              options={[
                { value: 'in', label: 'Money in' },
                { value: 'out', label: 'Money out' },
              ]}
              onChange={(v) => {
                setDirection(v as 'in' | 'out');
              }}
            />
            <Field
              label="Amount (Rs)"
              inputMode="decimal"
              value={amount}
              error={amount && !amountOk ? 'An amount such as 5000 or 99.50' : null}
              onChange={(e) => {
                setAmount(e.target.value.trim());
              }}
            />
            <SelectField
              label="Channel"
              value={channel}
              options={Object.entries(CHANNELS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => {
                setChannel(v as Channel);
              }}
            />
            {channel === 'transfer' ? (
              <SelectField
                label="Provider"
                value={provider}
                options={Object.entries(PROVIDERS).map(([value, label]) => ({ value, label }))}
                onChange={(v) => {
                  setProvider(v as Provider);
                }}
              />
            ) : null}
          </div>
          <Field
            label="Reason"
            maxLength={300}
            value={memo}
            onChange={(e) => {
              setMemo(e.target.value);
            }}
          />
          {post.isError ? (
            <div role="alert" className="banner banner-danger">
              {writeMessage(post.error)}
            </div>
          ) : null}
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!valid || !writes || post.isPending}
            >
              Post entry
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Reverse({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const writes = useWritesAllowed();
  const [reason, setReason] = useState('');
  const reverse = useLedgerCommand<{ entryNo: string }>(onClose);
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (reason.trim().length < 3 || !writes) return;
    reverse.mutate({
      path: `/ledger/entries/${entry.id}/reverse`,
      body: { reason: reason.trim() },
    });
  };
  return (
    <form
      className="card stack"
      onSubmit={submit}
      noValidate
      aria-label={`Reverse ${entry.entryNo}`}
    >
      <strong>
        Reverse {entry.entryNo}: {TYPES[entry.entryType]} {entry.direction === 'in' ? 'in' : 'out'}{' '}
        {rupees(entry.amount)}, {channelName(entry.channel, entry.provider)}
      </strong>
      <p className="muted">
        A reversal entry of the same amount the other way is posted today; the original stays.
      </p>
      <Field
        label="Why"
        maxLength={300}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      {reverse.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(reverse.error)}
        </div>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className="btn btn-danger"
          disabled={reason.trim().length < 3 || !writes || reverse.isPending}
        >
          Reverse entry
        </button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
