/**
 * Floor (UI_UX.md §6, API.md §5.3): every table with its state, waiter and session, and
 * what this user may do there: open a table, move a session, reset guest phones, close
 * an empty session, assign a waiter. Owners also manage tables and print QR codes.
 */
import { useState, type SubmitEvent } from 'react';
import { permissionSet } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useSignedIn } from '../Shell.tsx';
import {
  floorMessage,
  sinceText,
  STATE_LABEL,
  useFloor,
  useFloorWrite,
  useWaiters,
  type FloorTable,
} from './floor-api.ts';
import { TablesTab } from './TablesTab.tsx';

export interface FloorAbilities {
  open: boolean;
  transfer: boolean;
  reset: boolean;
  cancel: boolean;
  assign: boolean;
}

export function FloorScreen() {
  const permissions = permissionSet(useSignedIn());
  const manage = permissions.has('tables.manage');
  const [tab, setTab] = useState<'floor' | 'tables'>('floor');
  const can: FloorAbilities = {
    open: permissions.has('orders.create'),
    transfer: permissions.has('sessions.transfer'),
    reset: permissions.has('sessions.reset_guests'),
    cancel: permissions.has('orders.void'),
    assign: permissions.has('tables.assign'),
  };
  return (
    <>
      <h1>Floor</h1>
      {manage ? (
        <div className="tabs" role="tablist" aria-label="Floor sections">
          {(
            [
              ['floor', 'Tables now'],
              ['tables', 'Tables & QR codes'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`floor-tab-${id}`}
              aria-selected={tab === id}
              aria-controls="floor-panel"
              onClick={() => {
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id="floor-panel"
        className="stack"
        role={manage ? 'tabpanel' : undefined}
        aria-labelledby={manage ? `floor-tab-${tab}` : undefined}
      >
        {tab === 'floor' ? <FloorTab can={can} /> : <TablesTab />}
      </div>
    </>
  );
}

function FloorTab({ can }: { can: FloorAbilities }) {
  const floor = useFloor();
  const waiters = useWaiters(can.assign);
  const now = floor.dataUpdatedAt; // "seated for" as of the latest refresh
  const tables = floor.data?.tables ?? [];
  return (
    <>
      {floor.isError ? (
        <div role="alert" className="banner banner-danger">
          {floorMessage(floor.error)}
        </div>
      ) : null}
      {floor.isPending ? <p className="muted">Loading the floor…</p> : null}
      {floor.data && tables.length === 0 ? (
        <p className="muted">No tables yet. The owner adds them under Tables &amp; QR codes.</p>
      ) : null}
      <div className="grid-tiles floor-grid">
        {tables.map((t) => (
          <TableCard
            key={t.id}
            table={t}
            can={can}
            now={now}
            freeTables={tables.filter((x) => x.state === 'available' && x.id !== t.id)}
            waiters={waiters.data?.items ?? []}
          />
        ))}
      </div>
    </>
  );
}

type Panel = 'none' | 'open' | 'move' | 'close' | 'assign';

function TableCard({
  table,
  can,
  now,
  freeTables,
  waiters,
}: {
  table: FloorTable;
  can: FloorAbilities;
  now: number;
  freeTables: FloorTable[];
  waiters: { id: string; name: string }[];
}) {
  const writes = useWritesAllowed();
  const [panel, setPanel] = useState<Panel>('none');
  const [guests, setGuests] = useState('');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [waiter, setWaiter] = useState(table.waiter?.id ?? '');
  const write = useFloorWrite(() => {
    setPanel('none');
    setReason('');
  });
  const state = STATE_LABEL[table.state];
  const session = table.session;
  const headingId = `table-${table.id}`;
  const toggle = (p: Panel) => {
    setPanel(panel === p ? 'none' : p);
  };

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!writes || write.isPending) return;
    if (panel === 'open') {
      write.mutate({
        path: `/tables/${table.id}/sessions`,
        body: /^\d{1,2}$/.test(guests) && Number(guests) > 0 ? { guestCount: Number(guests) } : {},
        idempotent: true,
      });
    } else if (panel === 'move' && session && target) {
      write.mutate({
        path: `/sessions/${session.id}/transfer`,
        body: { toTableId: target, ...(reason.trim() ? { reason: reason.trim() } : {}) },
        idempotent: true,
      });
    } else if (panel === 'close' && session && reason.trim().length >= 3) {
      write.mutate({
        path: `/sessions/${session.id}/cancel`,
        body: { reason: reason.trim() },
        idempotent: true,
      });
    } else if (panel === 'assign') {
      write.mutate(
        waiter
          ? { path: `/tables/${table.id}/assignment`, method: 'PUT', body: { userId: waiter } }
          : { path: `/tables/${table.id}/assignment`, method: 'DELETE' },
      );
    }
  };

  return (
    <section className="card stack table-card" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>{table.name}</h2>
        <span className={state.chip}>{state.text}</span>
        {session?.stale ? <span className="chip chip-warning">Open a long time</span> : null}
      </div>
      <dl className="kv">
        <dt>Waiter</dt>
        <dd>{table.waiter ? table.waiter.name : 'Unassigned (cashier)'}</dd>
        {session ? (
          <>
            <dt>Session</dt>
            <dd>{session.sessionNo}</dd>
            <dt>Seated</dt>
            <dd>
              {sinceText(session.openedAt, now)}
              {session.guestCount ? ` · ${String(session.guestCount)} guests` : ''}
            </dd>
            <dt>Guest phones</dt>
            <dd>{session.guestPhones}</dd>
          </>
        ) : null}
      </dl>
      <div className="row">
        {table.state === 'available' && can.open ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!writes}
            onClick={() => {
              toggle('open');
            }}
          >
            Open table <span className="visually-hidden">{table.name}</span>
          </button>
        ) : null}
        {session && can.transfer ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes}
            onClick={() => {
              toggle('move');
            }}
          >
            Move <span className="visually-hidden">{table.name}</span>
          </button>
        ) : null}
        {session && can.reset && session.guestPhones > 0 ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || write.isPending}
            onClick={() => {
              write.mutate({ path: `/sessions/${session.id}/reset-guests` });
            }}
          >
            Reset guest phones <span className="visually-hidden">at {table.name}</span>
          </button>
        ) : null}
        {session?.status === 'open' && can.cancel ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes}
            onClick={() => {
              toggle('close');
            }}
          >
            Close empty session <span className="visually-hidden">at {table.name}</span>
          </button>
        ) : null}
        {can.assign ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes}
            onClick={() => {
              toggle('assign');
            }}
          >
            Waiter <span className="visually-hidden">for {table.name}</span>
          </button>
        ) : null}
      </div>
      {panel !== 'none' ? (
        <form className="stack" onSubmit={submit} noValidate>
          {panel === 'open' ? (
            <Field
              label="Guests (optional)"
              inputMode="numeric"
              value={guests}
              onChange={(e) => {
                setGuests(e.target.value);
              }}
            />
          ) : null}
          {panel === 'move' ? (
            <>
              <SelectField
                label="Move to"
                value={target}
                options={[
                  { value: '', label: freeTables.length ? 'Choose a free table' : 'No free table' },
                  ...freeTables.map((t) => ({ value: t.id, label: t.name })),
                ]}
                onChange={setTarget}
              />
              <Field
                label="Reason (optional)"
                maxLength={200}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                }}
              />
            </>
          ) : null}
          {panel === 'close' ? (
            <Field
              label="Why close it?"
              placeholder="e.g. Guests left without ordering"
              maxLength={200}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
          ) : null}
          {panel === 'assign' ? (
            <SelectField
              label={`Waiter for ${table.name}`}
              value={waiter}
              options={[
                { value: '', label: 'Unassigned (cashier)' },
                ...waiters.map((w) => ({ value: w.id, label: w.name })),
              ]}
              onChange={setWaiter}
            />
          ) : null}
          <div className="row">
            <button
              type="submit"
              className={panel === 'close' ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={
                !writes ||
                write.isPending ||
                (panel === 'move' && !target) ||
                (panel === 'close' && reason.trim().length < 3)
              }
            >
              {
                {
                  open: 'Open table',
                  move: 'Move session',
                  close: 'Close session',
                  assign: 'Save waiter',
                  none: '',
                }[panel]
              }
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPanel('none');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {floorMessage(write.error)}
        </div>
      ) : null}
    </section>
  );
}
