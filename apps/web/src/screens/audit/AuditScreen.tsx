/**
 * Audit log (SECURITY.md §4; Phase 5 step 5.5): who did what to which record, when and on
 * which device, with the values before and after, the reason and who approved it (AT-95).
 * Filter by person (as actor or approver), action, record and date; newest first, older
 * pages on request. Read only.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';

interface AuditItem {
  id: string;
  at: string;
  actorKind: 'user' | 'guest' | 'system';
  actor: string | null;
  device: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  approvedBy: string | null;
  ip: string | null;
}
interface Page {
  items: AuditItem[];
  nextBefore: string | null;
}

const at = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
const json = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v, null, 2));

export function AuditScreen() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filters = useQuery({
    queryKey: ['audit', 'filters'],
    queryFn: ({ signal }) =>
      api<{ actions: string[]; entityTypes: string[]; people: { id: string; name: string }[] }>(
        '/audit/filters',
        { signal },
      ),
  });
  const idOk = entityId === '' || /^\d{1,18}$/.test(entityId);
  const base = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(userId ? { userId } : {}),
    ...(action ? { action } : {}),
    ...(entityType ? { entityType } : {}),
    ...(entityId && idOk ? { entityId } : {}),
  };
  const log = useInfiniteQuery({
    queryKey: ['audit', 'log', base],
    queryFn: ({ pageParam, signal }) =>
      api<Page>(
        `/audit?${new URLSearchParams({ ...base, ...(pageParam ? { before: pageParam } : {}) }).toString()}`,
        { signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: idOk && !(from && to && from > to),
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  // Action families first ("payment"), then each action ("payment.refund").
  const families = [...new Set((filters.data?.actions ?? []).map((a) => a.split('.')[0] ?? a))];
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted">
        Every recorded action, newest first. Nothing here can be changed or deleted.
      </p>
      <section className="card stack" aria-label="Filters">
        <div className="row">
          <Field
            label="From"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          />
          <Field
            label="To"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
            }}
          />
          <SelectField
            label="Person"
            value={userId}
            options={[
              { value: '', label: 'Anyone' },
              ...(filters.data?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={setUserId}
          />
          <SelectField
            label="Action"
            value={action}
            options={[
              { value: '', label: 'Any action' },
              ...families.map((f) => ({ value: f, label: `${f} (all)` })),
              ...(filters.data?.actions ?? []).map((a) => ({ value: a, label: a })),
            ]}
            onChange={setAction}
          />
          <SelectField
            label="Record type"
            value={entityType}
            options={[
              { value: '', label: 'Any record' },
              ...(filters.data?.entityTypes ?? []).map((t) => ({ value: t, label: t })),
            ]}
            onChange={setEntityType}
          />
          <Field
            label="Record number"
            inputMode="numeric"
            value={entityId}
            error={idOk ? null : 'Digits only'}
            onChange={(e) => {
              setEntityId(e.target.value.trim());
            }}
          />
        </div>
      </section>
      <section className="card stack" aria-labelledby="audit-head">
        <h2 id="audit-head">Actions</h2>
        {log.isPending && idOk ? <Loading label="Loading the audit log" /> : null}
        {log.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(log.error)}
          </div>
        ) : null}
        {log.data && items.length === 0 ? <p className="muted">Nothing matches.</p> : null}
        {items.length > 0 ? (
          <table className="data" aria-label="Audit log">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Action</th>
                <th scope="col">Record</th>
                <th scope="col">Reason</th>
                <th scope="col">Approved by</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <Fragment key={i.id}>
                  <tr>
                    <td>{at.format(new Date(i.at))}</td>
                    <td>
                      {i.actor ?? (i.actorKind === 'guest' ? 'Guest' : 'System')}
                      {i.device ? <span className="muted"> · {i.device}</span> : null}
                    </td>
                    <td>
                      <code>{i.action}</code>
                    </td>
                    <td>
                      {i.entityType}
                      {i.entityId ? ` #${i.entityId}` : ''}
                    </td>
                    <td>{i.reason ?? ''}</td>
                    <td>{i.approvedBy ?? ''}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-expanded={open === i.id}
                        onClick={() => {
                          setOpen(open === i.id ? null : i.id);
                        }}
                      >
                        {open === i.id ? 'Hide' : 'Show'}
                        <span className="visually-hidden">
                          {' '}
                          before and after of {i.action} #{i.id}
                        </span>
                      </button>
                    </td>
                  </tr>
                  {open === i.id ? (
                    <tr>
                      <td colSpan={7}>
                        <div className="row">
                          <div>
                            <strong>Before</strong>
                            <pre>{json(i.before)}</pre>
                          </div>
                          <div>
                            <strong>After</strong>
                            <pre>{json(i.after)}</pre>
                          </div>
                        </div>
                        {i.ip ? <p className="muted">From {i.ip}</p> : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : null}
        {log.hasNextPage ? (
          <div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={log.isFetchingNextPage}
              onClick={() => {
                void log.fetchNextPage();
              }}
            >
              Show older
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}
