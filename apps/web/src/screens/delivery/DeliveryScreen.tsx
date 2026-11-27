/**
 * The delivery board (UI_UX.md Counter prototype "Deliveries"; ORDER_STATE_MACHINE.md §7).
 * Riders can't update the system on the road (D-41): the cashier enters the order, sends
 * it with a rider once everything is picked up, and records what happened when the rider
 * is back. A manager decides what to do with a failed delivery. Phone numbers are masked
 * on the board (AT-123).
 */
import { useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import { useCommand } from '../counter/useCommand.ts';
import { useSignedIn } from '../Shell.tsx';
import { Loading } from '../../components/Loading.tsx';

interface DeliveryItem {
  id: string;
  sessionId: string;
  sessionNo: string;
  status:
    | 'pending_dispatch'
    | 'out_for_delivery'
    | 'delivered'
    | 'failed'
    | 'cancelled'
    | 'converted_to_pickup';
  channel: string;
  paymentMode: 'prepaid' | 'cod_cash' | 'card_on_delivery';
  customerName: string | null;
  phone: string | null;
  address: string | null;
  landmark: string | null;
  riderId: string | null;
  rider: string | null;
  attempt: number;
  failureReason: string | null;
  refundDue: string;
  refunded: string;
  invoiceId: string;
  invoiceStatus: string;
  total: string | null;
  due: string | null;
  items: number;
  unpicked: number;
}

interface Board {
  items: DeliveryItem[];
  outstanding: { riderId: string; rider: string; amount: string; deliveries: number }[];
}

interface Rider {
  id: string;
  name: string;
  phone: string | null;
  isActive: boolean;
}

const PAYMENT: Record<DeliveryItem['paymentMode'], string> = {
  prepaid: 'Prepaid',
  cod_cash: 'Cash on delivery',
  card_on_delivery: 'Card on delivery',
};

function useBoard() {
  return useQuery({
    queryKey: ['deliveries'],
    queryFn: ({ signal }) => api<Board>('/deliveries', { signal }),
    meta: { topics: ['deliveries'] },
  });
}

function useRiders(enabled: boolean) {
  return useQuery({
    queryKey: ['riders'],
    queryFn: ({ signal }) => api<{ items: Rider[] }>('/riders', { signal }),
    meta: { topics: ['deliveries'] },
    enabled,
  });
}

/** Counter commands, plus the board and riders refreshed after each. */
function useDeliveryCommand<T>(onDone?: (r: T) => void) {
  return useCommand<T>(onDone, [['deliveries'], ['riders']]);
}

export function DeliveryScreen() {
  const permissions = permissionSet(useSignedIn());
  const board = useBoard();
  const riders = useRiders(permissions.has('delivery.dispatch'));
  const items = board.data?.items ?? [];
  const column = (statuses: DeliveryItem['status'][]) =>
    items.filter((d) => statuses.includes(d.status));
  const riderList = (riders.data?.items ?? []).filter((r) => r.isActive);
  return (
    <>
      <h1>Deliveries</h1>
      <p className="muted">
        Riders can’t update the system on the road. Record what happened when they come back.
      </p>
      {board.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(board.error)}
        </div>
      ) : null}
      {permissions.has('delivery.create') ? <NewDelivery /> : null}
      {board.isPending ? <Loading label="Loading deliveries" /> : null}
      {(board.data?.outstanding ?? []).length > 0 ? (
        <section className="card stack" aria-labelledby="with-riders">
          <h2 id="with-riders">Still with riders</h2>
          <ul className="stack stack-tight">
            {board.data?.outstanding.map((o) => (
              <li key={o.riderId}>
                {o.rider}: {rupees(o.amount)} to hand over ({o.deliveries} deliver
                {o.deliveries === 1 ? 'y' : 'ies'})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="delivery-board">
        <Column title="Waiting to go" items={column(['pending_dispatch'])} riders={riderList} />
        <Column title="Out for delivery" items={column(['out_for_delivery'])} riders={riderList} />
        <Column title="Failed" items={column(['failed'])} riders={riderList} />
      </div>
      <Column
        title="Done today"
        items={column(['delivered', 'cancelled', 'converted_to_pickup'])}
        riders={riderList}
      />
      {permissions.has('users.manage') ? <Riders /> : null}
    </>
  );
}

function Column({
  title,
  items,
  riders,
}: {
  title: string;
  items: DeliveryItem[];
  riders: Rider[];
}) {
  const id = `col-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section className="stack" aria-labelledby={id}>
      <h2 id={id}>
        {title} ({items.length})
      </h2>
      {items.length === 0 ? <p className="muted">None.</p> : null}
      {items.map((d) => (
        <DeliveryCard key={d.id} d={d} riders={riders} />
      ))}
    </section>
  );
}

function DeliveryCard({ d, riders }: { d: DeliveryItem; riders: Rider[] }) {
  const permissions = permissionSet(useSignedIn());
  const who = d.customerName ?? 'No name given';
  return (
    <article className="card stack" aria-label={`Delivery ${d.sessionNo}`}>
      <div className="section-head">
        <h3>
          {d.sessionNo} · {who}
        </h3>
        <span className={`chip ${d.paymentMode === 'prepaid' ? 'chip-ok' : 'chip-info'}`}>
          {PAYMENT[d.paymentMode]}
        </span>
      </div>
      <p className="muted">
        {[d.phone, d.address, d.landmark].filter(Boolean).join(' · ') || 'No address given'}
      </p>
      <p>
        {d.items} item{d.items === 1 ? '' : 's'}
        {d.total ? ` · ${rupees(d.total)}` : ''}
        {d.due && d.due !== '0.00' ? ` · ${rupees(d.due)} to collect` : ''}
        {d.rider
          ? ` · rider ${d.rider}${d.attempt > 1 ? ` (attempt ${String(d.attempt)})` : ''}`
          : ''}
      </p>
      {d.status === 'failed' ? (
        <p className="banner banner-warning">Failed: {d.failureReason}</p>
      ) : null}
      {d.status === 'cancelled' && d.refundDue !== '0.00' ? (
        Number(d.refunded) >= Number(d.refundDue) ? (
          <p className="muted">Refunded {rupees(d.refunded)}.</p>
        ) : (
          <p className="banner banner-warning">
            Refund due {rupees(d.refundDue)}
            {Number(d.refunded) > 0 ? ` (${rupees(d.refunded)} refunded so far)` : ''} ·{' '}
            <Link to={`/counter/refunds?invoice=${d.invoiceId}&full=1`}>Refund it</Link>
          </p>
        )
      ) : null}
      <div className="row">
        <Link to={`/sessions/${d.sessionId}`}>Items</Link>
        {['pending_dispatch', 'converted_to_pickup'].includes(d.status) &&
        d.invoiceStatus !== 'settled' ? (
          <Link to={`/counter?session=${d.sessionId}`}>Bill and payment</Link>
        ) : null}
      </div>
      {d.status === 'pending_dispatch' && permissions.has('delivery.dispatch') ? (
        <Dispatch d={d} riders={riders} />
      ) : null}
      {d.status === 'out_for_delivery' && permissions.has('delivery.record_return') ? (
        <Return d={d} />
      ) : null}
      {d.status === 'failed' && permissions.has('delivery.resolve_failed') ? (
        <Resolve d={d} riders={riders} />
      ) : null}
    </article>
  );
}

function RiderSelect({
  value,
  onChange,
  riders,
}: {
  value: string;
  onChange: (v: string) => void;
  riders: Rider[];
}) {
  return (
    <SelectField
      label="Rider"
      value={value}
      options={[
        { value: '', label: riders.length ? 'Choose a rider' : 'No riders yet' },
        ...riders.map((r) => ({ value: r.id, label: r.name })),
      ]}
      onChange={onChange}
    />
  );
}

function Dispatch({ d, riders }: { d: DeliveryItem; riders: Rider[] }) {
  const writes = useWritesAllowed();
  const [rider, setRider] = useState('');
  const send = useDeliveryCommand();
  const blocker =
    d.items === 0
      ? 'Add the items first.'
      : d.unpicked > 0
        ? `${String(d.unpicked)} item${d.unpicked === 1 ? '' : 's'} not picked up yet.`
        : d.paymentMode === 'prepaid' && d.invoiceStatus !== 'settled'
          ? 'Prepaid: take the payment first.'
          : null;
  return (
    <div className="stack">
      <div className="row">
        <RiderSelect value={rider} onChange={setRider} riders={riders} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!writes || !rider || blocker !== null || send.isPending}
          onClick={() => {
            send.mutate({ path: `/deliveries/${d.id}/dispatch`, body: { riderId: rider } });
          }}
        >
          Dispatch <span className="visually-hidden">{d.sessionNo}</span>
        </button>
      </div>
      {blocker ? <p className="muted">{blocker}</p> : null}
      {send.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(send.error)}
        </div>
      ) : null}
    </div>
  );
}

function Return({ d }: { d: DeliveryItem }) {
  const writes = useWritesAllowed();
  const [mode, setMode] = useState<'none' | 'delivered' | 'failed'>('none');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const back = useDeliveryCommand(() => {
    setMode('none');
  });
  const collect = d.due && d.due !== '0.00' ? d.due : null;
  const card = d.paymentMode === 'card_on_delivery';
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (mode === 'delivered') {
      back.mutate({
        path: `/deliveries/${d.id}/return`,
        body: {
          outcome: 'delivered',
          ...(card && reference.trim() ? { reference: reference.trim() } : {}),
        },
      });
    } else if (reason.trim().length >= 3) {
      back.mutate({
        path: `/deliveries/${d.id}/return`,
        body: { outcome: 'failed', reason: reason.trim() },
      });
    }
  };
  if (mode === 'none') {
    return (
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!writes}
          onClick={() => {
            setMode('delivered');
          }}
        >
          {d.rider} returned: delivered <span className="visually-hidden">{d.sessionNo}</span>
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes}
          onClick={() => {
            setMode('failed');
          }}
        >
          Delivery failed… <span className="visually-hidden">{d.sessionNo}</span>
        </button>
      </div>
    );
  }
  return (
    <form className="stack" noValidate onSubmit={submit}>
      {mode === 'delivered' ? (
        collect ? (
          card ? (
            <Field
              label="Approval code from the card slip (optional)"
              maxLength={32}
              autoComplete="off"
              value={reference}
              hint="Never the card number."
              onChange={(e) => {
                setReference(e.target.value);
              }}
            />
          ) : (
            <p>
              {d.rider} hands over <strong>{rupees(collect)}</strong> in cash: it goes into this
              shift.
            </p>
          )
        ) : (
          <p>Already paid.</p>
        )
      ) : (
        <Field
          label="What happened"
          maxLength={200}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      )}
      {back.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(back.error)}
        </div>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className={mode === 'delivered' ? 'btn btn-primary' : 'btn btn-danger'}
          disabled={!writes || back.isPending || (mode === 'failed' && reason.trim().length < 3)}
        >
          {mode === 'delivered'
            ? collect && !card
              ? `Record ${rupees(collect)} received`
              : 'Record delivered'
            : 'Record failed'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setMode('none');
          }}
        >
          Back
        </button>
      </div>
    </form>
  );
}

function Resolve({ d, riders }: { d: DeliveryItem; riders: Rider[] }) {
  const writes = useWritesAllowed();
  const [rider, setRider] = useState(d.riderId ?? '');
  const [reason, setReason] = useState('');
  const resolve = useDeliveryCommand();
  const act = (body: object) => {
    resolve.mutate({ path: `/deliveries/${d.id}/resolve`, body });
  };
  return (
    <div className="stack">
      <div className="row">
        <RiderSelect value={rider} onChange={setRider} riders={riders} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!writes || !rider || resolve.isPending}
          onClick={() => {
            act({ action: 'reattempt', riderId: rider });
          }}
        >
          Try again <span className="visually-hidden">{d.sessionNo}</span>
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!writes || resolve.isPending}
          onClick={() => {
            act({ action: 'convert_to_pickup' });
          }}
        >
          Customer will collect <span className="visually-hidden">{d.sessionNo}</span>
        </button>
      </div>
      <div className="row">
        <Field
          label="Reason to cancel"
          maxLength={200}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn btn-danger"
          disabled={!writes || reason.trim().length < 3 || resolve.isPending}
          onClick={() => {
            act({ action: 'cancel', reason: reason.trim() });
          }}
        >
          Cancel delivery <span className="visually-hidden">{d.sessionNo}</span>
        </button>
      </div>
      <p className="muted">
        Cancelling writes the food off as waste. Prepaid money is marked as a refund due.
      </p>
      {resolve.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(resolve.error)}
        </div>
      ) : null}
    </div>
  );
}

/** The customer behind a mobile number, from the old POS (owner's request, Nov 2026). */
async function knownCustomer(mobile: string) {
  if (mobile.replace(/\D/g, '').length < 10) return null;
  try {
    const res = await api<{ customer: { name: string | null; location: string | null } | null }>(
      `/customers/lookup?mobile=${encodeURIComponent(mobile)}`,
    );
    return res.customer;
  } catch {
    return null; // a look-up that fails only means typing it in
  }
}

function NewDelivery() {
  const writes = useWritesAllowed();
  const [known, setKnown] = useState<string | null>(null);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    channel: 'phone',
    paymentMode: 'cod_cash',
    customerName: '',
    customerPhone: '',
    address: '',
    landmark: '',
    notes: '',
  });
  const create = useDeliveryCommand<{ sessionId: string }>((r) => {
    void navigate(`/sessions/${r.sessionId}`);
  });
  const set = (key: keyof typeof form) => (value: string) => {
    setForm({ ...form, [key]: value });
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
          New delivery
        </button>
      </div>
    );
  }
  const optional: Record<string, string> = {};
  for (const k of ['customerName', 'customerPhone', 'address', 'landmark', 'notes'] as const) {
    const v = form[k].trim();
    if (v) optional[k] = v;
  }
  return (
    <form
      className="card stack"
      noValidate
      aria-labelledby="new-delivery"
      onSubmit={(e) => {
        e.preventDefault();
        if (writes)
          create.mutate({
            path: '/sessions/delivery',
            body: { channel: form.channel, paymentMode: form.paymentMode, ...optional },
          });
      }}
    >
      <h2 id="new-delivery">New delivery</h2>
      <p className="muted">Every detail is optional. Next you add the items.</p>
      <div className="row">
        <SelectField
          label="Order came by"
          value={form.channel}
          options={[
            { value: 'phone', label: 'Phone call' },
            { value: 'whatsapp', label: 'WhatsApp' },
            { value: 'walk_in', label: 'In person' },
          ]}
          onChange={set('channel')}
        />
        <SelectField
          label="Payment"
          value={form.paymentMode}
          options={[
            { value: 'cod_cash', label: 'Cash on delivery' },
            { value: 'card_on_delivery', label: 'Card on delivery' },
            { value: 'prepaid', label: 'Prepaid (before it leaves)' },
          ]}
          onChange={set('paymentMode')}
        />
      </div>
      <div className="row">
        <Field
          label="Customer name"
          maxLength={60}
          value={form.customerName}
          onChange={(e) => {
            set('customerName')(e.target.value);
          }}
        />
        <Field
          label="Customer phone"
          inputMode="tel"
          maxLength={20}
          value={form.customerPhone}
          onChange={(e) => {
            set('customerPhone')(e.target.value);
            setKnown(null);
          }}
          onBlur={() => {
            void knownCustomer(form.customerPhone).then((c) => {
              if (!c) return;
              setForm((f) => ({
                ...f,
                customerName: f.customerName || (c.name ?? ''),
                address: f.address || (c.location ?? ''),
              }));
              setKnown(c.name ?? 'this customer');
            });
          }}
        />
      </div>
      {known ? (
        <p role="status" className="muted">
          Known customer: {known}. Their name and address are filled in where empty; change them if
          they differ today.
        </p>
      ) : null}
      <Field
        label="Address"
        maxLength={300}
        value={form.address}
        onChange={(e) => {
          set('address')(e.target.value);
        }}
      />
      <div className="row">
        <Field
          label="Landmark"
          maxLength={120}
          value={form.landmark}
          onChange={(e) => {
            set('landmark')(e.target.value);
          }}
        />
        <Field
          label="Note for the rider"
          maxLength={200}
          value={form.notes}
          onChange={(e) => {
            set('notes')(e.target.value);
          }}
        />
      </div>
      {create.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(create.error)}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!writes || create.isPending}>
          Create and add items
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

function Riders() {
  const writes = useWritesAllowed();
  const riders = useRiders(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useDeliveryCommand(() => {
    setName('');
    setPhone('');
  });
  return (
    <section className="stack" aria-labelledby="riders">
      <h2 id="riders">Riders</h2>
      <p className="muted">Riders don’t log in; the cashier chooses one at dispatch.</p>
      <ul className="stack stack-tight">
        {(riders.data?.items ?? []).map((r) => (
          <li key={r.id}>
            {r.name}
            {r.phone ? ` · ${r.phone}` : ''}
          </li>
        ))}
      </ul>
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (writes && name.trim())
            add.mutate({
              path: '/riders',
              body: { name: name.trim(), ...(phone.trim() ? { phone: phone.trim() } : {}) },
            });
        }}
      >
        <Field
          label="Rider name"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Field
          label="Rider phone (optional)"
          maxLength={20}
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!writes || !name.trim() || add.isPending}
        >
          Add rider
        </button>
      </form>
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(add.error)}
        </div>
      ) : null}
    </section>
  );
}
