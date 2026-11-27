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
type Size = 'normal' | 'wide' | 'big' | 'x3' | 'x4';

export interface Logo {
  width: number;
  height: number;
  data: string;
}

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
  logo?: Logo;
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
  scaleX: number;
  scaleY: number;
}

const KEY = ['settings', 'receipt-design'] as const;
const PATH = '/settings/receipt-design';
const MAX_BLOCKS = 10;

const SIZES: Size[] = ['normal', 'wide', 'big', 'x3', 'x4'];
const LOGO_WIDTH = 256;
const ALIGNS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
];

/** A−/A+ like a word processor: the printer's own text sizes, smallest to largest. */
function SizeStepper({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Size;
  onChange: (size: Size) => void;
}) {
  const at = SIZES.indexOf(value);
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="stepper" role="group" aria-label={label}>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Smaller: ${label}`}
          disabled={at <= 0}
          onClick={() => {
            onChange(SIZES[at - 1] ?? value);
          }}
        >
          A−
        </button>
        <span aria-live="polite">{at + 1}</span>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Larger: ${label}`}
          disabled={at >= SIZES.length - 1}
          onClick={() => {
            onChange(SIZES[at + 1] ?? value);
          }}
        >
          A+
        </button>
      </div>
    </div>
  );
}

/** The picture as the thermal printer can print it: black or white dots, at most 256 across. */
async function toLogo(file: File): Promise<Logo> {
  const bitmap = await createImageBitmap(file);
  const width = Math.min(LOGO_WIDTH, bitmap.width) & ~7;
  const height = Math.min(300, Math.max(1, Math.round((bitmap.height * width) / bitmap.width)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot read pictures');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  const px = ctx.getImageData(0, 0, width, height).data;
  const rowBytes = width / 8;
  const bits = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const light = 0.3 * (px[i] ?? 0) + 0.59 * (px[i + 1] ?? 0) + 0.11 * (px[i + 2] ?? 0);
      if (light < 128)
        bits[y * rowBytes + (x >> 3)] = (bits[y * rowBytes + (x >> 3)] ?? 0) | (0x80 >> (x & 7));
    }
  }
  return { width, height, data: btoa(String.fromCharCode(...bits)) };
}

function logoUrl(logo: Logo): string {
  const canvas = document.createElement('canvas');
  canvas.width = logo.width;
  canvas.height = logo.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const bits = atob(logo.data);
  const rowBytes = Math.ceil(logo.width / 8);
  ctx.fillStyle = '#000';
  for (let y = 0; y < logo.height; y++) {
    for (let x = 0; x < logo.width; x++) {
      if (bits.charCodeAt(y * rowBytes + (x >> 3)) & (0x80 >> (x & 7))) ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas.toDataURL();
}

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
          <div className="field">
            <label htmlFor="rd-logo">Logo</label>
            <input
              id="rd-logo"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void toLogo(file).then((logo) => {
                  change({ logo });
                });
              }}
            />
            {layout.logo ? (
              <div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setDone(null);
                    setLayout(
                      Object.fromEntries(
                        Object.entries(layout).filter(([k]) => k !== 'logo'),
                      ) as unknown as ReceiptLayout,
                    );
                  }}
                >
                  Remove logo
                </button>
              </div>
            ) : null}
          </div>
          <SizeStepper
            label="Shop name size"
            value={layout.shopNameSize}
            onChange={(shopNameSize) => {
              change({ shopNameSize });
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
          <p className="muted">
            Every receipt ends with a fixed line: Powered by Eerel. www.eerel.com 03284147552
          </p>
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
        {preview.data ? (
          <Paper width={preview.data.width} lines={preview.data.lines} logo={layout.logo} />
        ) : null}
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
            <SizeStepper
              label="Size"
              value={b.size}
              onChange={(size) => {
                set(i, { size });
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
function Paper({
  width,
  lines,
  logo,
}: {
  width: number;
  lines: PreviewLine[];
  logo: Logo | undefined;
}) {
  return (
    <div
      className="receipt-paper"
      role="img"
      aria-label="Receipt preview"
      style={{ width: `calc(${String(width)}ch + 2 * var(--space-3))` }}
    >
      {logo ? <img className="receipt-logo" src={logoUrl(logo)} alt="Logo" /> : null}
      {lines.map((l, i) => (
        <div
          key={i}
          className="receipt-paper-line"
          style={{
            textAlign: l.align,
            fontWeight: l.bold ? 700 : 400,
            // Half as many characters, each twice as wide: the line still spans the paper.
            width: `${String(Math.floor(width / l.scaleX))}ch`,
            transform: `scale(${String(l.scaleX)}, ${String(l.scaleY)})`,
            transformOrigin: 'top left',
            marginBottom: l.scaleY > 1 ? `${String((l.scaleY - 1) * 1.25)}em` : undefined,
          }}
        >
          {l.text || ' '}
        </div>
      ))}
    </div>
  );
}
