/**
 * Receipt design (owner): on the left, text blocks above and below the bill and a few
 * switches; on the right, the receipt as the printer will print it. The preview is the
 * server's own renderer on a sample bill at the printer's width, asked for again a moment
 * after each change, so the screen cannot drift from the paper. The shop name, address and
 * phone stay in Settings → Branding.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { CheckField, SelectField, TextAreaField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';

type Align = 'left' | 'center' | 'right';
type Size = 'normal' | 'wide' | 'big';

export interface ReceiptBlock {
  text: string;
  align: Align;
  bold: boolean;
  size: Size;
}

export interface ReceiptLayout {
  header: ReceiptBlock[];
  footer: ReceiptBlock[];
  shopNameSize: Size;
  showContact: boolean;
  showCashier: boolean;
}

interface Design {
  version: number;
  saved: boolean;
  layout: ReceiptLayout;
  width: number;
}

interface PreviewLine {
  text: string;
  align: Align;
  bold: boolean;
  wide: boolean;
  tall: boolean;
}

const KEY = ['settings', 'receipt-design'] as const;
const PATH = '/settings/receipt-design';
const MAX_BLOCKS = 10;

const SIZES = [
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide (double width)' },
  { value: 'big', label: 'Big (double width and height)' },
];
const ALIGNS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

const newBlock = (): ReceiptBlock => ({ text: '', align: 'center', bold: false, size: 'normal' });

/** The layout a moment after the last change: one preview per pause in typing. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return settled;
}

export function ReceiptDesignScreen() {
  const design = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<Design>(PATH, { signal }),
  });
  // Kept here: a save reloads the design, which starts the form afresh.
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <h1>Receipt design</h1>
      {design.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(design.error)}
        </div>
      ) : null}
      {design.data ? (
        <Designer key={design.data.version} design={design.data} done={done} setDone={setDone} />
      ) : (
        <p className="muted">Loading…</p>
      )}
    </>
  );
}

function Designer({
  design,
  done,
  setDone,
}: {
  design: Design;
  done: string | null;
  setDone: (message: string | null) => void;
}) {
  const writes = useWritesAllowed();
  const client = useQueryClient();
  const [layout, setLayout] = useState<ReceiptLayout>(design.layout);
  const settled = useSettled(layout, 300);
  const preview = useQuery({
    queryKey: [...KEY, 'preview', settled],
    queryFn: ({ signal }) =>
      api<{ width: number; lines: PreviewLine[] }>(`${PATH}/preview`, {
        method: 'POST',
        body: { layout: settled },
        signal,
      }),
    placeholderData: (previous) => previous,
  });
  const save = useMutation({
    mutationFn: (next: ReceiptLayout | null) =>
      api<Design>(PATH, {
        method: 'PUT',
        body: { expectedVersion: design.version, layout: next },
      }),
    onSuccess: (_result, next) => {
      setDone(next ? 'Saved. The next receipt prints like this.' : 'Back to the standard receipt.');
    },
    onSettled: () => client.invalidateQueries({ queryKey: KEY }),
  });

  const change = (next: Partial<ReceiptLayout>): void => {
    setDone(null);
    setLayout({ ...layout, ...next });
  };
  const changed = JSON.stringify(layout) !== JSON.stringify(design.layout);

  return (
    <div className="receipt-designer">
      <div className="stack">
        <section className="card stack" aria-labelledby="rd-top">
          <h2 id="rd-top">Top of the receipt</h2>
          <SelectField
            label="Shop name size"
            value={layout.shopNameSize}
            options={SIZES}
            onChange={(v) => {
              change({ shopNameSize: v as Size });
            }}
          />
          <CheckField
            label="Print the address and phone"
            checked={layout.showContact}
            onChange={(v) => {
              change({ showContact: v });
            }}
          />
          <p className="muted">
            The shop name, address and phone are changed in Settings → Branding.
          </p>
          <Blocks
            title="Text under the shop name"
            name="Top text"
            blocks={layout.header}
            onChange={(header) => {
              change({ header });
            }}
          />
        </section>
        <section className="card stack" aria-labelledby="rd-bill">
          <h2 id="rd-bill">The bill</h2>
          <CheckField
            label="Print the cashier's name"
            checked={layout.showCashier}
            onChange={(v) => {
              change({ showCashier: v });
            }}
          />
          <p className="muted">
            Items, prices, totals and payments always print, so every receipt adds up.
          </p>
        </section>
        <section className="card stack" aria-labelledby="rd-bottom">
          <h2 id="rd-bottom">Bottom of the receipt</h2>
          <Blocks
            title="Text after the totals"
            name="Bottom text"
            blocks={layout.footer}
            onChange={(footer) => {
              change({ footer });
            }}
          />
        </section>
        {save.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(save.error)}
          </div>
        ) : null}
        {done ? (
          <div role="status" className="banner banner-success">
            {done}
          </div>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!writes || save.isPending || (!changed && design.saved)}
            onClick={() => {
              save.mutate(layout);
            }}
          >
            {save.isPending ? 'Saving…' : 'Save receipt design'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!changed}
            onClick={() => {
              setLayout(design.layout);
            }}
          >
            Undo changes
          </button>
          {design.saved ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes || save.isPending}
              onClick={() => {
                save.mutate(null);
              }}
            >
              Back to the standard receipt
            </button>
          ) : null}
        </div>
      </div>
      <aside className="receipt-preview-pane" aria-labelledby="rd-preview">
        <h2 id="rd-preview">How it prints</h2>
        <p className="muted">
          A sample bill, {design.width} characters a line ({design.width >= 48 ? '80' : '58'} mm
          paper).
        </p>
        {preview.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(preview.error)}
          </div>
        ) : null}
        {preview.data ? <Paper width={preview.data.width} lines={preview.data.lines} /> : null}
      </aside>
    </div>
  );
}

function Blocks({
  title,
  name,
  blocks,
  onChange,
}: {
  title: string;
  /** What each block is called on screen: "Top text 1". */
  name: string;
  blocks: ReceiptBlock[];
  onChange: (blocks: ReceiptBlock[]) => void;
}) {
  const set = (i: number, next: Partial<ReceiptBlock>): void => {
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...next } : b)));
  };
  const move = (i: number, by: -1 | 1): void => {
    const next = [...blocks];
    const [b] = next.splice(i, 1);
    if (b) next.splice(i + by, 0, b);
    onChange(next);
  };
  return (
    <fieldset className="stack">
      <legend>{title}</legend>
      {blocks.length === 0 ? <p className="muted">Nothing here yet.</p> : null}
      {blocks.map((b, i) => (
        <div key={i} className="receipt-block stack">
          <TextAreaField
            label={`${name} ${String(i + 1)}`}
            hint="Each line prints on its own line; long lines wrap."
            maxLength={400}
            value={b.text}
            onChange={(text) => {
              set(i, { text });
            }}
          />
          <div className="row">
            <SelectField
              label="Align"
              value={b.align}
              options={ALIGNS}
              onChange={(v) => {
                set(i, { align: v as Align });
              }}
            />
            <SelectField
              label="Size"
              value={b.size}
              options={SIZES}
              onChange={(v) => {
                set(i, { size: v as Size });
              }}
            />
            <CheckField
              label="Bold"
              checked={b.bold}
              onChange={(v) => {
                set(i, { bold: v });
              }}
            />
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={i === 0}
              onClick={() => {
                move(i, -1);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={i === blocks.length - 1}
              onClick={() => {
                move(i, 1);
              }}
            >
              Move down
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                onChange(blocks.filter((_, j) => j !== i));
              }}
            >
              Remove {name.toLowerCase()} {i + 1}
            </button>
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={blocks.length >= MAX_BLOCKS}
          onClick={() => {
            onChange([...blocks, newBlock()]);
          }}
        >
          Add {name.toLowerCase()}
        </button>
      </div>
    </fieldset>
  );
}

/** The paper: a monospace column `width` characters wide; wide text takes two cells a character. */
function Paper({ width, lines }: { width: number; lines: PreviewLine[] }) {
  return (
    <div
      className="receipt-paper"
      role="img"
      aria-label="Receipt preview"
      style={{ width: `calc(${String(width)}ch + 2 * var(--space-3))` }}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          className="receipt-paper-line"
          style={{
            textAlign: l.align,
            fontWeight: l.bold ? 700 : 400,
            // Half as many characters, each twice as wide: the line still spans the paper.
            width: `${String(l.wide ? Math.floor(width / 2) : width)}ch`,
            transform: `scale(${l.wide ? 2 : 1}, ${l.tall ? 2 : 1})`,
            transformOrigin: 'top left',
            marginBottom: l.tall ? '1.25em' : undefined,
          }}
        >
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}
