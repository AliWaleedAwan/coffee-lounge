/**
 * Template import (docs/templates/README.md; AT-82). Choose the file, preview it, then
 * import it. The preview lists every problem with its row and column and what each row
 * will create or change; nothing is saved until Import, and Import is offered only for a
 * file whose preview had no problem. Files go in the weekly order of the README.
 */
import { useState } from 'react';
import { SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  previewImport,
  useImportTemplates,
  useInventoryCommand,
  type ImportResult,
} from './inventory-api.ts';

const ACTION = { create: 'New', update: 'Changed', unchanged: 'No change' } as const;

export function ImportTab() {
  const writes = useWritesAllowed();
  const templates = useImportTemplates();
  const [key, setKey] = useState('');
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const apply = useInventoryCommand<ImportResult>((result) => {
    setDone(result);
    setPreview(null);
  });
  const list = templates.data?.items ?? [];
  const template = list.find((t) => t.key === key);

  const reset = (): void => {
    setPreview(null);
    setDone(null);
    setError(null);
  };
  const runPreview = async (): Promise<void> => {
    if (!template || csv === null) return;
    reset();
    setPreviewing(true);
    try {
      setPreview(await previewImport(template.key, csv));
    } catch (e) {
      setError(writeMessage(e));
    } finally {
      setPreviewing(false);
    }
  };

  if (templates.isPending) return <Loading label="Loading the templates" />;
  return (
    <section className="card stack" aria-labelledby="import-head">
      <h2 id="import-head">Import</h2>
      <p className="muted">
        Fill in a template in Excel or Google Sheets, save it as CSV UTF-8, then preview and import
        it here. Replace the example rows: SKUs starting with EX- are refused. Go in the order
        below; a file is imported completely or not at all.
      </p>
      <SelectField
        label="Template"
        value={key}
        options={[
          { value: '', label: 'Choose…' },
          ...list.map((t, i) => ({
            value: t.key,
            label: `${String(i + 1)}. ${t.title} (${t.file})${t.allowed ? '' : ` · needs ${t.permission}`}`,
          })),
        ]}
        onChange={(v) => {
          setKey(v);
          reset();
        }}
      />
      {template ? (
        <>
          <p className="field-hint">
            First row exactly: <code>{template.columns.join(',')}</code>
          </p>
          {!template.allowed ? (
            <div role="status" className="banner banner-warning">
              Importing {template.file} needs {template.permission}. Ask the owner.
            </div>
          ) : (
            <div className="field">
              <label htmlFor="import-file">CSV file</label>
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  reset();
                  setCsv(null);
                  setFileName(file?.name ?? '');
                  if (file) {
                    void file.text().then(setCsv);
                  }
                }}
              />
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={csv === null || previewing || !template.allowed}
              onClick={() => {
                void runPreview();
              }}
            >
              Preview
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                !preview || preview.errors.length > 0 || csv === null || !writes || apply.isPending
              }
              onClick={() => {
                if (csv !== null)
                  apply.mutate({ path: `/imports/${template.key}/apply`, body: { csv } });
              }}
            >
              Import
            </button>
          </div>
        </>
      ) : null}
      {error || apply.isError ? (
        <div role="alert" className="banner banner-danger">
          {error ?? writeMessage(apply.error)}
        </div>
      ) : null}
      {done ? (
        <div role="status" className="banner banner-success">
          Imported {done.file}: {done.summary.create} new, {done.summary.update} changed,{' '}
          {done.summary.unchanged} unchanged.
          {done.template === 'recipes'
            ? ' Recipes are drafts: check and activate them in Menu & recipes.'
            : ''}
        </div>
      ) : null}
      {preview ? <Preview result={preview} fileName={fileName} /> : null}
    </section>
  );
}

function Preview({ result, fileName }: { result: ImportResult; fileName: string }) {
  if (result.errors.length > 0) {
    return (
      <div className="stack">
        <div role="alert" className="banner banner-danger">
          {result.errors.length} problem{result.errors.length === 1 ? '' : 's'} in{' '}
          {fileName || result.file}. Nothing will be imported until they are fixed.
        </div>
        <table className="data" aria-label="Problems">
          <thead>
            <tr>
              <th scope="col">Row</th>
              <th scope="col">Column</th>
              <th scope="col">Problem</th>
            </tr>
          </thead>
          <tbody>
            {result.errors.map((e, i) => (
              <tr key={`${String(e.row)}-${String(i)}`}>
                <td>{e.row}</td>
                <td>{e.column ?? '—'}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div className="stack">
      <div role="status" className="banner banner-info">
        {result.rows} rows, no problems: {result.summary.create} new, {result.summary.update}{' '}
        changed, {result.summary.unchanged} unchanged. Nothing is saved until you press Import.
      </div>
      <table className="data" aria-label="What the import does">
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">What</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {result.changes.map((c, i) => (
            <tr key={`${String(c.row)}-${String(i)}`}>
              <td>{c.row}</td>
              <td>{c.what}</td>
              <td>{ACTION[c.action]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
