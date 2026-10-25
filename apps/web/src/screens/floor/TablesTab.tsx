/**
 * Tables and QR codes (owner, `tables.manage`). A QR code's secret is shown once, when it
 * is made for printing: making new codes for a table retires the card printed before, so
 * the sheet says so before it is made. The sheet prints on A4, six cards a page.
 */
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import {
  floorMessage,
  useFloorWrite,
  useManagedTables,
  type ManagedTable,
  type PrintedCode,
} from './floor-api.ts';
import { QrCode } from './qr.tsx';

const AVAILABILITY = [
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Blocked (no orders)' },
  { value: 'maintenance', label: 'Maintenance (no orders)' },
] as const;

const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function TablesTab() {
  const tables = useManagedTables();
  const [sheet, setSheet] = useState<{ baseUrl: string | null; items: PrintedCode[] } | null>(null);
  if (sheet) {
    return (
      <QrSheet
        baseUrl={sheet.baseUrl}
        codes={sheet.items}
        onClose={() => {
          setSheet(null);
        }}
      />
    );
  }
  const items = tables.data?.items ?? [];
  return (
    <>
      {tables.isError ? (
        <div role="alert" className="banner banner-danger">
          {floorMessage(tables.error)}
        </div>
      ) : null}
      {items.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Seats</th>
              <th scope="col">Status</th>
              <th scope="col">QR card printed</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((t) => (
              <TableRow key={t.id} table={t} />
            ))}
          </tbody>
        </table>
      ) : null}
      <NewTable />
      {items.length > 0 ? <PrintCodes tables={items} onMade={setSheet} /> : null}
    </>
  );
}

function TableRow({ table }: { table: ManagedTable }) {
  const writes = useWritesAllowed();
  const write = useFloorWrite();
  return (
    <tr>
      <td>{table.code}</td>
      <td>{table.name}</td>
      <td>{table.seats ?? '—'}</td>
      <td>
        <SelectField
          label={`Status of ${table.name}`}
          value={table.availability}
          options={AVAILABILITY}
          disabled={!writes || write.isPending}
          onChange={(availability) => {
            write.mutate({
              path: `/tables/${table.id}`,
              method: 'PATCH',
              body: { expectedVersion: table.version, availability },
            });
          }}
        />
        {write.isError ? (
          <div role="alert" className="banner banner-danger">
            {floorMessage(write.error)}
          </div>
        ) : null}
      </td>
      <td>
        {table.qrPrintedAt ? (
          date.format(new Date(table.qrPrintedAt))
        ) : (
          <span className="chip chip-warning">Not yet</span>
        )}
      </td>
      <td>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || write.isPending}
          onClick={() => {
            write.mutate({
              path: `/tables/${table.id}/archive`,
              body: { expectedVersion: table.version },
            });
          }}
        >
          Archive <span className="visually-hidden">{table.name}</span>
        </button>
      </td>
    </tr>
  );
}

function NewTable() {
  const writes = useWritesAllowed();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [seats, setSeats] = useState('');
  const write = useFloorWrite(() => {
    setCode('');
    setName('');
    setSeats('');
  });
  const codeOk = /^[A-Za-z0-9-]{1,12}$/.test(code.trim());
  const valid = codeOk && name.trim().length > 0 && (seats === '' || /^\d{1,2}$/.test(seats));
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || write.isPending) return;
    write.mutate({
      path: '/tables',
      body: { code: code.trim(), name: name.trim(), ...(seats ? { seats: Number(seats) } : {}) },
    });
  };
  return (
    <section className="card stack" aria-labelledby="new-table">
      <h2 id="new-table">New table</h2>
      <form className="row" onSubmit={submit} noValidate>
        <Field
          label="Code"
          placeholder="e.g. T05"
          maxLength={12}
          value={code}
          error={code && !codeOk ? 'Letters, digits and - only' : null}
          onChange={(e) => {
            setCode(e.target.value);
          }}
        />
        <Field
          label="Name"
          placeholder="e.g. Table 5"
          maxLength={40}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Field
          label="Seats (optional)"
          inputMode="numeric"
          value={seats}
          onChange={(e) => {
            setSeats(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!valid || !writes || write.isPending}
        >
          Add table
        </button>
      </form>
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {floorMessage(write.error)}
        </div>
      ) : null}
    </section>
  );
}

function PrintCodes({
  tables,
  onMade,
}: {
  tables: ManagedTable[];
  onMade: (sheet: { baseUrl: string | null; items: PrintedCode[] }) => void;
}) {
  const writes = useWritesAllowed();
  const [chosen, setChosen] = useState<string[]>([]);
  const [counter, setCounter] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const make = useFloorWrite<{ baseUrl: string | null; items: PrintedCode[] }>((sheet) => {
    setConfirming(false);
    onMade(sheet);
  });
  const replacing = tables.filter((t) => chosen.includes(t.id) && t.qrPrintedAt !== null);
  const any = chosen.length > 0 || counter;
  return (
    <section className="card stack" aria-labelledby="print-codes">
      <h2 id="print-codes">Print QR codes</h2>
      <p className="muted">
        Each code works until a new one is made for the same table. Make codes only when you are
        ready to print and place them.
      </p>
      <fieldset className="stack">
        <legend>Tables</legend>
        <div className="checks">
          <CheckField
            label="All tables"
            checked={chosen.length === tables.length}
            onChange={(on) => {
              setChosen(on ? tables.map((t) => t.id) : []);
            }}
          />
          {tables.map((t) => (
            <CheckField
              key={t.id}
              label={t.name}
              checked={chosen.includes(t.id)}
              onChange={(on) => {
                setChosen(on ? [...chosen, t.id] : chosen.filter((x) => x !== t.id));
              }}
            />
          ))}
        </div>
      </fieldset>
      <CheckField label="Counter takeaway code" checked={counter} onChange={setCounter} />
      {confirming && replacing.length > 0 ? (
        <div role="alert" className="banner banner-warning">
          The cards already on {replacing.map((t) => t.name).join(', ')} will stop working. Replace
          them with the new print.
        </div>
      ) : null}
      {make.isError ? (
        <div role="alert" className="banner banner-danger">
          {floorMessage(make.error)}
        </div>
      ) : null}
      <div className="row">
        {confirming || replacing.length === 0 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!any || !writes || make.isPending}
            onClick={() => {
              make.mutate({
                path: '/qr-entry-points/generate',
                body: { tableIds: chosen, counter },
              });
            }}
          >
            {make.isPending ? 'Making codes…' : 'Make codes for printing'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!any || !writes}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Make codes for printing
          </button>
        )}
      </div>
    </section>
  );
}

/** The printable sheet. Its secrets exist only on this screen: closing it forgets them. */
export function QrSheet({
  baseUrl,
  codes,
  onClose,
}: {
  baseUrl: string | null;
  codes: PrintedCode[];
  onClose: () => void;
}) {
  return (
    <section className="stack" aria-labelledby="qr-sheet">
      <div className="section-head no-print">
        <h2 id="qr-sheet">QR cards</h2>
        <button
          type="button"
          className="btn btn-primary"
          disabled={baseUrl === null}
          onClick={() => {
            window.print();
          }}
        >
          Print
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Done
        </button>
      </div>
      {baseUrl === null ? (
        <div role="alert" className="banner banner-danger no-print">
          The shop address for guests is unknown. Set GUEST_BASE_URL in the server settings (for
          example http://192.168.100.250:8080), then make the codes again.
        </div>
      ) : (
        <p className="muted no-print">
          Guests reach {baseUrl}. Print now: these codes are not shown again.
        </p>
      )}
      <div className="qr-sheet">
        {codes.map((c) =>
          c.url ? (
            <figure key={c.entryPointId} className="qr-card">
              <QrCode text={c.url} label={`QR code for ${c.label}`} />
              <figcaption>
                <strong>{c.label}</strong>
                <span>Scan to see the menu and order</span>
              </figcaption>
            </figure>
          ) : null,
        )}
      </div>
    </section>
  );
}
