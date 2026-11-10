/**
 * Importing the old POS (owner's request, Nov 2026): the file made by
 * scripts/old-pos/export-old-pos.ps1 on a PC with Microsoft Access. Preview first: it runs the
 * import and undoes it, so what it shows is what Import does. Owner only (settings.manage): it
 * adds the menu and customers' details. Importing again adds only what is new.
 */
import { useState } from 'react';
import { API_BASE, errorFrom, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useSignedIn } from '../Shell.tsx';

interface Result {
  menu: {
    categoriesCreated: number;
    itemsCreated: number;
    productsCreated: number;
    alreadyThere: number;
    offSale: number;
  };
  skipped: { name: string; category: string; reason: string }[];
  customers: { created: number; updated: number };
  history: { bills: number; lines: number };
}

async function send(step: 'preview' | 'apply', file: File): Promise<Result> {
  const res = await fetch(`${API_BASE}/imports/old-pos/${step}`, {
    method: 'POST',
    headers: {
      'content-type': file.name.endsWith('.gz') ? 'application/gzip' : 'application/json',
      'x-cl-request': '1',
      accept: 'application/json',
    },
    credentials: 'same-origin',
    body: file,
  });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as Result;
}

export function OldPosImport() {
  const allowed = permissionSet(useSignedIn()).has('settings.manage');
  const writes = useWritesAllowed();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [preview, setPreview] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!allowed) return null;

  const run = async (step: 'preview' | 'apply'): Promise<void> => {
    if (!file) return;
    setBusy(step);
    setError(null);
    try {
      const result = await send(step, file);
      if (step === 'preview') setPreview(result);
      else {
        setDone(result);
        setPreview(null);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="old-pos-head">
      <h2 id="old-pos-head">Old POS</h2>
      <p className="muted">
        Brings in the old till&apos;s products, customers and sales history from the file{' '}
        <code>old-pos.json.gz</code>. Preview it first. Importing it again later adds only what is
        new. The file holds customers&apos; names and numbers: delete it once imported.
      </p>
      <div className="field">
        <label htmlFor="old-pos-file">Export file</label>
        <input
          id="old-pos-file"
          type="file"
          accept=".gz,.json,application/gzip,application/json"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setDone(null);
            setError(null);
          }}
        />
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!file || busy !== null}
          onClick={() => {
            void run('preview');
          }}
        >
          {busy === 'preview' ? 'Checking…' : 'Preview'}
          <span className="visually-hidden"> old POS file</span>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!preview || !writes || busy !== null}
          onClick={() => {
            void run('apply');
          }}
        >
          {busy === 'apply' ? 'Importing…' : 'Import'}
          <span className="visually-hidden"> old POS file</span>
        </button>
      </div>
      {busy ? (
        <p role="status" className="muted">
          This takes up to a minute for two years of sales.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      {preview ? <Summary result={preview} heading="Import would add" /> : null}
      {done ? <Summary result={done} heading="Imported" /> : null}
    </section>
  );
}

function Summary({ result, heading }: { result: Result; heading: string }) {
  const m = result.menu;
  return (
    <div role="status" className="stack">
      <h3>{heading}</h3>
      <ul>
        <li>
          {m.categoriesCreated} categories, {m.itemsCreated} menu items, {m.productsCreated}{' '}
          barcoded products (scan to sell){m.offSale > 0 ? `, ${String(m.offSale)} off sale` : ''}
        </li>
        <li>
          {result.customers.created} customers
          {result.customers.updated > 0 ? ` (${String(result.customers.updated)} updated)` : ''}
        </li>
        <li>
          {result.history.bills} old bills with {result.history.lines} lines of sales history
        </li>
        {m.alreadyThere > 0 ? <li>{m.alreadyThere} menu entries already there, kept</li> : null}
      </ul>
      {result.skipped.length > 0 ? (
        <details>
          <summary>{result.skipped.length} old products left out</summary>
          <ul>
            {result.skipped.map((s, i) => (
              <li key={`${s.name}-${String(i)}`}>
                {s.category} / {s.name}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
