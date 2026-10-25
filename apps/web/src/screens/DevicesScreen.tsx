/** Devices (API.md §5: devices.manage): one-time registration codes, list, revoke. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { api, messageOf } from '../api/client.ts';
import type { DeviceInfo } from '../auth/session.ts';
import { Field, SelectField } from '../components/Field.tsx';
import { useWritesAllowed } from '../connection/ConnectionBanner.tsx';
import { useSignedIn } from './Shell.tsx';

interface ListedDevice extends DeviceInfo {
  lastSeenAt: string | null;
}

const KIND_OPTIONS = [
  { value: 'waiter', label: 'Waiter tablet or phone' },
  { value: 'reception', label: 'Counter PC' },
  { value: 'manager', label: 'Manager device' },
  { value: 'inventory', label: 'Inventory device' },
  { value: 'kitchen', label: 'Kitchen device' },
] as const;

const OWNERSHIP_OPTIONS = [
  { value: 'shop', label: 'Shop device' },
  { value: 'personal', label: 'Personal phone' },
] as const;

const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label]));
const time = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export function DevicesScreen() {
  const client = useQueryClient();
  const me = useSignedIn();
  const writes = useWritesAllowed();
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => api<{ items: ListedDevice[] }>('/devices', { signal }),
  });

  const [deviceName, setDeviceName] = useState('');
  const [kind, setKind] = useState<string>('waiter');
  const [ownership, setOwnership] = useState<string>('shop');
  const createCode = useMutation({
    mutationFn: () =>
      api<{ code: string; expiresAt: string }>('/devices/registration-codes', {
        method: 'POST',
        body: { deviceName: deviceName.trim(), kind, ownership },
      }),
  });
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (deviceName.trim() && writes && !createCode.isPending) createCode.mutate();
  };

  const [confirming, setConfirming] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api<DeviceInfo>(`/devices/${id}/revoke`, { method: 'POST' }),
    onSettled: () => {
      setConfirming(null);
      void client.invalidateQueries({ queryKey: ['devices'] });
    },
  });

  return (
    <>
      <h1>Devices</h1>
      <section className="card stack" aria-labelledby="new-code">
        <h2 id="new-code">Register a new device</h2>
        <p className="muted">
          Create a code here, then open the app on the new device and enter it within 10 minutes.
        </p>
        <form className="stack" onSubmit={submit} noValidate>
          <Field
            label="Device name"
            placeholder="e.g. Tablet 2"
            maxLength={60}
            value={deviceName}
            onChange={(e) => {
              setDeviceName(e.target.value);
            }}
          />
          <SelectField label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <SelectField
            label="Owned by"
            value={ownership}
            options={OWNERSHIP_OPTIONS}
            onChange={setOwnership}
          />
          {createCode.isError ? (
            <div role="alert" className="banner banner-danger">
              {messageOf(createCode.error)}
            </div>
          ) : null}
          <div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!deviceName.trim() || !writes || createCode.isPending}
            >
              {createCode.isPending ? 'Creating…' : 'Create code'}
            </button>
          </div>
        </form>
        {createCode.data ? (
          <div className="banner banner-success" role="status">
            <p>Registration code</p>
            <p className="code-display" data-testid="registration-code">
              {createCode.data.code}
            </p>
            <p>Valid until {time.format(new Date(createCode.data.expiresAt))}, once.</p>
          </div>
        ) : null}
      </section>

      <section className="stack" aria-labelledby="device-list">
        <h2 id="device-list">Registered devices</h2>
        {devices.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(devices.error)}
          </div>
        ) : null}
        {revoke.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(revoke.error)}
          </div>
        ) : null}
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Last seen</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(devices.data?.items ?? []).map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name}
                  {d.id === me.device.id ? <span className="muted"> (this device)</span> : null}
                </td>
                <td>
                  {KIND_LABEL[d.kind] ?? d.kind}
                  {d.ownership === 'personal' ? ' · personal' : ''}
                </td>
                <td>
                  <span className={d.status === 'active' ? 'chip chip-ok' : 'chip chip-danger'}>
                    {d.status === 'active' ? 'Active' : 'Revoked'}
                  </span>
                </td>
                <td>{d.lastSeenAt ? time.format(new Date(d.lastSeenAt)) : 'Never'}</td>
                <td>
                  {d.status === 'active' && d.id !== me.device.id ? (
                    confirming === d.id ? (
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={!writes || revoke.isPending}
                        onClick={() => {
                          revoke.mutate(d.id);
                        }}
                      >
                        Confirm: revoke {d.name}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!writes}
                        onClick={() => {
                          setConfirming(d.id);
                        }}
                      >
                        Revoke
                      </button>
                    )
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
