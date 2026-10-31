/**
 * Settings (UI_UX.md §6). Step 3.6 adds printers (PRINTING_HARDWARE.md §2): the shop's
 * receipt printer by Windows queue name (USB) or network address, which printer takes
 * kitchen tickets and which takes receipts (step 3.7), and a test print (W-4); the shop's
 * branding, guest ordering hours and thresholds (step 3.12, OwnerSettings).
 */
import { useState, type SubmitEvent } from 'react';
import { permissionSet } from '../../auth/session.ts';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { messageOf } from '../../api/client.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useManagedPrinters, usePrintWrite } from '../printing/printing-api.ts';
import { MailboxForm } from './MailboxForm.tsx';
import { OwnerSettings } from './OwnerSettings.tsx';
import { useSignedIn } from '../Shell.tsx';

export function SettingsScreen() {
  const permissions = permissionSet(useSignedIn());
  return (
    <>
      <h1>Settings</h1>
      {permissions.has('settings.manage') ? <OwnerSettings /> : null}
      {permissions.has('settings.mailbox') ? <MailboxForm /> : null}
      {permissions.has('printers.manage') ? <Printers /> : null}
    </>
  );
}

function Printers() {
  const writes = useWritesAllowed();
  const printers = useManagedPrinters();
  const act = usePrintWrite<{ jobId?: string }>();
  const [tested, setTested] = useState<string | null>(null);
  const items = printers.data?.items ?? [];
  const stations = printers.data?.stations ?? [];
  const tills = printers.data?.tills ?? [];
  return (
    <section className="stack" aria-labelledby="printers">
      <h2 id="printers">Printers</h2>
      {printers.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(printers.error)}
        </div>
      ) : null}
      {act.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(act.error)}
        </div>
      ) : null}
      {tested ? (
        <div role="status" className="banner banner-success">
          Test page sent to {tested}. Check that it printed and cut cleanly.
        </div>
      ) : null}
      {items.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Connection</th>
              <th scope="col">Paper</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {p.isActive ? null : <span className="chip chip-warning"> Off</span>}
                </td>
                <td>
                  {p.connection === 'spooler' ? 'USB (Windows queue)' : 'Network'} · {p.address}
                </td>
                <td>
                  {p.paperWidthMm} mm · {p.charsPerLine} characters
                </td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={!writes || act.isPending || !p.isActive}
                      onClick={() => {
                        setTested(null);
                        act.mutate(
                          { path: `/printers/${p.id}/test` },
                          {
                            onSuccess: () => {
                              setTested(p.name);
                            },
                          },
                        );
                      }}
                    >
                      Test print <span className="visually-hidden">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || act.isPending}
                      onClick={() => {
                        act.mutate({
                          path: `/printers/${p.id}`,
                          method: 'PATCH',
                          body: { expectedVersion: p.version, isActive: !p.isActive },
                        });
                      }}
                    >
                      {p.isActive ? 'Turn off' : 'Turn on'}{' '}
                      <span className="visually-hidden">{p.name}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {stations.map((s) => (
        <SelectField
          key={s.id}
          label={`${s.name} tickets print on`}
          value={s.printerId ?? ''}
          disabled={!writes || act.isPending}
          options={[
            { value: '', label: 'No printer (screens only)' },
            ...items.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(printerId) => {
            act.mutate({
              path: `/stations/${s.id}/printer`,
              method: 'PUT',
              body: { printerId: printerId || null },
            });
          }}
        />
      ))}
      {tills.map((t) => (
        <SelectField
          key={t.id}
          label={tills.length > 1 ? `Receipts at ${t.name} print on` : 'Receipts print on'}
          value={t.printerId ?? ''}
          disabled={!writes || act.isPending}
          options={[
            { value: '', label: 'No printer (reprint later)' },
            ...items.map((p) => ({ value: p.id, label: p.name })),
          ]}
          onChange={(printerId) => {
            act.mutate({
              path: `/tills/${t.id}/printer`,
              method: 'PUT',
              body: { printerId: printerId || null },
            });
          }}
        />
      ))}
      <NewPrinter />
    </section>
  );
}

function NewPrinter() {
  const writes = useWritesAllowed();
  const [name, setName] = useState('');
  const [connection, setConnection] = useState<string>('spooler');
  const [address, setAddress] = useState('');
  const [paper, setPaper] = useState('80');
  const [status, setStatus] = useState(false);
  const add = usePrintWrite(() => {
    setName('');
    setAddress('');
  });
  const addressOk =
    connection === 'spooler'
      ? address.trim().length > 0
      : /^[A-Za-z0-9.-]+:\d{1,5}$/.test(address.trim());
  const valid = name.trim().length > 0 && addressOk;
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || add.isPending) return;
    add.mutate({
      path: '/printers',
      body: {
        name: name.trim(),
        connection,
        address: address.trim(),
        paperWidthMm: Number(paper),
        supportsStatus: connection === 'tcp' && status,
      },
    });
  };
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="new-printer">
      <h3 id="new-printer">Add a printer</h3>
      <div className="row">
        <Field
          label="Name"
          placeholder="e.g. Counter printer"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <SelectField
          label="Connected by"
          value={connection}
          options={[
            { value: 'spooler', label: 'USB (Windows printer queue)' },
            { value: 'tcp', label: 'Network (ESC/POS on port 9100)' },
          ]}
          onChange={setConnection}
        />
      </div>
      <div className="row">
        <Field
          label={connection === 'spooler' ? 'Windows printer name' : 'Address'}
          placeholder={
            connection === 'spooler' ? 'as shown in Windows Printers' : '192.168.100.251:9100'
          }
          value={address}
          error={address && !addressOk ? 'Address and port, like 192.168.100.251:9100' : null}
          onChange={(e) => {
            setAddress(e.target.value);
          }}
        />
        <SelectField
          label="Paper"
          value={paper}
          options={[
            { value: '80', label: '80 mm (48 characters)' },
            { value: '58', label: '58 mm (32 characters)' },
          ]}
          onChange={setPaper}
        />
      </div>
      {connection === 'tcp' ? (
        <CheckField
          label="Printer reports paper and cover status"
          checked={status}
          onChange={setStatus}
        />
      ) : null}
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(add.error)}
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!valid || !writes || add.isPending}
        >
          Add printer
        </button>
      </div>
    </form>
  );
}
