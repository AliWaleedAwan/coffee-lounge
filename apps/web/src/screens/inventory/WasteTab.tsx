/**
 * Waste (RECIPE_INVENTORY.md §8, AT-109): scan or find the item, say how much and why,
 * and for lot-tracked items which lot (earliest expiry first unless one is chosen, e.g.
 * the expired one). Valued at the average by the server. Prepared drinks that are remade
 * or spilled after pickup are recorded on the order line (void), not here. Today's waste
 * is listed below, values only for those who may see costs.
 */
import { convertQty, Decimal, unitsFor, type UnitCode } from '@cl/shared';
import { useRef, useState, type SubmitEvent } from 'react';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  fetchItem,
  formatQty,
  rupees,
  scanCode,
  useInventoryCommand,
  useItems,
  useWaste,
  WASTE_REASONS,
  type ItemDetail,
} from './inventory-api.ts';

const QTY = /^\d{1,10}(\.\d{1,4})?$/;
const KIND = {
  ingredient: 'Ingredient',
  expired_lot: 'Expired lot',
  prepared_item: 'Prepared item',
  failed_delivery: 'Failed delivery',
} as const;

export function WasteTab({ canRecord }: { canRecord: boolean }) {
  return (
    <>
      {canRecord ? <RecordWaste /> : null}
      <TodaysWaste />
    </>
  );
}

function RecordWaste() {
  const writes = useWritesAllowed();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [uom, setUom] = useState<UnitCode>('ml');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [lotId, setLotId] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const matches = useItems({ q: query, category: '', includeArchived: false });

  const choose = async (id: string): Promise<void> => {
    const detail = await fetchItem(id);
    setItem(detail);
    setUom(detail.baseUom);
    setQty('');
    setLotId('');
    setReason('');
    setNote('');
    setQuery('');
  };
  const record = useInventoryCommand<{ qtyBase: string }>((result) => {
    if (item) setDone(`Recorded: ${formatQty(result.qtyBase, item.baseUom)} of ${item.name}.`);
    setItem(null);
    setSearch('');
    searchRef.current?.focus();
  });

  const submitSearch = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const text = search.trim();
    setSearch('');
    setScanError(null);
    setDone(null);
    if (!text) return;
    try {
      if (/^[!-~]{1,64}$/.test(text)) {
        const { match } = await scanCode(text);
        if (match) {
          await choose(match.itemId);
          return;
        }
      }
    } catch (error) {
      setScanError(writeMessage(error));
      return;
    }
    setQuery(text);
  };

  const qtyOk = QTY.test(qty) && Number(qty) > 0;
  const base = item && qtyOk ? convertQty(new Decimal(qty), uom, item.baseUom) : null;
  const lot = item?.lots.find((l) => l.id === lotId);
  const lotOk = !lot || !base || base.lessThanOrEqualTo(lot.qtyRemaining);
  const valid =
    item !== null && qtyOk && reason !== '' && (reason !== 'other' || note.trim() !== '') && lotOk;

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!item || !valid || !writes) return;
    record.mutate({
      path: '/inventory/waste',
      body: {
        itemId: item.id,
        qty,
        uom,
        reasonCode: reason,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(lotId ? { lotId } : {}),
      },
    });
  };

  return (
    <section className="card stack" aria-labelledby="waste-head">
      <h2 id="waste-head">Record waste</h2>
      <p className="muted">
        Ingredients thrown away. A drink remade or spilled after pickup is voided on its order
        instead.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          void submitSearch(e);
        }}
        noValidate
      >
        <Field
          ref={searchRef}
          label="Scan or type barcode / name"
          autoComplete="off"
          maxLength={80}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
      </form>
      {scanError ? (
        <div role="alert" className="banner banner-danger">
          {scanError}
        </div>
      ) : null}
      {query ? (
        <div className="stack" role="group" aria-label={`Items matching ${query}`}>
          {matches.data && matches.data.items.length === 0 ? (
            <p className="muted">No item matches “{query}”.</p>
          ) : null}
          {(matches.data?.items ?? []).slice(0, 8).map((i) => (
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
          ))}
        </div>
      ) : null}
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {item ? (
        <form className="stack" onSubmit={submit} noValidate aria-label={`Waste of ${item.name}`}>
          <strong>
            {item.name} · {formatQty(item.onHand, item.baseUom)} on hand
          </strong>
          <div className="row">
            <Field
              label="How much"
              inputMode="decimal"
              value={qty}
              error={qty && !qtyOk ? 'A quantity such as 300 or 0.5' : null}
              onChange={(e) => {
                setQty(e.target.value.trim());
              }}
            />
            <SelectField
              label="Unit"
              value={uom}
              options={unitsFor(item.baseUom).map((u) => ({ value: u, label: u }))}
              onChange={(v) => {
                setUom(v as UnitCode);
              }}
            />
            <SelectField
              label="Reason"
              value={reason}
              options={[{ value: '', label: 'Choose…' }, ...WASTE_REASONS]}
              onChange={setReason}
            />
          </div>
          {item.trackLots ? (
            <SelectField
              label="Lot"
              value={lotId}
              options={[
                { value: '', label: 'Earliest expiry first' },
                ...item.lots.map((l) => ({
                  value: l.id,
                  label: `${l.lotCode ?? 'No code'} · ${l.expiryDate ?? 'unknown expiry'}${
                    l.expired ? ' · EXPIRED' : ''
                  } · ${formatQty(l.qtyRemaining, item.baseUom)} left`,
                })),
              ]}
              onChange={(v) => {
                setLotId(v);
                if (item.lots.find((l) => l.id === v)?.expired) setReason('expired');
              }}
            />
          ) : null}
          {lot && !lotOk ? (
            <p className="field-error">
              That lot holds only {formatQty(lot.qtyRemaining, item.baseUom)}.
            </p>
          ) : null}
          <Field
            label={reason === 'other' ? 'What happened' : 'Note (optional)'}
            maxLength={200}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!valid || !writes || record.isPending}
            >
              Record waste
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setItem(null);
              }}
            >
              Cancel
            </button>
          </div>
          {record.isError ? (
            <div role="alert" className="banner banner-danger">
              {writeMessage(record.error)}
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function TodaysWaste() {
  const waste = useWaste();
  const list = waste.data?.items ?? [];
  const showValue = list.some((w) => w.value !== null);
  return (
    <section className="card stack" aria-labelledby="waste-today">
      <h2 id="waste-today">Waste today{waste.data ? ` · ${waste.data.date}` : ''}</h2>
      {waste.isPending ? <Loading label="Loading waste" /> : null}
      {waste.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(waste.error)}
        </div>
      ) : null}
      {waste.data && list.length === 0 ? <p className="muted">Nothing wasted yet today.</p> : null}
      {list.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">How much</th>
              <th scope="col">Why</th>
              <th scope="col">By</th>
              {showValue ? <th scope="col">Value</th> : null}
            </tr>
          </thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id}>
                <td>
                  {w.name}
                  <div className="muted">
                    {KIND[w.kind]}
                    {w.lotCode ? ` · lot ${w.lotCode}` : ''}
                  </div>
                </td>
                <td>{w.baseUom ? formatQty(w.qty, w.baseUom) : String(Number(w.qty))}</td>
                <td>
                  {WASTE_REASONS.find((r) => r.value === w.reasonCode)?.label ?? w.reasonCode}
                  {w.note ? <div className="muted">{w.note}</div> : null}
                </td>
                <td>{w.recordedBy}</td>
                {showValue ? <td>{w.value === null ? '—' : rupees(w.value)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
