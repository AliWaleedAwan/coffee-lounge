/**
 * Hardware (Phase 8 step 8.6, PLAN.md §4). Printers moved here from Settings
 * (PRINTING_HARDWARE.md §2): the Windows queues the counter PC finds, or a network address,
 * which printer takes kitchen tickets and receipts, and a test print (W-4). The scanner is a
 * USB keyboard, so there is nothing to install: the test box shows what it sends.
 */
import { useRef, useState, type KeyboardEvent, type SubmitEvent } from 'react';
import { messageOf } from '../../api/client.ts';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useDetectedQueues, useManagedPrinters, usePrintWrite } from '../printing/printing-api.ts';
import { readScan, type ScanVerdict } from './scanner-test.ts';

/** A scanner finishes well within this; longer means no Enter is coming. */
const NO_ENTER_MS = 800;

export function HardwareScreen() {
  return (
    <>
      <h1>Hardware</h1>
      <Printers />
      <ScannerTest />
    </>
  );
}

function ScannerTest() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<(ScanVerdict & { enter: boolean }) | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const finish = (raw: string, enter: boolean): void => {
    window.clearTimeout(timer.current);
    if (raw.trim()) setResult({ ...readScan(raw), enter });
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    finish(text, true);
  };
  return (
    <section className="card stack" aria-labelledby="scanner">
      <h2 id="scanner">Scanner</h2>
      <p className="muted">
        Click in the box and scan a real product. The scanner works like a USB keyboard, so there is
        nothing to install.
      </p>
      <Field
        label="Test scanner"
        autoComplete="off"
        value={text}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            finish(value, false);
          }, NO_ENTER_MS);
        }}
      />
      {result ? (
        <div role="status" className="stack">
          <p>
            Code <strong>{result.code}</strong> · {result.type}
          </p>
          {result.checkOk ? null : (
            <div className="banner banner-warning">
              These digits fail the barcode's own check. Scan it again; if this keeps happening the
              label is damaged or the scanner is dropping digits.
            </div>
          )}
          {result.enter ? (
            <div className="banner banner-success">Enter arrived. The scanner is set up right.</div>
          ) : (
            <div className="banner banner-warning">
              No Enter arrived, so scans will not go through by themselves. Set the scanner to add
              Enter (CR) after each scan: its manual has a barcode to scan for this.
            </div>
          )}
        </div>
      ) : null}
    </section>
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
    <section className="card stack" aria-labelledby="printers">
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
  const detected = useDetectedQueues();
  const queues = detected.data?.supported ? detected.data.queues : [];
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
      {connection === 'spooler' ? (
        <div className="stack">
          {queues.length > 0 ? (
            <SelectField
              label="Printers Windows found"
              value={queues.some((q) => q.name === address) ? address : ''}
              options={[
                { value: '', label: 'Choose one, or type the name below' },
                ...queues.map((q) => ({ value: q.name, label: `${q.name} (${q.port})` })),
              ]}
              onChange={(picked) => {
                setAddress(picked);
                if (picked && !name.trim()) setName(picked.slice(0, 60));
              }}
            />
          ) : null}
          {detected.data?.supported && queues.length === 0 ? (
            <div role="status" className="banner banner-warning">
              {'problem' in detected.data && detected.data.problem
                ? detected.data.problem
                : 'Windows has no printers yet. Install the printer in Windows first: Settings, Devices, Printers & scanners. Then press Look again.'}
            </div>
          ) : null}
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={detected.isFetching}
              onClick={() => {
                void detected.refetch();
              }}
            >
              Look again
            </button>
          </div>
        </div>
      ) : null}
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
