/**
 * Settings (UI_UX.md §6): the shop's branding, guest ordering hours and thresholds (step 3.12, OwnerSettings).
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { permissionSet } from '../../auth/session.ts';
import { Field } from '../../components/Field.tsx';
import { api, messageOf } from '../../api/client.ts';
import { MailboxForm } from './MailboxForm.tsx';
import { OffsiteForm } from './OffsiteForm.tsx';
import { OwnerSettings } from './OwnerSettings.tsx';
import { useSignedIn } from '../Shell.tsx';

export function SettingsScreen() {
  const permissions = permissionSet(useSignedIn());
  return (
    <>
      <h1>Settings</h1>
      <nav className="jump-nav" aria-label="Settings sections">
        {[
          ['branding', 'Shop'],
          ['hours', 'Ordering hours'],
          ['thresholds', 'Limits and lists'],
          ['mailbox', 'E-mail'],
          ['offsite', 'Backups'],
          ['demo-data', 'Demo data'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              document
                .getElementById(id ?? '')
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {permissions.has('settings.manage') ? <OwnerSettings /> : null}
      {permissions.has('settings.mailbox') ? <MailboxForm /> : null}
      {permissions.has('backup.manage') ? <OffsiteForm /> : null}
      <DemoData />
    </>
  );
}

/** Demo only: one irreversible button that ends the demo for good (docs/phase-8/DEMO.md). */
function DemoData() {
  const me = useSignedIn();
  const [typed, setTyped] = useState('');
  const demo = useQuery({
    queryKey: ['demo'],
    queryFn: ({ signal }) => api<{ active: boolean }>('/demo', { signal }),
  });
  const wipe = useMutation({
    mutationFn: () => api<undefined>('/demo/wipe', { method: 'POST', body: { confirm: 'DELETE' } }),
    onSuccess: () => {
      window.location.assign('/');
    },
  });
  if (!demo.data?.active || !me.roles.includes('owner')) return null;
  return (
    <section className="card stack" aria-labelledby="demo-data">
      <h2 id="demo-data">Demo data</h2>
      <p className="muted">
        Deletes all made-up sales, stock, people, tables and assets, and starts numbering again. The
        menu and inventory items stay. It works only once and cannot be undone; the demo switcher
        goes with it.
      </p>
      <div className="row">
        <Field
          label="Type DELETE to confirm"
          autoComplete="off"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
        />
        <button
          type="button"
          className="btn btn-danger"
          disabled={typed !== 'DELETE' || wipe.isPending}
          onClick={() => {
            wipe.mutate();
          }}
        >
          Delete the demo data
        </button>
      </div>
      {wipe.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(wipe.error)}
        </div>
      ) : null}
    </section>
  );
}
