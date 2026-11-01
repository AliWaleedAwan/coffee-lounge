/**
 * Scheduled e-mails (FINANCE_REPORTING.md §8; D-20; Phase 6 step 6.6): which report goes
 * to whom and when, and the queue of e-mails with where each one stands (AT-21: waiting for
 * the internet, sent, refused) and a retry that keeps its Message-ID (AT-104).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { CheckField, Field, SelectField, TextAreaField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';

interface Schedule {
  id: string;
  reportType: string;
  title: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  sendAt: string;
  weekday: number | null;
  recipients: string[];
  filters: Record<string, string>;
  isActive: boolean;
  version: number;
}
interface Delivery {
  id: string;
  title: string;
  period: { from: string; to: string };
  recipient: string | null;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'not_made';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STATUS: Record<Delivery['status'], string> = {
  queued: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Refused',
  not_made: 'Not made',
};
const when = (s: Schedule) =>
  s.frequency === 'daily'
    ? `Daily at ${s.sendAt}`
    : s.frequency === 'weekly'
      ? `${WEEKDAYS[(s.weekday ?? 1) - 1] ?? ''}s at ${s.sendAt} (last week)`
      : `On the 1st at ${s.sendAt} (last month)`;
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function EmailsPanel({ reports }: { reports: { key: string; title: string }[] }) {
  const client = useQueryClient();
  const [view, setView] = useState<'daily' | 'custom' | 'sent'>('daily');
  const schedules = useQuery({
    queryKey: ['mail', 'schedules'],
    queryFn: ({ signal }) => api<{ items: Schedule[] }>('/report-schedules', { signal }),
  });
  const deliveries = useQuery({
    queryKey: ['mail', 'deliveries'],
    queryFn: ({ signal }) => api<{ items: Delivery[] }>('/report-deliveries', { signal }),
    refetchInterval: 30_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['mail'] });
  const toggle = useMutation({
    mutationFn: (s: Schedule) =>
      api(`/report-schedules/${s.id}`, {
        method: 'PUT',
        body: {
          reportType: s.reportType,
          filters: s.filters,
          frequency: s.frequency,
          sendAt: s.sendAt,
          ...(s.weekday ? { weekday: s.weekday } : {}),
          recipients: s.recipients,
          isActive: !s.isActive,
          expectedVersion: s.version,
        },
      }),
    onSettled: refresh,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api(`/report-deliveries/${id}/retry`, { method: 'POST' }),
    onSettled: refresh,
  });
  const options = [{ key: 'day-end', title: 'Day-end report' }, ...reports];
  return (
    <>
      <div className="tabs" role="tablist" aria-label="E-mail reports">
        {(
          [
            ['daily', 'Daily e-mail'],
            ['custom', 'Other schedules'],
            ['sent', 'Sent and waiting'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => {
              setView(key);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <section hidden={view === 'sent'} className="card stack" aria-labelledby="schedules-head">
        <h2 id="schedules-head">Scheduled e-mails</h2>
        <p className="muted">
          Each report covers the period that has just ended and goes out from the shop mailbox
          (Settings → E-mail). Without internet the e-mails wait and go when it is back.
        </p>
        {schedules.isPending ? <Loading label="Loading the schedules" /> : null}
        {schedules.data && schedules.data.items.length === 0 ? (
          <p className="muted">Nothing scheduled yet.</p>
        ) : null}
        {schedules.data && schedules.data.items.length > 0 ? (
          <div className="table-scroll">
            <table className="data" aria-label="Scheduled e-mails">
              <thead>
                <tr>
                  <th scope="col">Report</th>
                  <th scope="col">When</th>
                  <th scope="col">To</th>
                  <th scope="col">On</th>
                </tr>
              </thead>
              <tbody>
                {schedules.data.items.map((s) => (
                  <tr key={s.id}>
                    <td>{s.title}</td>
                    <td>{when(s)}</td>
                    <td>{s.recipients.join(', ')}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-pressed={s.isActive}
                        disabled={toggle.isPending}
                        onClick={() => {
                          toggle.mutate(s);
                        }}
                      >
                        {s.isActive ? 'On' : 'Paused'}
                        <span className="visually-hidden"> {s.title}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {toggle.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(toggle.error)}
          </div>
        ) : null}
        {view === 'daily' ? (
          <DailyToOwner options={options} existing={schedules.data?.items ?? []} onDone={refresh} />
        ) : (
          <NewSchedule options={options} onDone={refresh} />
        )}
      </section>
      <section hidden={view !== 'sent'} className="card stack" aria-labelledby="queue-head">
        <h2 id="queue-head">E-mails sent and waiting</h2>
        {deliveries.data && deliveries.data.items.length === 0 ? (
          <p className="muted">No e-mails yet.</p>
        ) : null}
        {deliveries.data && deliveries.data.items.length > 0 ? (
          <div className="table-scroll">
            <table className="data" aria-label="E-mails">
              <thead>
                <tr>
                  <th scope="col">Report</th>
                  <th scope="col">Period</th>
                  <th scope="col">To</th>
                  <th scope="col">Status</th>
                  <th scope="col">Details</th>
                  <th scope="col">
                    <span className="visually-hidden">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {deliveries.data.items.map((d) => (
                  <tr key={d.id}>
                    <td>{d.title}</td>
                    <td>
                      {d.period.from === d.period.to
                        ? d.period.from
                        : `${d.period.from} to ${d.period.to}`}
                    </td>
                    <td>{d.recipient ?? '—'}</td>
                    <td>{STATUS[d.status]}</td>
                    <td>
                      {d.status === 'sent'
                        ? `Sent ${time(d.sentAt)}`
                        : [
                            d.lastError,
                            d.nextAttemptAt ? `next try ${time(d.nextAttemptAt)}` : null,
                            d.attempts > 0 ? `${String(d.attempts)} tries` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </td>
                    <td>
                      {d.status === 'queued' || d.status === 'failed' ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={retry.isPending}
                          onClick={() => {
                            retry.mutate(d.id);
                          }}
                        >
                          Try again now
                          <span className="visually-hidden">
                            {' '}
                            {d.title} to {d.recipient}
                          </span>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {retry.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(retry.error)}
          </div>
        ) : null}
      </section>
    </>
  );
}

// By what the owner is looking for; the last group catches anything new.
const REPORT_GROUPS = [
  { title: 'Sales', match: /^(Day-end|Sales|Bills|Menu eng|Discounts|Deliveries)/ },
  { title: 'Money', match: /^(Payment|Recorded|Ledger|Expenses)/ },
  { title: 'Stock', match: /^(Inventory|Waste|Stock|Purchases)/ },
  {
    title: 'Other',
    match:
      /^(?!Day-end|Sales|Bills|Menu eng|Discounts|Deliveries|Payment|Recorded|Ledger|Expenses|Inventory|Waste|Stock|Purchases)/,
  },
];

/** The owner's morning e-mail: tick the reports, give an address, one schedule each. */
function DailyToOwner({
  options,
  existing,
  onDone,
}: {
  options: { key: string; title: string }[];
  existing: Schedule[];
  onDone: () => Promise<void>;
}) {
  const [address, setAddress] = useState('');
  const [sendAt, setSendAt] = useState('08:00');
  const [ticked, setTicked] = useState<string[]>(['day-end']);
  const daily = existing
    .filter((s) => s.frequency === 'daily' && s.isActive)
    .map((s) => s.reportType);
  const save = useMutation({
    mutationFn: async () => {
      for (const reportType of ticked.filter((k) => !daily.includes(k))) {
        await api('/report-schedules', {
          method: 'POST',
          body: { reportType, frequency: 'daily', sendAt, recipients: [address.trim()] },
        });
      }
    },
    onSuccess: onDone,
  });
  return (
    <form
      className="stack"
      noValidate
      aria-label="Daily e-mail to the owner"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3>Daily e-mail to the owner</h3>
      <p className="muted">
        Tick what you want each morning. It is sent once the shop's mailbox is set up in Settings.
      </p>
      {REPORT_GROUPS.map((g) => (
        <fieldset key={g.title} className="stack stack-tight">
          <legend>{g.title}</legend>
          <div className="checks">
            {options
              .filter((o) => g.match.test(o.title))
              .map((o) => (
                <CheckField
                  key={o.key}
                  label={o.title}
                  checked={daily.includes(o.key) || ticked.includes(o.key)}
                  onChange={(on) => {
                    setTicked(on ? [...ticked, o.key] : ticked.filter((k) => k !== o.key));
                  }}
                />
              ))}
          </div>
        </fieldset>
      ))}
      <div className="row">
        <Field
          label="Owner's e-mail"
          type="email"
          maxLength={120}
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
          }}
        />
        <Field
          label="Send at (04:30 or later)"
          type="time"
          min="04:30"
          value={sendAt}
          onChange={(e) => {
            setSendAt(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            !address.includes('@') || save.isPending || ticked.every((k) => daily.includes(k))
          }
        >
          Save daily e-mail
        </button>
      </div>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
    </form>
  );
}

function NewSchedule({
  options,
  onDone,
}: {
  options: { key: string; title: string }[];
  onDone: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    reportType: 'day-end',
    frequency: 'daily',
    sendAt: '08:00',
    weekday: '1',
    recipients: '',
  });
  const create = useMutation({
    mutationFn: () =>
      api('/report-schedules', {
        method: 'POST',
        body: {
          reportType: form.reportType,
          frequency: form.frequency,
          sendAt: form.sendAt,
          ...(form.frequency === 'weekly' ? { weekday: Number(form.weekday) } : {}),
          recipients: form.recipients
            .split(/[\s,;]+/)
            .map((r) => r.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: async () => {
      setForm((f) => ({ ...f, recipients: '' }));
      await onDone();
    },
  });
  const set = (key: keyof typeof form) => (value: string) => {
    create.reset();
    setForm({
      ...form,
      [key]: value,
      ...(key === 'reportType' && value === 'day-end' ? { frequency: 'daily' } : {}),
    });
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <form className="stack" noValidate onSubmit={submit} aria-labelledby="new-schedule">
      <h3 id="new-schedule">New schedule</h3>
      <div className="row">
        <SelectField
          label="Report"
          value={form.reportType}
          options={options.map((o) => ({ value: o.key, label: o.title }))}
          onChange={set('reportType')}
        />
        <SelectField
          label="How often"
          value={form.frequency}
          disabled={form.reportType === 'day-end'}
          options={[
            { value: 'daily', label: 'Daily (yesterday)' },
            { value: 'weekly', label: 'Weekly (last week)' },
            { value: 'monthly', label: 'Monthly (last month)' },
          ]}
          onChange={set('frequency')}
        />
        {form.frequency === 'weekly' ? (
          <SelectField
            label="On"
            value={form.weekday}
            options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))}
            onChange={set('weekday')}
          />
        ) : null}
        <Field
          label="At (04:30 or later)"
          type="time"
          min="04:30"
          value={form.sendAt}
          onChange={(e) => {
            set('sendAt')(e.target.value);
          }}
        />
      </div>
      <TextAreaField
        label="To (one or more addresses)"
        value={form.recipients}
        onChange={set('recipients')}
      />
      {create.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(create.error)}
        </div>
      ) : null}
      {create.isSuccess ? (
        <p role="status" className="muted">
          Scheduled. The first e-mail covers the next period that ends.
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={create.isPending || !form.recipients.trim()}
        >
          Schedule it
        </button>
      </div>
    </form>
  );
}
