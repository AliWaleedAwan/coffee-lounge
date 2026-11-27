/**
 * Asset register (D-31 "Resources Management"; Phase 5 step 5.4): the shop's equipment and
 * furniture, where each thing is, its condition and who looks after it. Every change is
 * kept in the asset's history; maintenance is recorded (optionally with the expense that
 * paid for it); removal is a status, never a delete. `?asset=<id>` opens one.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, ApiError, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useSignedIn } from '../Shell.tsx';

type Condition = 'new' | 'good' | 'fair' | 'poor';
type Status = 'in_use' | 'in_repair' | 'retired' | 'disposed';

interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  quantity: number;
  purchaseDate: string | null;
  purchasePrice: string | null;
  supplierId: string | null;
  supplier: string | null;
  location: string | null;
  condition: Condition | null;
  responsibleUserId: string | null;
  responsible: string | null;
  status: Status;
  notes: string | null;
  version: number;
  lastMaintenance: string | null;
  nextDue: string | null;
}
interface HistoryEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  reason: string | null;
  by: string;
  at: string;
}
interface Maintenance {
  id: string;
  performedOn: string;
  vendor: string | null;
  cost: string | null;
  description: string;
  nextDue: string | null;
  expenseNo: string | null;
  by: string;
}
interface Choices {
  people: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
}

const STATUS: Record<Status, string> = {
  in_use: 'In use',
  in_repair: 'In repair',
  retired: 'Retired',
  disposed: 'Removed',
};
const CONDITION: Record<Condition, string> = {
  new: 'New',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};
const REMOVALS = { sold: 'Sold', broken: 'Broken', lost: 'Lost' };
// Earlier removals keep their word in the history.
const DISPOSALS = {
  ...REMOVALS,
  scrapped: 'Scrapped',
  donated: 'Donated',
  returned: 'Returned to supplier',
};
const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const at = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function describeEvent(e: HistoryEvent): string {
  const d = e.data;
  const text = (v: unknown): string =>
    typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : '—';
  switch (e.type) {
    case 'acquired':
      return `Registered as ${text(d['assetTag'])}`;
    case 'moved':
      return `Moved from ${text(d['from'])} to ${text(d['to'])}`;
    case 'condition_changed':
      return `Condition ${text(d['from'])} → ${text(d['to'])}`;
    case 'value_corrected':
      return `Value corrected ${text(d['from'])} → ${text(d['to'])}`;
    case 'status_changed':
      return `${STATUS[d['from'] as Status]} → ${STATUS[d['to'] as Status]}`;
    case 'maintenance':
      return `Maintenance: ${text(d['description'])}${typeof d['cost'] === 'string' ? ` · ${rupees(d['cost'])}` : ''}${typeof d['expenseNo'] === 'string' ? ` · ${d['expenseNo']}` : ''}`;
    case 'disposed':
      return `Removed: ${DISPOSALS[d['how'] as keyof typeof DISPOSALS]}`;
    case 'details_changed': {
      const before = (d['before'] ?? {}) as Record<string, unknown>;
      const after = (d['after'] ?? {}) as Record<string, unknown>;
      return `Changed ${Object.keys(after)
        .map((k) => `${k.replaceAll('_', ' ')} ${text(before[k])} → ${text(after[k])}`)
        .join(', ')}`;
    }
    default:
      return e.type;
  }
}

function useAssetCommand<T>(onDone?: (result: T) => void) {
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
    onSettled: () => client.invalidateQueries({ queryKey: ['assets'] }),
  });
}

export function AssetsScreen() {
  const canManage = permissionSet(useSignedIn()).has('assets.manage');
  const [params, setParams] = useSearchParams();
  const opened = params.get('asset');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [category, setCategory] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const query = new URLSearchParams({
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
  }).toString();
  const list = useQuery({
    queryKey: ['assets', 'list', query],
    queryFn: ({ signal }) =>
      api<{ items: Asset[]; categories: string[]; locations: string[] }>(`/assets?${query}`, {
        signal,
      }),
    meta: { topics: ['assets'] },
    placeholderData: (previous) => previous,
  });
  const choices = useQuery({
    queryKey: ['assets', 'choices'],
    queryFn: ({ signal }) => api<Choices>('/assets/choices', { signal }),
    enabled: canManage,
  });
  const names = { categories: list.data?.categories ?? [], locations: list.data?.locations ?? [] };
  return (
    <>
      <h1>Assets</h1>
      <p className="muted">
        Everything the shop owns: furniture, cutlery, devices and more. Removing something keeps its
        record, with the reason.
      </p>
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {opened ? (
        <AssetDetail
          key={opened}
          id={opened}
          canManage={canManage}
          choices={choices.data}
          names={names}
          onClose={() => {
            setParams({});
          }}
        />
      ) : canManage ? (
        <RegisterAsset
          choices={choices.data}
          names={names}
          onDone={(tag, id) => {
            setDone(`Registered ${tag}.`);
            setParams({ asset: id });
          }}
        />
      ) : null}
      <section className="card stack" aria-labelledby="assets-head">
        <h2 id="assets-head">All assets</h2>
        <div className="row">
          <Field
            label="Find by tag, name or place"
            autoComplete="off"
            maxLength={60}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
            }}
          />
          <SelectField
            label="Category"
            value={category}
            options={[
              { value: '', label: 'All categories' },
              ...names.categories.map((c) => ({ value: c, label: c })),
            ]}
            onChange={setCategory}
          />
          <SelectField
            label="Status"
            value={status}
            options={[
              { value: 'active', label: 'In the shop' },
              { value: 'in_use', label: 'In use' },
              { value: 'in_repair', label: 'In repair' },
              { value: 'retired', label: 'Retired' },
              { value: 'disposed', label: 'Removed' },
              { value: '', label: 'All' },
            ]}
            onChange={setStatus}
          />
        </div>
        {canManage ? <Categories names={names.categories} /> : null}
        {list.isPending ? <Loading label="Loading assets" /> : null}
        {list.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(list.error)}
          </div>
        ) : null}
        {list.data && list.data.items.length === 0 ? <p className="muted">No assets.</p> : null}
        {list.data && list.data.items.length > 0 ? (
          <table className="data" aria-label="Assets">
            <thead>
              <tr>
                <th scope="col">Tag</th>
                <th scope="col">Name</th>
                <th scope="col">Category</th>
                <th scope="col">Where</th>
                <th scope="col">Condition</th>
                <th scope="col">Status</th>
                <th scope="col">Next service</th>
                <th scope="col">
                  <span className="visually-hidden">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>{a.assetTag}</td>
                  <td>
                    {a.name}
                    {a.quantity > 1 ? ` ×${String(a.quantity)}` : ''}
                  </td>
                  <td>{a.category}</td>
                  <td>{a.location ?? ''}</td>
                  <td>{a.condition ? CONDITION[a.condition] : ''}</td>
                  <td>{STATUS[a.status]}</td>
                  <td>{a.nextDue ?? ''}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        setDone(null);
                        setParams({ asset: a.id });
                      }}
                    >
                      Open<span className="visually-hidden"> {a.assetTag}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}

interface FormState {
  assetTag: string;
  name: string;
  category: string;
  quantity: string;
  purchaseDate: string;
  purchasePrice: string;
  supplierId: string;
  location: string;
  condition: string;
  responsibleUserId: string;
  notes: string;
  status: string;
}
const blank: FormState = {
  assetTag: '',
  name: '',
  category: '',
  quantity: '1',
  purchaseDate: '',
  purchasePrice: '',
  supplierId: '',
  location: '',
  condition: '',
  responsibleUserId: '',
  notes: '',
  status: 'in_use',
};
const formOf = (a: Asset): FormState => ({
  assetTag: a.assetTag,
  name: a.name,
  category: a.category,
  quantity: String(a.quantity),
  purchaseDate: a.purchaseDate ?? '',
  purchasePrice: a.purchasePrice ?? '',
  supplierId: a.supplierId ?? '',
  location: a.location ?? '',
  condition: a.condition ?? '',
  responsibleUserId: a.responsibleUserId ?? '',
  notes: a.notes ?? '',
  status: a.status,
});
const valid = (f: FormState) =>
  f.name.trim() !== '' &&
  f.category.trim() !== '' &&
  /^\d{1,4}$/.test(f.quantity) &&
  Number(f.quantity) >= 1 &&
  (f.purchasePrice === '' || AMOUNT.test(f.purchasePrice));
const bodyOf = (f: FormState) => ({
  name: f.name.trim(),
  category: f.category.trim(),
  quantity: Number(f.quantity),
  purchaseDate: f.purchaseDate || null,
  purchasePrice: f.purchasePrice || null,
  supplierId: f.supplierId || null,
  location: f.location.trim() || null,
  condition: (f.condition || null) as Condition | null,
  responsibleUserId: f.responsibleUserId || null,
  notes: f.notes.trim() || null,
});

function AssetFields({
  value,
  onChange,
  choices,
  names,
  editing,
}: {
  value: FormState;
  onChange: (f: FormState) => void;
  choices: Choices | undefined;
  names: { categories: string[]; locations: string[] };
  editing: boolean;
}) {
  const ids = useId();
  const set = (k: keyof FormState) => (v: string) => {
    onChange({ ...value, [k]: v });
  };
  return (
    <>
      <div className="row">
        <Field
          label={editing ? 'Tag' : 'Tag (empty: next AST number)'}
          maxLength={30}
          autoComplete="off"
          value={value.assetTag}
          onChange={(e) => {
            set('assetTag')(e.target.value);
          }}
        />
        <Field
          label="Name"
          maxLength={80}
          value={value.name}
          onChange={(e) => {
            set('name')(e.target.value);
          }}
        />
        <SelectField
          label="Category"
          value={value.category}
          options={[
            { value: '', label: 'Choose…' },
            ...[
              ...names.categories,
              ...(value.category && !names.categories.includes(value.category)
                ? [value.category]
                : []),
            ].map((c) => ({ value: c, label: c })),
          ]}
          onChange={set('category')}
        />
        <Field
          label="Quantity"
          inputMode="numeric"
          value={value.quantity}
          onChange={(e) => {
            set('quantity')(e.target.value.trim());
          }}
        />
      </div>
      <div className="row">
        <Field
          label="Where"
          maxLength={60}
          list={`${ids}-loc`}
          value={value.location}
          onChange={(e) => {
            set('location')(e.target.value);
          }}
        />
        <datalist id={`${ids}-loc`}>
          {names.locations.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <SelectField
          label="Condition"
          value={value.condition}
          options={[
            { value: '', label: 'Not noted' },
            ...Object.entries(CONDITION).map(([v, l]) => ({ value: v, label: l })),
          ]}
          onChange={set('condition')}
        />
        <SelectField
          label="Looked after by"
          value={value.responsibleUserId}
          options={[
            { value: '', label: 'Nobody named' },
            ...(choices?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={set('responsibleUserId')}
        />
        {editing ? (
          <SelectField
            label="Status"
            value={value.status}
            options={(['in_use', 'in_repair', 'retired'] as const).map((s) => ({
              value: s,
              label: STATUS[s],
            }))}
            onChange={set('status')}
          />
        ) : null}
      </div>
      <div className="row">
        <Field
          label="Bought on"
          type="date"
          value={value.purchaseDate}
          onChange={(e) => {
            set('purchaseDate')(e.target.value);
          }}
        />
        <Field
          label="Price (Rs)"
          inputMode="decimal"
          value={value.purchasePrice}
          error={
            value.purchasePrice && !AMOUNT.test(value.purchasePrice)
              ? 'An amount such as 185000'
              : null
          }
          onChange={(e) => {
            set('purchasePrice')(e.target.value.trim());
          }}
        />
        <SelectField
          label="Supplier"
          value={value.supplierId}
          options={[
            { value: '', label: 'Not noted' },
            ...(choices?.suppliers ?? []).map((s) => ({ value: s.id, label: s.name })),
          ]}
          onChange={set('supplierId')}
        />
      </div>
      <Field
        label="Notes"
        maxLength={500}
        value={value.notes}
        onChange={(e) => {
          set('notes')(e.target.value);
        }}
      />
    </>
  );
}

function RegisterAsset({
  choices,
  names,
  onDone,
}: {
  choices: Choices | undefined;
  names: { categories: string[]; locations: string[] };
  onDone: (tag: string, id: string) => void;
}) {
  const writes = useWritesAllowed();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const register = useAssetCommand<{ id: string; assetTag: string }>((r) => {
    setOpen(false);
    setForm(blank);
    onDone(r.assetTag, r.id);
  });
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
          Register an asset
        </button>
      </div>
    );
  }
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    if (!valid(form) || !writes) return;
    register.mutate({
      path: '/assets',
      body: {
        ...(form.assetTag.trim() ? { assetTag: form.assetTag.trim() } : {}),
        ...bodyOf(form),
      },
    });
  };
  return (
    <form className="card stack" noValidate onSubmit={submit} aria-label="Register an asset">
      <h2>Register an asset</h2>
      <AssetFields
        value={form}
        onChange={setForm}
        choices={choices}
        names={names}
        editing={false}
      />
      {register.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(register.error)}
        </div>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!valid(form) || !writes || register.isPending}
        >
          Register
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

type Panel = 'edit' | 'maintenance' | 'dispose' | null;

function AssetDetail({
  id,
  canManage,
  choices,
  names,
  onClose,
}: {
  id: string;
  canManage: boolean;
  choices: Choices | undefined;
  names: { categories: string[]; locations: string[] };
  onClose: () => void;
}) {
  const writes = useWritesAllowed();
  const detail = useQuery({
    queryKey: ['assets', 'one', id],
    queryFn: ({ signal }) =>
      api<{ asset: Asset; history: HistoryEvent[]; maintenance: Maintenance[] }>(`/assets/${id}`, {
        signal,
      }),
    meta: { topics: ['assets'] },
  });
  const [panel, setPanel] = useState<Panel>(null);
  if (detail.isPending) return <Loading label="Loading the asset" />;
  if (detail.isError) {
    return (
      <div role="alert" className="banner banner-danger">
        {messageOf(detail.error)}
      </div>
    );
  }
  const { asset: a, history, maintenance } = detail.data;
  const active = a.status !== 'disposed';
  return (
    <section className="card stack" aria-labelledby="asset-head">
      <h2 id="asset-head">
        {a.assetTag} · {a.name}
      </h2>
      <p>
        {a.category}
        {a.quantity > 1 ? ` · ${String(a.quantity)} pieces` : ''} · {STATUS[a.status]}
        {a.location ? ` · ${a.location}` : ''}
        {a.condition ? ` · ${CONDITION[a.condition]} condition` : ''}
        {a.responsible ? ` · looked after by ${a.responsible}` : ''}
      </p>
      <p className="muted">
        {a.purchaseDate ? `Bought ${a.purchaseDate}` : 'Purchase date not noted'}
        {a.purchasePrice ? ` for ${rupees(a.purchasePrice)}` : ''}
        {a.supplier ? ` from ${a.supplier}` : ''}
        {a.nextDue ? ` · next service ${a.nextDue}` : ''}
      </p>
      {a.notes ? <p>{a.notes}</p> : null}
      {canManage && active ? (
        <div className="row">
          {(['edit', 'maintenance', 'dispose'] as const).map((p) => (
            <button
              key={p}
              type="button"
              className={p === 'dispose' ? 'btn btn-ghost' : 'btn btn-secondary'}
              disabled={!writes}
              aria-pressed={panel === p}
              onClick={() => {
                setPanel(panel === p ? null : p);
              }}
            >
              {p === 'edit'
                ? 'Change details'
                : p === 'maintenance'
                  ? 'Record maintenance'
                  : 'Remove it'}
            </button>
          ))}
        </div>
      ) : null}
      {panel === 'edit' ? (
        <EditAsset
          key={a.version}
          asset={a}
          choices={choices}
          names={names}
          onDone={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'maintenance' ? (
        <RecordMaintenance
          asset={a}
          onDone={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {panel === 'dispose' ? (
        <Dispose
          asset={a}
          onDone={() => {
            setPanel(null);
          }}
        />
      ) : null}

      <h3>History</h3>
      <ol className="stack" aria-label="History">
        {history.map((e) => (
          <li key={e.id}>
            <strong>{describeEvent(e)}</strong>
            {e.reason ? ` · ${e.reason}` : ''}
            <span className="muted">
              {' '}
              · {e.by}, {at.format(new Date(e.at))}
            </span>
          </li>
        ))}
      </ol>
      {maintenance.length > 0 ? (
        <>
          <h3>Maintenance</h3>
          <table className="data" aria-label="Maintenance">
            <thead>
              <tr>
                <th scope="col">Done on</th>
                <th scope="col">What</th>
                <th scope="col">By</th>
                <th scope="col">Cost</th>
                <th scope="col">Next</th>
              </tr>
            </thead>
            <tbody>
              {maintenance.map((m) => (
                <tr key={m.id}>
                  <td>{m.performedOn}</td>
                  <td>{m.description}</td>
                  <td>{m.vendor ?? ''}</td>
                  <td>
                    {m.cost ? rupees(m.cost) : ''}
                    {m.expenseNo ? ` · ${m.expenseNo}` : ''}
                  </td>
                  <td>{m.nextDue ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <div>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  );
}

function EditAsset({
  asset,
  choices,
  names,
  onDone,
}: {
  asset: Asset;
  choices: Choices | undefined;
  names: { categories: string[]; locations: string[] };
  onDone: () => void;
}) {
  const writes = useWritesAllowed();
  const [form, setForm] = useState(() => formOf(asset));
  const [reason, setReason] = useState('');
  const save = useAssetCommand<{ events: string[] }>(onDone);
  const priceChanged = (form.purchasePrice || null) !== asset.purchasePrice;
  const ready =
    valid(form) && writes && !save.isPending && (!priceChanged || reason.trim().length >= 3);
  return (
    <form
      className="stack"
      noValidate
      aria-label="Change details"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        save.mutate({
          path: `/assets/${asset.id}/changes`,
          body: {
            version: asset.version,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
            changes: { assetTag: form.assetTag.trim(), ...bodyOf(form), status: form.status },
          },
        });
      }}
    >
      <AssetFields value={form} onChange={setForm} choices={choices} names={names} editing />
      <Field
        label={priceChanged ? 'Why is the value corrected' : 'Reason (optional)'}
        maxLength={300}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          Save changes
        </button>
      </div>
    </form>
  );
}

function todayLocal(): string {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function RecordMaintenance({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const writes = useWritesAllowed();
  const [performedOn, setPerformedOn] = useState(todayLocal);
  const [description, setDescription] = useState('');
  const [vendor, setVendor] = useState('');
  const [cost, setCost] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [expenseNo, setExpenseNo] = useState('');
  const record = useAssetCommand<{ id: string }>(onDone);
  const ready =
    writes &&
    !record.isPending &&
    description.trim().length >= 3 &&
    performedOn !== '' &&
    (cost === '' || AMOUNT.test(cost));
  return (
    <form
      className="stack"
      noValidate
      aria-label="Record maintenance"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        record.mutate({
          path: `/assets/${asset.id}/maintenance`,
          body: {
            performedOn,
            description: description.trim(),
            ...(vendor.trim() ? { vendor: vendor.trim() } : {}),
            ...(cost ? { cost } : {}),
            ...(nextDue ? { nextDue } : {}),
            ...(expenseNo.trim() ? { expenseNo: expenseNo.trim() } : {}),
          },
        });
      }}
    >
      <div className="row">
        <Field
          label="Done on"
          type="date"
          value={performedOn}
          onChange={(e) => {
            setPerformedOn(e.target.value);
          }}
        />
        <Field
          label="What was done"
          maxLength={300}
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
        <Field
          label="By (company or person)"
          maxLength={80}
          value={vendor}
          onChange={(e) => {
            setVendor(e.target.value);
          }}
        />
      </div>
      <div className="row">
        <Field
          label="Cost (Rs)"
          inputMode="decimal"
          value={cost}
          error={cost && !AMOUNT.test(cost) ? 'An amount such as 4500' : null}
          onChange={(e) => {
            setCost(e.target.value.trim());
          }}
        />
        <Field
          label="Paid by expense (EXP number, optional)"
          maxLength={20}
          autoComplete="off"
          value={expenseNo}
          onChange={(e) => {
            setExpenseNo(e.target.value);
          }}
        />
        <Field
          label="Next service"
          type="date"
          value={nextDue}
          onChange={(e) => {
            setNextDue(e.target.value);
          }}
        />
      </div>
      {record.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(record.error)}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          Record maintenance
        </button>
      </div>
    </form>
  );
}

function Categories({ names }: { names: string[] }) {
  const writes = useWritesAllowed();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [remove, setRemove] = useState('');
  const save = useMutation({
    mutationFn: (body: { add: string } | { remove: string }) =>
      api('/assets/categories', { method: 'POST', body }),
    onSuccess: () => {
      setName('');
      setRemove('');
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['assets'] }),
  });
  return (
    <details>
      <summary>Manage categories</summary>
      <div className="row">
        <Field
          label="New category"
          maxLength={40}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!writes || name.trim() === '' || save.isPending}
          onClick={() => {
            save.mutate({ add: name.trim() });
          }}
        >
          Add
        </button>
        <SelectField
          label="Remove a category"
          value={remove}
          options={[{ value: '', label: 'Choose…' }, ...names.map((c) => ({ value: c, label: c }))]}
          onChange={setRemove}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || remove === '' || save.isPending}
          onClick={() => {
            save.mutate({ remove });
          }}
        >
          Remove
        </button>
      </div>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
    </details>
  );
}

function Dispose({ asset, onDone }: { asset: Asset; onDone: () => void }) {
  const writes = useWritesAllowed();
  const [how, setHow] = useState<keyof typeof REMOVALS>('broken');
  const [note, setNote] = useState('');
  const dispose = useAssetCommand<{ id: string }>(onDone);
  const ready = writes && !dispose.isPending;
  return (
    <form
      className="stack"
      noValidate
      aria-label={`Remove ${asset.assetTag}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        dispose.mutate({
          path: `/assets/${asset.id}/dispose`,
          body: { how, reason: note.trim().length >= 3 ? note.trim() : REMOVALS[how] },
        });
      }}
    >
      <p className="muted">
        It stays on record with its history, marked as removed. Money from a sale is recorded in the
        ledger.
      </p>
      <div className="row">
        <SelectField
          label="Why is it going"
          value={how}
          options={Object.entries(REMOVALS).map(([value, label]) => ({ value, label }))}
          onChange={(v) => {
            setHow(v as keyof typeof REMOVALS);
          }}
        />
        <Field
          label="Note (optional)"
          maxLength={300}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
      </div>
      {dispose.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(dispose.error)}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-danger" disabled={!ready}>
          Remove {asset.assetTag}
        </button>
      </div>
    </form>
  );
}
