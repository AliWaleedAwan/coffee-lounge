/**
 * Expenses (FINANCE_REPORTING.md §3–4; Phase 5 step 5.3): what the shop paid that is not
 * stock (rent, wages, repairs…), by category, with the bill's photo or PDF (P5-3). An
 * expense is never edited: it is voided with a reason, or corrected (voided and recorded
 * again, each pointing at the other). Cash paid from the till while a shift is open is
 * also that shift's paid-out (P5-6). `?expense=<id>` opens one (from the ledger).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, API_BASE, ApiError, errorFrom, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useSignedIn } from '../Shell.tsx';

type PaidVia = 'cash' | 'card' | 'transfer' | 'other';
type Provider = 'bank' | 'jazzcash' | 'easypaisa';

interface Category {
  id: string;
  name: string;
  isActive: boolean;
  used: number;
}
interface Expense {
  id: string;
  expenseNo: string;
  categoryId: string;
  category: string;
  amount: string;
  payee: string | null;
  reference: string | null;
  note: string | null;
  businessDate: string;
  paidVia: PaidVia;
  provider: Provider | null;
  fromTill: boolean;
  status: 'recorded' | 'voided';
  attachment: { type: string; size: number } | null;
  createdBy: string;
  voidedBy: string | null;
  voidReason: string | null;
  replacesNo: string | null;
  replacedByNo: string | null;
}
interface Period {
  from: string;
  to: string;
  items: Expense[];
  totals: { categoryId: string; category: string; amount: string; count: number }[];
  total: string;
}

const PAID_VIA: Record<PaidVia, string> = {
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
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const BILL_TYPES = 'image/jpeg,image/png,application/pdf';
const MAX_BILL = 5 * 1024 * 1024;
const paidVia = (e: Pick<Expense, 'paidVia' | 'provider' | 'fromTill'>) =>
  e.provider
    ? `${PAID_VIA[e.paidVia]} · ${PROVIDERS[e.provider]}`
    : e.fromTill
      ? 'Cash from the till'
      : PAID_VIA[e.paidVia];

function useCategories() {
  return useQuery({
    queryKey: ['expenses', 'categories'],
    queryFn: ({ signal }) => api<{ items: Category[] }>('/expense-categories', { signal }),
    meta: { topics: ['expenses'] },
  });
}

/** A command made once per intent: a retry after a lost answer reuses its key. */
function useExpenseCommand<T>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  const intent = useRef<{ key: string; body: string } | null>(null);
  return useMutation({
    mutationFn: (c: { path: string; body: unknown; method?: 'POST' | 'PATCH' }) => {
      const body = JSON.stringify([c.path, c.body]);
      if (intent.current?.body !== body) intent.current = { key: crypto.randomUUID(), body };
      return api<T>(c.path, {
        method: c.method ?? 'POST',
        body: c.body,
        ...(c.method === 'PATCH' ? {} : { idempotencyKey: intent.current.key }),
      });
    },
    onSuccess: (result) => {
      intent.current = null;
      onDone?.(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status > 0) intent.current = null;
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['expenses'] }),
        client.invalidateQueries({ queryKey: ['ledger'] }),
        client.invalidateQueries({ queryKey: ['shift'] }),
      ]);
    },
  });
}

/** PUT the bill file itself (the API reads its real type from the bytes). */
async function uploadBill(expenseId: string, file: File): Promise<void> {
  const res = await fetch(`${API_BASE}/expenses/${expenseId}/attachment`, {
    method: 'PUT',
    headers: { 'content-type': file.type, 'x-cl-request': '1', accept: 'application/json' },
    credentials: 'same-origin',
    body: file,
  });
  if (!res.ok) throw await errorFrom(res);
}

function billProblem(file: File | null): string | null {
  if (!file) return null;
  if (!BILL_TYPES.split(',').includes(file.type)) return 'A photo (JPEG or PNG) or a PDF';
  if (file.size > MAX_BILL) return 'At most 5 MB: take the photo at a lower size';
  return null;
}

export function ExpensesScreen() {
  const permissions = permissionSet(useSignedIn());
  const canManage = permissions.has('expenses.manage');
  const [tab, setTab] = useState<'expenses' | 'categories'>('expenses');
  return (
    <>
      <h1>Expenses</h1>
      <p className="muted">
        What the shop paid that is not stock: rent, wages, repairs, bills. Ingredients are received
        in Inventory. An expense is never edited: void it, or correct it.
      </p>
      {canManage ? (
        <div className="tabs" role="tablist" aria-label="Expenses sections">
          {(['expenses', 'categories'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`expenses-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="expenses-panel"
              onClick={() => {
                setTab(t);
              }}
            >
              {t === 'expenses' ? 'Expenses' : 'Categories'}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id="expenses-panel"
        role={canManage ? 'tabpanel' : undefined}
        aria-labelledby={canManage ? `expenses-tab-${tab}` : undefined}
        className="stack"
      >
        {tab === 'expenses' ? <ExpensesTab canManage={canManage} /> : <CategoriesTab />}
      </div>
    </>
  );
}

function ExpensesTab({ canManage }: { canManage: boolean }) {
  const [params, setParams] = useSearchParams();
  const opened = params.get('expense');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const [correcting, setCorrecting] = useState<Expense | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const query = new URLSearchParams({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(status ? { status } : {}),
  }).toString();
  const period = useQuery({
    queryKey: ['expenses', 'list', query],
    queryFn: ({ signal }) => api<Period>(`/expenses${query ? `?${query}` : ''}`, { signal }),
    meta: { topics: ['expenses'] },
    placeholderData: (previous) => previous,
  });
  const one = useQuery({
    queryKey: ['expenses', 'one', opened],
    queryFn: ({ signal }) => api<Expense>(`/expenses/${opened ?? ''}`, { signal }),
    enabled: opened !== null,
    meta: { topics: ['expenses'] },
  });
  const categories = useCategories();
  const shownFrom = from || period.data?.from || '';
  const shownTo = to || period.data?.to || '';
  const p = period.data;
  return (
    <>
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {canManage && !correcting ? (
        <ExpenseForm
          key="new"
          categories={categories.data?.items ?? []}
          onDone={(msg) => {
            setDone(msg);
          }}
        />
      ) : null}
      {correcting ? (
        <ExpenseForm
          key={`fix-${correcting.id}`}
          categories={categories.data?.items ?? []}
          correcting={correcting}
          onDone={(msg) => {
            setCorrecting(null);
            setDone(msg);
          }}
          onCancel={() => {
            setCorrecting(null);
          }}
        />
      ) : null}
      {opened && one.data ? (
        <section className="card stack" aria-label={`Expense ${one.data.expenseNo}`}>
          <ExpenseDetail expense={one.data} />
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setParams({});
              }}
            >
              Close
            </button>
          </div>
        </section>
      ) : null}
      <section className="card stack" aria-labelledby="period-head">
        <h2 id="period-head">Expenses by period</h2>
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
            label="Category"
            value={categoryId}
            options={[
              { value: '', label: 'All categories' },
              ...(categories.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={setCategoryId}
          />
          <SelectField
            label="Status"
            value={status}
            options={[
              { value: '', label: 'Recorded and voided' },
              { value: 'recorded', label: 'Recorded' },
              { value: 'voided', label: 'Voided' },
            ]}
            onChange={setStatus}
          />
        </div>
        {period.isPending ? <Loading label="Loading expenses" /> : null}
        {period.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(period.error)}
          </div>
        ) : null}
        {p ? (
          <>
            <p>
              <strong>Recorded expenses {rupees(p.total)}</strong>
              {p.totals.length > 0
                ? ` · ${p.totals.map((t) => `${t.category} ${rupees(t.amount)}`).join(' · ')}`
                : ''}
            </p>
            {p.items.length === 0 ? (
              <p className="muted">No expenses in this period.</p>
            ) : (
              <table className="data" aria-label="Expenses">
                <thead>
                  <tr>
                    <th scope="col">Number</th>
                    <th scope="col">Date</th>
                    <th scope="col">Category</th>
                    <th scope="col">Payee</th>
                    <th scope="col">Paid by</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Bill</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((e) => (
                    <ExpenseRow
                      key={e.id}
                      e={e}
                      canManage={canManage}
                      onCorrect={() => {
                        setDone(null);
                        setCorrecting(e);
                      }}
                      onDone={setDone}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </section>
    </>
  );
}

function ExpenseDetail({ expense: e }: { expense: Expense }) {
  return (
    <>
      <h2>
        {e.expenseNo} · {e.category} · {rupees(e.amount)}
      </h2>
      <p>
        {e.businessDate} · {paidVia(e)}
        {e.payee ? ` · ${e.payee}` : ''}
        {e.reference ? ` · ref ${e.reference}` : ''} · recorded by {e.createdBy}
      </p>
      {e.note ? <p>{e.note}</p> : null}
      {e.status === 'voided' ? (
        <p className="banner banner-warning">
          Voided by {e.voidedBy ?? ''}: {e.voidReason ?? ''}
          {e.replacedByNo ? ` · replaced by ${e.replacedByNo}` : ''}
        </p>
      ) : null}
      {e.replacesNo ? <p className="muted">Corrects {e.replacesNo}.</p> : null}
      {e.attachment ? <Bill expense={e} /> : <p className="muted">No bill attached.</p>}
    </>
  );
}

/**
 * The attached bill, inside the page: a photo shows here (the counter app opens no new
 * windows); a PDF is downloaded and opened by the PC's own viewer. The counter app does
 * not download files yet (a reviewed download path comes with exports, Phase 6).
 */
function Bill({ expense: e }: { expense: Pick<Expense, 'id' | 'expenseNo' | 'attachment'> }) {
  const [open, setOpen] = useState(false);
  const url = `${API_BASE}/expenses/${e.id}/attachment`;
  if (e.attachment?.type === 'application/pdf') {
    return (
      <a href={url} download={`${e.expenseNo}.pdf`}>
        Download<span className="visually-hidden"> the bill of {e.expenseNo}</span> (PDF)
      </a>
    );
  }
  return (
    <div className="stack">
      <button
        type="button"
        className="btn btn-ghost"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? 'Hide' : 'Show'}
        <span className="visually-hidden"> the bill of {e.expenseNo}</span>
      </button>
      {open ? <img src={url} alt={`Bill of ${e.expenseNo}`} className="bill-image" /> : null}
    </div>
  );
}

function ExpenseRow({
  e,
  canManage,
  onCorrect,
  onDone,
}: {
  e: Expense;
  canManage: boolean;
  onCorrect: () => void;
  onDone: (message: string) => void;
}) {
  const writes = useWritesAllowed();
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const client = useQueryClient();
  const voidIt = useExpenseCommand<{ expenseNo: string; backInTill: boolean }>((r) => {
    setVoiding(false);
    onDone(
      `${r.expenseNo} voided${r.backInTill ? ': the cash is back in the till of the open shift' : ''}.`,
    );
  });
  const voided = e.status === 'voided';
  return (
    <>
      <tr className={voided ? 'muted' : undefined}>
        <td>
          {e.expenseNo}
          {voided ? ' (voided)' : ''}
        </td>
        <td>{e.businessDate}</td>
        <td>{e.category}</td>
        <td>{e.payee ?? ''}</td>
        <td>{paidVia(e)}</td>
        <td>{rupees(e.amount)}</td>
        <td>
          {e.attachment ? (
            <Bill expense={e} />
          ) : canManage && !voided ? (
            <label className="btn btn-ghost">
              Attach<span className="visually-hidden"> a bill to {e.expenseNo}</span>
              <input
                type="file"
                accept={BILL_TYPES}
                className="visually-hidden"
                disabled={!writes || uploading}
                onChange={(ev) => {
                  const file = ev.target.files?.[0] ?? null;
                  const problem = billProblem(file);
                  if (problem || !file) {
                    setError(problem);
                    return;
                  }
                  setUploading(true);
                  setError(null);
                  uploadBill(e.id, file)
                    .then(() => client.invalidateQueries({ queryKey: ['expenses'] }))
                    .catch((err: unknown) => {
                      setError(messageOf(err));
                    })
                    .finally(() => {
                      setUploading(false);
                    });
                }}
              />
            </label>
          ) : (
            ''
          )}
        </td>
        <td>
          {canManage && !voided ? (
            <div className="row">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!writes}
                onClick={onCorrect}
              >
                Correct<span className="visually-hidden"> {e.expenseNo}</span>
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!writes}
                onClick={() => {
                  setVoiding(true);
                }}
              >
                Void<span className="visually-hidden"> {e.expenseNo}</span>
              </button>
            </div>
          ) : voided ? (
            <span className="muted">{e.voidReason}</span>
          ) : null}
        </td>
      </tr>
      {voiding || error ? (
        <tr>
          <td colSpan={8}>
            {error ? (
              <div role="alert" className="banner banner-danger">
                {error}
              </div>
            ) : null}
            {voiding ? (
              <form
                className="row"
                aria-label={`Void ${e.expenseNo}`}
                noValidate
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (reason.trim().length < 3 || !writes) return;
                  voidIt.mutate({
                    path: `/expenses/${e.id}/void`,
                    body: { reason: reason.trim() },
                  });
                }}
              >
                <Field
                  label="Why is it voided"
                  maxLength={300}
                  value={reason}
                  onChange={(ev) => {
                    setReason(ev.target.value);
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={reason.trim().length < 3 || !writes || voidIt.isPending}
                >
                  Void expense
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setVoiding(false);
                  }}
                >
                  Cancel
                </button>
                {voidIt.isError ? <span role="alert">{messageOf(voidIt.error)}</span> : null}
              </form>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ExpenseForm({
  categories,
  correcting,
  onDone,
  onCancel,
}: {
  categories: Category[];
  correcting?: Expense;
  onDone: (message: string) => void;
  onCancel?: () => void;
}) {
  const writes = useWritesAllowed();
  const [open, setOpen] = useState(correcting !== undefined);
  const active = categories.filter((c) => c.isActive);
  const [categoryId, setCategoryId] = useState(correcting?.categoryId ?? '');
  const [amount, setAmount] = useState(correcting?.amount ?? '');
  const [via, setVia] = useState<PaidVia>(correcting?.paidVia ?? 'cash');
  const [provider, setProvider] = useState<Provider>(correcting?.provider ?? 'bank');
  const [fromTill, setFromTill] = useState(correcting?.fromTill ?? false);
  const [date, setDate] = useState(correcting?.businessDate ?? '');
  const [payee, setPayee] = useState(correcting?.payee ?? '');
  const [reference, setReference] = useState(correcting?.reference ?? '');
  const [note, setNote] = useState(correcting?.note ?? '');
  const [why, setWhy] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const command = useExpenseCommand<{ id: string; expenseNo: string; voidedNo?: string }>();
  const amountOk = AMOUNT.test(amount) && Number(amount) > 0;
  const fileProblem = billProblem(file);
  const ready =
    writes &&
    !command.isPending &&
    categoryId !== '' &&
    amountOk &&
    !fileProblem &&
    (!correcting || why.trim().length >= 3);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    const body = {
      categoryId,
      amount,
      paidVia: via,
      ...(via === 'transfer' ? { provider } : {}),
      ...(via === 'cash' && fromTill ? { fromTill: true } : {}),
      ...(date && !(via === 'cash' && fromTill) ? { businessDate: date } : {}),
      ...(payee.trim() ? { payee: payee.trim() } : {}),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    void (async () => {
      try {
        const result = await command.mutateAsync({
          path: correcting ? `/expenses/${correcting.id}/correct` : '/expenses',
          body: correcting ? { ...body, reason: why.trim() } : body,
        });
        let billNote = '';
        if (file) {
          try {
            await uploadBill(result.id, file);
            billNote = ' with its bill';
          } catch (err) {
            billNote = `; the bill was not attached (${messageOf(err)}): attach it from the list`;
          }
        }
        setOpen(false);
        setAmount('');
        setPayee('');
        setReference('');
        setNote('');
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
        onDone(
          correcting
            ? `${result.voidedNo ?? correcting.expenseNo} voided and recorded again as ${result.expenseNo}${billNote}.`
            : `Recorded ${result.expenseNo}${billNote}.`,
        );
      } catch (err) {
        setError(messageOf(err));
      }
    })();
  };

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!writes}
          onClick={() => {
            setOpen(true);
          }}
        >
          Record an expense
        </button>
      </div>
    );
  }
  return (
    <form
      className="card stack"
      onSubmit={submit}
      noValidate
      aria-label={correcting ? `Correct ${correcting.expenseNo}` : 'Record an expense'}
    >
      <h2>{correcting ? `Correct ${correcting.expenseNo}` : 'Record an expense'}</h2>
      {correcting ? (
        <p className="muted">
          {correcting.expenseNo} is voided with your reason and recorded again with the figures
          below; its bill stays attached unless you choose another.
        </p>
      ) : null}
      <div className="row">
        <SelectField
          label="Category"
          value={categoryId}
          options={[
            { value: '', label: 'Choose…' },
            ...active.map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={setCategoryId}
        />
        <Field
          label="Amount (Rs)"
          inputMode="decimal"
          value={amount}
          error={amount && !amountOk ? 'An amount such as 45000 or 99.50' : null}
          onChange={(e) => {
            setAmount(e.target.value.trim());
          }}
        />
        <SelectField
          label="Paid by"
          value={via}
          options={Object.entries(PAID_VIA).map(([value, label]) => ({ value, label }))}
          onChange={(v) => {
            setVia(v as PaidVia);
          }}
        />
        {via === 'transfer' ? (
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
      {via === 'cash' ? (
        <label className="row">
          <input
            type="checkbox"
            checked={fromTill}
            onChange={(e) => {
              setFromTill(e.target.checked);
            }}
          />{' '}
          Paid from the till now (a paid-out of the open cash shift)
        </label>
      ) : null}
      <div className="row">
        {!(via === 'cash' && fromTill) ? (
          <Field
            label="Date"
            type="date"
            value={date}
            hint="Leave empty for today; up to 31 days back"
            onChange={(e) => {
              setDate(e.target.value);
            }}
          />
        ) : null}
        <Field
          label="Paid to"
          maxLength={80}
          value={payee}
          onChange={(e) => {
            setPayee(e.target.value);
          }}
        />
        <Field
          label="Bill or reference number"
          maxLength={40}
          value={reference}
          onChange={(e) => {
            setReference(e.target.value);
          }}
        />
      </div>
      <Field
        label="Note"
        maxLength={300}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
        }}
      />
      <Field
        ref={fileRef}
        label="Bill (photo or PDF, up to 5 MB)"
        type="file"
        accept={BILL_TYPES}
        error={fileProblem}
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
        }}
      />
      {correcting ? (
        <Field
          label="Why is it corrected"
          maxLength={300}
          value={why}
          onChange={(e) => {
            setWhy(e.target.value);
          }}
        />
      ) : null}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {correcting ? 'Void and record again' : 'Record expense'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
            onCancel?.();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function CategoriesTab() {
  const writes = useWritesAllowed();
  const categories = useCategories();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useExpenseCommand(() => {
    setName('');
  });
  const update = useExpenseCommand();
  return (
    <section className="card stack" aria-labelledby="categories-head">
      <h2 id="categories-head">Categories</h2>
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length < 2 || !writes) return;
          setError(null);
          create.mutate(
            { path: '/expense-categories', body: { name: name.trim() } },
            {
              onError: (err) => {
                setError(messageOf(err));
              },
            },
          );
        }}
      >
        <Field
          label="New category"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={name.trim().length < 2 || !writes || create.isPending}
        >
          Add category
        </button>
      </form>
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      {categories.isPending ? <Loading label="Loading categories" /> : null}
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Expenses</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(categories.data?.items ?? []).map((c) => (
            <tr key={c.id} className={c.isActive ? undefined : 'muted'}>
              <td>
                {c.name}
                {c.isActive ? '' : ' (not offered)'}
              </td>
              <td>{c.used}</td>
              <td>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!writes || update.isPending}
                  onClick={() => {
                    update.mutate({
                      path: `/expense-categories/${c.id}`,
                      method: 'PATCH',
                      body: { isActive: !c.isActive },
                    });
                  }}
                >
                  {c.isActive ? 'Stop offering' : 'Offer again'}
                  <span className="visually-hidden"> {c.name}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
