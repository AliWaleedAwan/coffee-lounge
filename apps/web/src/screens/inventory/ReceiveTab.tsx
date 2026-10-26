/**
 * Receive stock (RECIPE_INVENTORY.md §7, UI_UX.md J7, Clerk prototype): scan each item,
 * packs convert to base units on screen ("6 × 1 L carton = 6,000 ml"), the line cost gives
 * the unit cost, expiry-tracked items need their date, and Post gives the GRN number. An
 * unknown barcode can be linked to an item on the spot. The scanner is a keyboard that
 * types the code and Enter (P4-4).
 */
import { convertQty, Decimal, packsToBase, unitsFor, type UnitCode } from '@cl/shared';
import { useRef, useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  fetchItem,
  formatQty,
  looksLikeBarcode,
  rupees,
  scanCode,
  useInventoryCommand,
  useInventoryWrite,
  useItems,
  useSuppliers,
  type ItemDetail,
  type PaymentChannel,
  type PostedReceipt,
} from './inventory-api.ts';

const PACKS = /^\d{1,9}(\.\d{1,3})?$/;
const QTY = /^\d{1,10}(\.\d{1,4})?$/;
const COST = /^\d{1,10}(\.\d{1,2})?$/;

interface Line {
  key: number;
  item: ItemDetail;
  /** A pack of the item, or null for a loose quantity. */
  packId: string | null;
  amount: string;
  /** Unit of a loose quantity. */
  uom: UnitCode;
  cost: string;
  lot: string;
  expiry: string;
  /** D-29: the item has no opening count and its shelf was empty. */
  firstStock: boolean;
}

function baseOf(line: Line): Decimal | null {
  const pattern = line.packId ? PACKS : QTY;
  if (!pattern.test(line.amount) || Number(line.amount) <= 0) return null;
  const pack = line.item.packs.find((p) => p.id === line.packId);
  if (line.packId && pack) return packsToBase(new Decimal(line.amount), new Decimal(pack.qtyBase));
  return convertQty(new Decimal(line.amount), line.uom, line.item.baseUom);
}

function problemOf(line: Line, canStart: boolean): string | null {
  const base = baseOf(line);
  if (!base || base.lessThanOrEqualTo(0)) return 'Enter how much arrived';
  if (!COST.test(line.cost)) return 'Enter the line cost';
  if (line.item.trackExpiry && !line.expiry) return 'Expiry date required for this item';
  if (!line.item.stockControlActive && !(canStart && line.firstStock)) {
    return canStart
      ? 'Not counted yet: confirm the shelf was empty'
      : 'Not counted yet: its opening count must be posted first';
  }
  return null;
}

export function ReceiveTab({
  canLink,
  canStartStockControl,
}: {
  canLink: boolean;
  canStartStockControl: boolean;
}) {
  const writes = useWritesAllowed();
  const suppliers = useSuppliers();
  const [lines, setLines] = useState<Line[]>([]);
  const nextKey = useRef(1);
  const [scan, setScan] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [unknown, setUnknown] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState('');
  const [invoiceRef, setInvoiceRef] = useState('');
  const [paidNow, setPaidNow] = useState(false);
  const [channel, setChannel] = useState<PaymentChannel>('cash');
  const [reference, setReference] = useState('');
  const [posted, setPosted] = useState<PostedReceipt | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const post = useInventoryCommand<PostedReceipt>((result) => {
    setPosted(result);
    setLines([]);
  });

  const patch = (key: number, change: Partial<Line>): void => {
    setLines((all) => all.map((l) => (l.key === key ? { ...l, ...change } : l)));
  };

  /**
   * A scan of an item and pack already on the receipt adds one more; anything else adds a
   * line. `packId` null is a loose quantity (a barcode without a pack); `firstPack` takes the
   * item's first active pack (picked by name). Safe for scans in quick succession.
   */
  const addLine = async (itemId: string, packId: string | null, firstPack = false) => {
    const item = await fetchItem(itemId);
    const pack = firstPack ? (item.packs.find((p) => p.isActive)?.id ?? null) : packId;
    setLines((all) => {
      const same = all.find((l) => l.item.id === itemId && l.packId === pack);
      if (same && QTY.test(same.amount)) {
        return all.map((l) =>
          l.key === same.key ? { ...l, amount: new Decimal(l.amount).plus(1).toString() } : l,
        );
      }
      const key = nextKey.current;
      nextKey.current += 1;
      return [
        ...all,
        {
          key,
          item,
          packId: pack,
          amount: '1',
          uom: item.baseUom,
          cost: '',
          lot: '',
          expiry: '',
          firstStock: false,
        },
      ];
    });
  };

  const submitScan = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const text = scan.trim();
    // Cleared at once: a scanner may type the next code before this one is looked up.
    setScan('');
    setScanError(null);
    setUnknown(null);
    setNameQuery('');
    if (!text) return;
    try {
      if (/^[!-~]{1,64}$/.test(text)) {
        const { match } = await scanCode(text);
        if (match) {
          await addLine(match.itemId, match.pack?.id ?? null);
          return;
        }
      }
    } catch (error) {
      setScanError(`${text}: ${writeMessage(error)}`);
      return;
    }
    if (looksLikeBarcode(text)) setUnknown(text);
    else setNameQuery(text);
  };

  const problems = lines.map((l) => problemOf(l, canStartStockControl));
  const total = lines.reduce(
    (sum, l) => (COST.test(l.cost) ? sum.plus(l.cost) : sum),
    new Decimal(0),
  );
  const refOk = !paidNow || reference.length <= 60;
  const canPost =
    writes && lines.length > 0 && problems.every((p) => p === null) && refOk && !post.isPending;

  const submitReceipt = (): void => {
    if (!canPost) return;
    post.mutate({
      path: '/purchase-receipts',
      body: {
        ...(supplierId ? { supplierId } : {}),
        ...(invoiceRef.trim() ? { supplierInvoiceRef: invoiceRef.trim() } : {}),
        paidNow,
        ...(paidNow ? { paymentChannel: channel } : {}),
        ...(paidNow && reference.trim() ? { paymentReference: reference.trim() } : {}),
        startStockControl: [
          ...new Set(lines.filter((l) => !l.item.stockControlActive).map((l) => l.item.id)),
        ],
        lines: lines.map((l) => ({
          itemId: l.item.id,
          ...(l.packId
            ? { packSizeId: l.packId, packQty: l.amount }
            : { qty: l.amount, uom: l.uom }),
          lineCost: l.cost,
          ...(l.item.trackLots && l.lot.trim() ? { lotCode: l.lot.trim() } : {}),
          ...(l.item.trackExpiry && l.expiry ? { expiryDate: l.expiry } : {}),
        })),
      },
    });
  };

  if (posted) {
    return (
      <section className="card stack" aria-labelledby="receipt-posted">
        <h2 id="receipt-posted">Posted · {posted.receiptNo}</h2>
        <p>Stock updated. Receipt total {rupees(posted.totalCost)}.</p>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Received</th>
              <th scope="col">On hand now</th>
              <th scope="col">Unit cost</th>
            </tr>
          </thead>
          <tbody>
            {posted.lines.map((l) => (
              <tr key={l.lineId}>
                <td>{l.name}</td>
                <td>{formatQty(l.qtyBase, l.baseUom)}</td>
                <td>{formatQty(l.onHandAfter, l.baseUom)}</td>
                <td>{l.unitCost ? `Rs ${l.unitCost} / ${l.baseUom}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setPosted(null);
              setSupplierId('');
              setInvoiceRef('');
              setPaidNow(false);
              setReference('');
            }}
          >
            Receive another delivery
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="card stack" aria-labelledby="receive-head">
        <h2 id="receive-head">Receive stock</h2>
        <p className="muted">Scan each item. Pack sizes convert to base units automatically.</p>
        <div className="row">
          <SelectField
            label="Supplier (optional)"
            value={supplierId}
            options={[
              { value: '', label: 'No supplier' },
              ...(suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name })),
            ]}
            onChange={setSupplierId}
          />
          <Field
            label="Supplier invoice no. (optional)"
            maxLength={60}
            value={invoiceRef}
            onChange={(e) => {
              setInvoiceRef(e.target.value);
            }}
          />
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            void submitScan(e);
          }}
          noValidate
        >
          <Field
            ref={scanRef}
            label="Scan or type barcode / name"
            autoComplete="off"
            maxLength={80}
            // A scanner is a keyboard that types fast and presses Enter (P4-4).
            autoFocus
            value={scan}
            onChange={(e) => {
              setScan(e.target.value);
            }}
          />
        </form>
        {scanError ? (
          <div role="alert" className="banner banner-danger">
            {scanError}
          </div>
        ) : null}
        {unknown ? (
          <LinkUnknown
            code={unknown}
            canLink={canLink}
            onLinked={async (itemId, packId) => {
              setUnknown(null);
              await addLine(itemId, packId);
              scanRef.current?.focus();
            }}
            onDismiss={() => {
              setUnknown(null);
              scanRef.current?.focus();
            }}
          />
        ) : null}
        {nameQuery ? (
          <NameMatches
            query={nameQuery}
            onPick={async (itemId) => {
              setNameQuery('');
              await addLine(itemId, null, true);
              scanRef.current?.focus();
            }}
          />
        ) : null}
      </section>

      <section className="card stack" aria-labelledby="receive-lines">
        <h2 id="receive-lines">Lines</h2>
        {lines.length === 0 ? (
          <p className="muted">Scan the first item to start.</p>
        ) : (
          <div className="stack">
            {lines.map((line, i) => (
              <ReceiveLine
                key={line.key}
                line={line}
                problem={problems[i] ?? null}
                canStart={canStartStockControl}
                onChange={(change) => {
                  patch(line.key, change);
                }}
                onRemove={() => {
                  setLines((all) => all.filter((l) => l.key !== line.key));
                }}
              />
            ))}
          </div>
        )}
        <div className="row">
          <CheckField label="Paid now" checked={paidNow} onChange={setPaidNow} />
          {paidNow ? (
            <>
              <SelectField
                label="Paid by"
                value={channel}
                options={[
                  { value: 'cash', label: 'Cash' },
                  { value: 'card', label: 'Card' },
                  { value: 'transfer', label: 'Bank / JazzCash / Easypaisa' },
                ]}
                onChange={(v) => {
                  setChannel(v as PaymentChannel);
                }}
              />
              <Field
                label="Payment reference (optional)"
                hint="Never a card number"
                maxLength={60}
                value={reference}
                onChange={(e) => {
                  setReference(e.target.value);
                }}
              />
            </>
          ) : null}
        </div>
        <div className="section-head">
          <strong>Receipt total: {rupees(total.toFixed(2))}</strong>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={!canPost}
            onClick={submitReceipt}
          >
            Post receipt
          </button>
        </div>
        {post.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(post.error)}
          </div>
        ) : null}
      </section>
    </>
  );
}

function ReceiveLine({
  line,
  problem,
  canStart,
  onChange,
  onRemove,
}: {
  line: Line;
  problem: string | null;
  canStart: boolean;
  onChange: (change: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const { item } = line;
  const active = item.packs.filter((p) => p.isActive);
  const pack = active.find((p) => p.id === line.packId);
  const base = baseOf(line);
  const costOk = COST.test(line.cost);
  const unitCost =
    base && costOk && base.greaterThan(0)
      ? `Rs ${new Decimal(line.cost).dividedBy(base).toFixed(4)} / ${item.baseUom}`
      : '—';
  const conversion =
    base === null
      ? '—'
      : pack
        ? `${line.amount} × ${pack.name} = ${formatQty(base.toFixed(4), item.baseUom)}`
        : `${line.amount} ${line.uom} = ${formatQty(base.toFixed(4), item.baseUom)}`;
  const step = (by: number): void => {
    const next = Math.max(1, Number(line.amount || '0') + by);
    onChange({ amount: String(next) });
  };

  return (
    <fieldset className="card stack" aria-label={`Line: ${item.name}`}>
      <legend className="visually-hidden">{item.name}</legend>
      <div className="section-head">
        <strong>{item.name}</strong>
        <span className="muted">{item.sku}</span>
        <button type="button" className="btn btn-ghost" onClick={onRemove}>
          Remove <span className="visually-hidden">{item.name}</span>
        </button>
      </div>
      <div className="row">
        <SelectField
          label={`Pack for ${item.name}`}
          value={line.packId ?? ''}
          options={[
            ...active.map((p) => ({
              value: p.id,
              label: `${p.name} (${formatQty(p.qtyBase, item.baseUom)})`,
            })),
            { value: '', label: `Loose (${unitsFor(item.baseUom).join(' / ')})` },
          ]}
          onChange={(v) => {
            onChange({ packId: v || null, amount: '1', uom: item.baseUom });
          }}
        />
        {line.packId ? (
          <div className="row" role="group" aria-label={`Packs of ${item.name}`}>
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={`One pack less of ${item.name}`}
              onClick={() => {
                step(-1);
              }}
            >
              −
            </button>
            <Field
              label={`Packs of ${item.name}`}
              inputMode="decimal"
              value={line.amount}
              onChange={(e) => {
                onChange({ amount: e.target.value.trim() });
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={`One pack more of ${item.name}`}
              onClick={() => {
                step(1);
              }}
            >
              +
            </button>
          </div>
        ) : (
          <>
            <Field
              label={`Quantity of ${item.name}`}
              inputMode="decimal"
              value={line.amount}
              onChange={(e) => {
                onChange({ amount: e.target.value.trim() });
              }}
            />
            <SelectField
              label={`Unit for ${item.name}`}
              value={line.uom}
              options={unitsFor(item.baseUom).map((u) => ({ value: u, label: u }))}
              onChange={(v) => {
                onChange({ uom: v as UnitCode });
              }}
            />
          </>
        )}
      </div>
      <p aria-live="polite">{conversion}</p>
      <div className="row">
        <Field
          label={`Line cost for ${item.name} (Rs)`}
          inputMode="decimal"
          value={line.cost}
          error={line.cost && !costOk ? 'Rupees, e.g. 1650 or 1650.50' : null}
          hint={`Unit cost: ${unitCost}`}
          onChange={(e) => {
            onChange({ cost: e.target.value.trim() });
          }}
        />
        {item.trackLots ? (
          <Field
            label={`Lot for ${item.name} (optional)`}
            maxLength={40}
            value={line.lot}
            onChange={(e) => {
              onChange({ lot: e.target.value });
            }}
          />
        ) : null}
        {item.trackExpiry ? (
          <Field
            label={`Expiry date for ${item.name}`}
            type="date"
            value={line.expiry}
            error={line.expiry ? null : 'Required for this item'}
            onChange={(e) => {
              onChange({ expiry: e.target.value });
            }}
          />
        ) : null}
      </div>
      {!item.stockControlActive && canStart ? (
        <CheckField
          label={`The shelf had no ${item.name}: start counting it from this receipt`}
          checked={line.firstStock}
          onChange={(v) => {
            onChange({ firstStock: v });
          }}
        />
      ) : null}
      {problem &&
      problem !== 'Enter the line cost' &&
      problem !== 'Expiry date required for this item' ? (
        <p className="field-error">{problem}</p>
      ) : null}
    </fieldset>
  );
}

/** Items whose name or SKU matches what was typed, to add with one tap. */
function NameMatches({
  query,
  onPick,
}: {
  query: string;
  onPick: (itemId: string) => Promise<void>;
}) {
  const items = useItems({ q: query, category: '', includeArchived: false });
  const list = (items.data?.items ?? []).slice(0, 8);
  return (
    <div className="stack" role="group" aria-label={`Items matching ${query}`}>
      {items.data && list.length === 0 ? <p className="muted">No item matches “{query}”.</p> : null}
      {list.map((item) => (
        <button
          key={item.id}
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void onPick(item.id);
          }}
        >
          Add {item.name} <span className="muted">{item.sku}</span>
        </button>
      ))}
    </div>
  );
}

/** "Link to an item…" for an unknown barcode (`inventory.items_manage`). */
function LinkUnknown({
  code,
  canLink,
  onLinked,
  onDismiss,
}: {
  code: string;
  canLink: boolean;
  onLinked: (itemId: string, packId: string | null) => Promise<void>;
  onDismiss: () => void;
}) {
  const writes = useWritesAllowed();
  const [linking, setLinking] = useState(false);
  const [query, setQuery] = useState('');
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [packId, setPackId] = useState('');
  const items = useItems({ q: query, category: '', includeArchived: false });
  const link = useInventoryWrite(() => {
    if (item) void onLinked(item.id, packId || null);
  });
  const choose = async (id: string): Promise<void> => {
    const detail = await fetchItem(id);
    setItem(detail);
    setPackId(detail.packs.find((p) => p.isActive)?.id ?? '');
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!item || !writes) return;
    link.mutate({
      path: `/inventory/items/${item.id}/barcodes`,
      body: { code, ...(packId ? { packSizeId: packId } : {}) },
    });
  };

  return (
    <div role="alert" className="banner banner-warning stack">
      <span>
        Barcode <strong>{code}</strong> isn’t linked to any item yet.
      </span>
      {!linking ? (
        <div className="row">
          {canLink ? (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setLinking(true);
              }}
            >
              Link to an item…
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      ) : item ? (
        <form className="row" onSubmit={submit} noValidate>
          <span>
            Link to <strong>{item.name}</strong>
          </span>
          <SelectField
            label="Pack it is printed on"
            value={packId}
            options={[
              ...item.packs
                .filter((p) => p.isActive)
                .map((p) => ({
                  value: p.id,
                  label: `${p.name} (${formatQty(p.qtyBase, item.baseUom)})`,
                })),
              { value: '', label: `No pack: one ${item.baseUom}` },
            ]}
            onChange={setPackId}
          />
          <button type="submit" className="btn btn-primary" disabled={!writes || link.isPending}>
            Link and add
          </button>
          <button type="button" className="btn btn-ghost" onClick={onDismiss}>
            Cancel
          </button>
          {link.isError ? <span className="field-error">{writeMessage(link.error)}</span> : null}
        </form>
      ) : (
        <div className="stack">
          <Field
            label="Find the item"
            autoComplete="off"
            maxLength={80}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {query.trim()
            ? (items.data?.items ?? []).slice(0, 8).map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    void choose(i.id);
                  }}
                >
                  {i.name} <span className="muted">{i.sku}</span>
                </button>
              ))
            : null}
        </div>
      )}
    </div>
  );
}
