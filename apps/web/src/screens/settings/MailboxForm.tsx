/**
 * The shop's mailbox for scheduled e-mails (P6-4; I-17; Phase 6 step 6.6). The owner types
 * the provider's details and an app password made at the provider; the password is sent
 * once, sealed on the server and never shown again (the field stays empty: leave it empty
 * to keep the saved one). "Send a test" shows the provider's own answer.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';

type Account =
  | { configured: false }
  | {
      configured: true;
      host: string;
      port: number;
      security: 'starttls' | 'tls';
      username: string;
      fromAddress: string;
      fromName: string;
      passwordSet: boolean;
      updatedAt: string;
      version: number;
    };

const SECURITY = [
  { value: 'starttls', label: 'STARTTLS (port 587)' },
  { value: 'tls', label: 'TLS (port 465)' },
];

export function MailboxForm() {
  const account = useQuery({
    queryKey: ['mail', 'account'],
    queryFn: ({ signal }) => api<Account>('/mail/account', { signal }),
  });
  if (account.isError) {
    return (
      <div role="alert" className="banner banner-danger">
        {messageOf(account.error)}
      </div>
    );
  }
  if (!account.data) return <Loading label="Loading the mailbox" />;
  return <Mailbox account={account.data} />;
}

function Mailbox({ account }: { account: Account }) {
  const writes = useWritesAllowed();
  const client = useQueryClient();
  const saved = account.configured ? account : null;
  const [form, setForm] = useState({
    host: saved?.host ?? 'smtp.gmail.com',
    port: String(saved?.port ?? 587),
    security: saved?.security ?? 'starttls',
    username: saved?.username ?? '',
    fromAddress: saved?.fromAddress ?? '',
    fromName: saved?.fromName ?? 'Coffee Lounge',
    password: '',
  });
  const [testTo, setTestTo] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api<Account>('/mail/account', {
        method: 'PUT',
        body: {
          host: form.host.trim(),
          port: Number(form.port),
          security: form.security,
          username: form.username.trim(),
          fromAddress: form.fromAddress.trim(),
          fromName: form.fromName.trim(),
          ...(form.password ? { password: form.password } : {}),
          ...(saved ? { expectedVersion: saved.version } : {}),
        },
      }),
    onSuccess: async () => {
      setForm((f) => ({ ...f, password: '' }));
      await client.invalidateQueries({ queryKey: ['mail', 'account'] });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      api<{ to: string }>('/mail/test', { method: 'POST', body: { to: testTo.trim() } }),
  });
  const set = (key: keyof typeof form) => (value: string) => {
    save.reset();
    setForm({ ...form, [key]: value });
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (writes) save.mutate();
  };
  return (
    <form className="card stack" noValidate onSubmit={submit} aria-labelledby="mailbox">
      <h2 id="mailbox">E-mail (scheduled reports)</h2>
      <p className="muted">
        Reports are sent from your own mailbox. Create an app password at your provider (Gmail:
        Google Account → Security → App passwords) and type it here; it is stored encrypted and
        never shown again.
      </p>
      <div className="row">
        <Field
          label="Mail server"
          value={form.host}
          onChange={(e) => {
            set('host')(e.target.value);
          }}
        />
        <Field
          label="Port"
          inputMode="numeric"
          value={form.port}
          onChange={(e) => {
            set('port')(e.target.value);
          }}
        />
        <SelectField
          label="Security"
          value={form.security}
          options={SECURITY}
          onChange={(v) => {
            set('security')(v);
          }}
        />
      </div>
      <div className="row">
        <Field
          label="Mailbox user name"
          autoComplete="off"
          value={form.username}
          onChange={(e) => {
            set('username')(e.target.value);
          }}
        />
        <Field
          label="App password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          hint={saved?.passwordSet ? 'Saved. Leave empty to keep it.' : undefined}
          onChange={(e) => {
            set('password')(e.target.value);
          }}
        />
      </div>
      <div className="row">
        <Field
          label="Send as (address)"
          type="email"
          value={form.fromAddress}
          onChange={(e) => {
            set('fromAddress')(e.target.value);
          }}
        />
        <Field
          label="Send as (name)"
          maxLength={80}
          value={form.fromName}
          onChange={(e) => {
            set('fromName')(e.target.value);
          }}
        />
      </div>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="muted">
          Saved.
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!writes || save.isPending || (!saved && !form.password)}
        >
          Save mailbox
        </button>
      </div>
      {saved ? (
        <div className="row">
          <Field
            label="Send a test to"
            type="email"
            value={testTo}
            onChange={(e) => {
              test.reset();
              setTestTo(e.target.value);
            }}
          />
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes || test.isPending || !testTo.trim()}
              onClick={() => {
                test.mutate();
              }}
            >
              Send a test
            </button>
          </div>
        </div>
      ) : null}
      {test.isSuccess ? (
        <p role="status" className="banner banner-success">
          Sent to {test.data.to}. Check that inbox (and its spam folder).
        </p>
      ) : null}
      {test.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(test.error)}
        </div>
      ) : null}
    </form>
  );
}
