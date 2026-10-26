/**
 * One inventory item: its settings (RECIPE_INVENTORY.md §3), pack sizes in the base unit
 * (§1), barcodes (one active owner per code, §7) and archiving (D-31). Pack units are
 * limited to the item's own dimension, so a pack can never mix mass and volume (AT-32).
 */
import { convertQty, Decimal, unitsFor, type BaseUnit, type UnitCode } from '@cl/shared';
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  formatQty,
  MOVEMENT_TYPES,
  rupees,
  useInventoryWrite,
  useItem,
  useMovements,
  type ItemDetail,
} from './inventory-api.ts';

const QTY = /^\d{1,10}(\.\d{1,4})?$/;
const BASE_UNITS: readonly { value: BaseUnit; label: string }[] = [
  { value: 'ml', label: 'ml (liquids)' },
  { value: 'g', label: 'g (weighed)' },
  { value: 'pcs', label: 'pcs (counted)' },
];

export function InventoryItemEditor({
  itemId,
  linkCode,
  canManage,
  onCreated,
  onClose,
}: {
  itemId: string | null;
  linkCode: string | null;
  canManage: boolean;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const item = useItem(itemId);

  if (itemId !== null && !item.data) {
    return (
      <section className="card stack" aria-label="Inventory item">
        {item.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(item.error)}
          </div>
        ) : (
          <Loading label="Loading the item" />
        )}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to inventory
        </button>
      </section>
    );
  }
  const data = item.data ?? null;
  const editable = canManage && !data?.archived;

  return (
    <>
      <section className="card stack" aria-labelledby="inventory-item">
        <div className="section-head">
          <h2 id="inventory-item">{data ? data.name : 'New inventory item'}</h2>
          {data?.archived ? <span className="chip chip-warning">Archived</span> : null}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Back to inventory
          </button>
        </div>
        {linkCode && !data && canManage ? (
          <div role="status" className="banner banner-info">
            Barcode <strong>{linkCode}</strong> will be linked once the item is saved.
          </div>
        ) : null}
        <ItemDetails
          key={data?.id ?? 'new'}
          item={data}
          editable={canManage && !data?.archived}
          onCreated={onCreated}
        />
      </section>
      {data ? (
        <>
          <Stock item={data} />
          {data.trackLots ? <Lots item={data} /> : null}
          <Packs item={data} editable={editable} />
          <Barcodes item={data} editable={editable} linkCode={linkCode} />
          <History item={data} />
          {editable ? <Archive item={data} onArchived={onClose} /> : null}
        </>
      ) : null}
    </>
  );
}

function ItemDetails({
  item,
  editable,
  onCreated,
}: {
  item: ItemDetail | null;
  editable: boolean;
  onCreated: (id: string) => void;
}) {
  const writes = useWritesAllowed();
  const [sku, setSku] = useState(item?.sku ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [category, setCategory] = useState(item?.category ?? '');
  const [baseUom, setBaseUom] = useState<BaseUnit>(item?.baseUom ?? 'ml');
  const [trackLots, setTrackLots] = useState(item?.trackLots ?? false);
  const [trackExpiry, setTrackExpiry] = useState(item?.trackExpiry ?? false);
  const [low, setLow] = useState(trimQty(item?.lowThreshold));
  const [overstock, setOverstock] = useState(trimQty(item?.overstockThreshold));
  const [nearDays, setNearDays] = useState(item?.nearExpiryDays?.toString() ?? '');
  // P4-3: lots switched on for stock already on hand need that stock's expiry.
  const [existingExpiry, setExistingExpiry] = useState('');
  const startsLots = item !== null && !item.trackLots && trackLots && Number(item.onHand) > 0;
  const needsExisting = startsLots && trackExpiry;
  const onHandText = item ? formatQty(item.onHand, item.baseUom) : '';
  const [saved, setSaved] = useState(false);
  const save = useInventoryWrite<{ id: string }>((result) => {
    if (item) setSaved(true);
    else onCreated(result.id);
  });

  const lowOk = low === '' || QTY.test(low);
  const overOk =
    overstock === '' ||
    (QTY.test(overstock) && (low === '' || !lowOk || new Decimal(overstock).greaterThan(low)));
  const daysOk = nearDays === '' || /^\d{1,3}$/.test(nearDays);
  const skuOk = item !== null || /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(sku.trim());
  const valid =
    skuOk &&
    name.trim().length > 0 &&
    lowOk &&
    overOk &&
    daysOk &&
    (!needsExisting || existingExpiry !== '');

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || save.isPending) return;
    setSaved(false);
    const settings = {
      name: name.trim(),
      category: category.trim() || null,
      baseUom,
      trackLots,
      trackExpiry: trackLots && trackExpiry,
      lowThreshold: low || null,
      overstockThreshold: overstock || null,
      nearExpiryDays: trackLots && trackExpiry && nearDays ? Number(nearDays) : null,
    };
    if (item) {
      save.mutate({
        path: `/inventory/items/${item.id}`,
        method: 'PATCH',
        body: {
          expectedVersion: item.version,
          ...settings,
          ...(needsExisting ? { existingStockExpiry: existingExpiry } : {}),
        },
      });
    } else {
      save.mutate({ path: '/inventory/items', body: { sku: sku.trim(), ...settings } });
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <fieldset className="stack" disabled={!editable}>
        <legend className="visually-hidden">Item details</legend>
        <div className="row">
          {item ? (
            <Field label="SKU" value={item.sku} readOnly />
          ) : (
            <Field
              label="SKU"
              hint="Your own short code, e.g. MILK-WHOLE. It cannot change later."
              maxLength={40}
              autoComplete="off"
              value={sku}
              error={sku && !skuOk ? 'Letters, digits, dot, dash or underscore' : null}
              onChange={(e) => {
                setSku(e.target.value);
              }}
            />
          )}
          <Field
            label="Name"
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Field
            label="Category (optional)"
            maxLength={40}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
            }}
          />
        </div>
        <div className="row">
          <SelectField
            label="Base unit"
            value={baseUom}
            options={BASE_UNITS}
            onChange={(v) => {
              setBaseUom(v as BaseUnit);
            }}
          />
          <Field
            label={`Low stock at (${baseUom})`}
            inputMode="decimal"
            value={low}
            error={lowOk ? null : 'A quantity such as 500 or 2.5'}
            onChange={(e) => {
              setLow(e.target.value.trim());
            }}
          />
          <Field
            label={`Overstock at (${baseUom})`}
            inputMode="decimal"
            value={overstock}
            error={overOk ? null : 'Above the low level, e.g. 20000'}
            onChange={(e) => {
              setOverstock(e.target.value.trim());
            }}
          />
        </div>
        <div className="checks">
          <CheckField
            label="Track lots (receipts create lots, used earliest expiry first)"
            checked={trackLots}
            onChange={setTrackLots}
          />
          <CheckField
            label="Track expiry dates"
            checked={trackLots && trackExpiry}
            disabled={!trackLots}
            onChange={setTrackExpiry}
          />
        </div>
        {trackLots && trackExpiry ? (
          <Field
            label="Warn this many days before expiry"
            inputMode="numeric"
            value={nearDays}
            error={daysOk ? null : 'Whole days, e.g. 2'}
            onChange={(e) => {
              setNearDays(e.target.value.trim());
            }}
          />
        ) : null}
        {needsExisting ? (
          <Field
            label={`Expiry date of the ${onHandText} on hand`}
            hint="What is on the shelf now becomes one lot with this date."
            type="date"
            value={existingExpiry}
            error={existingExpiry ? null : 'Required to switch lots on'}
            onChange={(e) => {
              setExistingExpiry(e.target.value);
            }}
          />
        ) : null}
        {item?.trackLots && !trackLots && Number(item.onHand) > 0 ? (
          <p className="field-hint">
            Switching lots off keeps the quantity on hand but forgets which lot it is in.
          </p>
        ) : null}
        <p className="field-hint">
          Recommended: lots and expiry for milk, cream and bakery; neither for cups and sachets.
          {item ? ' The base unit cannot change once packs, stock or recipes use it.' : ''}
        </p>
        {editable ? (
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!valid || !writes || save.isPending}
            >
              {item ? 'Save changes' : 'Add item'}
            </button>
          </div>
        ) : null}
      </fieldset>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(save.error)}
        </div>
      ) : null}
      {saved ? (
        <div role="status" className="banner banner-success">
          Saved.
        </div>
      ) : null}
    </form>
  );
}

/** "5000.0000" → "5000"; null → "". */
function trimQty(value: string | null | undefined): string {
  if (!value) return '';
  return new Decimal(value).toString();
}

function Stock({ item }: { item: ItemDetail }) {
  return (
    <section className="card stack" aria-labelledby="item-stock">
      <h2 id="item-stock">Stock</h2>
      {item.stockControlActive ? (
        <dl className="kv">
          <dt>On hand</dt>
          <dd>{formatQty(item.onHand, item.baseUom)}</dd>
          <dt>Reserved for accepted orders</dt>
          <dd>{formatQty(item.reserved, item.baseUom)}</dd>
        </dl>
      ) : (
        <p className="muted">
          Not counted yet: stock control starts when its opening count is posted.
        </p>
      )}
    </section>
  );
}

/** Lots with stock, earliest expiry first: the order pickups use them (FEFO). */
function Lots({ item }: { item: ItemDetail }) {
  return (
    <section className="card stack" aria-labelledby="item-lots">
      <h2 id="item-lots">Lots</h2>
      {item.lots.length === 0 ? (
        <p className="muted">No stock in lots.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Lot</th>
              <th scope="col">Expiry</th>
              <th scope="col">Left</th>
              <th scope="col">From</th>
            </tr>
          </thead>
          <tbody>
            {item.lots.map((lot) => (
              <tr key={lot.id}>
                <td>{lot.lotCode ?? '—'}</td>
                <td>
                  {lot.expiryDate ?? 'Unknown'}
                  {lot.expired ? (
                    <>
                      {' '}
                      <span className="chip chip-danger">Expired</span>
                    </>
                  ) : lot.nearExpiry ? (
                    <>
                      {' '}
                      <span className="chip chip-warning">Use first</span>
                    </>
                  ) : null}
                  {lot.status === 'quarantined' ? (
                    <>
                      {' '}
                      <span className="chip chip-warning">On hold</span>
                    </>
                  ) : null}
                </td>
                <td>
                  {formatQty(lot.qtyRemaining, item.baseUom)}
                  <div className="muted">of {formatQty(lot.qtyReceived, item.baseUom)}</div>
                </td>
                <td>{lot.receiptNo ?? ORIGIN[lot.origin]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {item.lots.some((l) => l.expired) ? (
        <p className="field-error">
          Expired lots do not count as available. Record them as waste when they are thrown away.
        </p>
      ) : null}
    </section>
  );
}

const ORIGIN = {
  receipt: 'Receipt',
  opening: 'Stock on hand when lots began',
  found: 'Found at pickup',
  count: 'Stock count',
} as const;

function Packs({ item, editable }: { item: ItemDetail; editable: boolean }) {
  const writes = useWritesAllowed();
  const units = unitsFor(item.baseUom);
  const [name, setName] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<UnitCode>(units[units.length - 1] ?? item.baseUom);
  const add = useInventoryWrite(() => {
    setName('');
    setQty('');
  });
  const toggle = useInventoryWrite();
  const qtyOk = QTY.test(qty) && Number(qty) > 0;
  const preview = qtyOk ? convertQty(new Decimal(qty), unit, item.baseUom) : null;

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!name.trim() || !qtyOk || !writes) return;
    add.mutate({
      path: `/inventory/items/${item.id}/pack-sizes`,
      body: { name: name.trim(), qty, uom: unit },
    });
  };

  return (
    <section className="card stack" aria-labelledby="item-packs">
      <h2 id="item-packs">Pack sizes</h2>
      {item.packs.length === 0 ? (
        <p className="muted">No packs yet. A pack is how you buy it, e.g. “1 L carton”.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Pack</th>
              <th scope="col">Holds</th>
              {editable ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {item.packs.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {p.isActive ? null : (
                    <>
                      {' '}
                      <span className="chip chip-warning">Not used</span>
                    </>
                  )}
                </td>
                <td>{formatQty(p.qtyBase, item.baseUom)}</td>
                {editable ? (
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || toggle.isPending}
                      onClick={() => {
                        toggle.mutate({
                          path: `/inventory/pack-sizes/${p.id}`,
                          method: 'PATCH',
                          body: { expectedVersion: p.version, isActive: !p.isActive },
                        });
                      }}
                    >
                      {p.isActive ? 'Stop using' : 'Use again'}{' '}
                      <span className="visually-hidden">{p.name}</span>
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable ? (
        <form className="row" onSubmit={submit} noValidate>
          <Field
            label="Pack name"
            maxLength={60}
            placeholder="1 L carton"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Field
            label="Holds"
            inputMode="decimal"
            value={qty}
            error={qty && !qtyOk ? 'A quantity such as 1 or 0.5' : null}
            hint={preview ? `= ${formatQty(preview.toFixed(4), item.baseUom)}` : undefined}
            onChange={(e) => {
              setQty(e.target.value.trim());
            }}
          />
          <SelectField
            label="Unit"
            value={unit}
            options={units.map((u) => ({ value: u, label: u }))}
            onChange={(v) => {
              setUnit(v as UnitCode);
            }}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!name.trim() || !qtyOk || !writes || add.isPending}
          >
            Add pack
          </button>
        </form>
      ) : null}
      {add.isError || toggle.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(add.error ?? toggle.error)}
        </div>
      ) : null}
    </section>
  );
}

function Barcodes({
  item,
  editable,
  linkCode,
}: {
  item: ItemDetail;
  editable: boolean;
  linkCode: string | null;
}) {
  const writes = useWritesAllowed();
  const active = item.packs.filter((p) => p.isActive);
  const [code, setCode] = useState(
    linkCode && !item.barcodes.some((b) => b.code === linkCode) ? linkCode : '',
  );
  // The first active pack until the clerk picks one ('' = no pack), also once a pack is
  // added to an item that had none.
  const [chosen, setChosen] = useState<string | null>(null);
  const packId =
    chosen !== null && (chosen === '' || active.some((p) => p.id === chosen))
      ? chosen
      : (active[0]?.id ?? '');
  const add = useInventoryWrite(() => {
    setCode('');
  });
  const remove = useInventoryWrite();
  const codeOk = /^[!-~]{1,64}$/.test(code.trim());

  // A scanner types the code and Enter, which submits this form (P4-4).
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!codeOk || !writes || add.isPending) return;
    add.mutate({
      path: `/inventory/items/${item.id}/barcodes`,
      body: { code: code.trim(), ...(packId ? { packSizeId: packId } : {}) },
    });
  };

  return (
    <section className="card stack" aria-labelledby="item-barcodes">
      <h2 id="item-barcodes">Barcodes</h2>
      {item.barcodes.length === 0 ? (
        <p className="muted">No barcodes yet.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Barcode</th>
              <th scope="col">Pack</th>
              {editable ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {item.barcodes.map((b) => (
              <tr key={b.id}>
                <td>{b.code}</td>
                <td>{b.packName ?? `One ${item.baseUom}`}</td>
                {editable ? (
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || remove.isPending}
                      onClick={() => {
                        remove.mutate({
                          path: `/inventory/barcodes/${b.id}/deactivate`,
                          body: { expectedVersion: b.version },
                        });
                      }}
                    >
                      Remove <span className="visually-hidden">{b.code}</span>
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable ? (
        <form className="row" onSubmit={submit} noValidate>
          <Field
            label="Scan or type a barcode"
            autoComplete="off"
            maxLength={64}
            // Opened to link an unknown code: the code is ready, the pack is the choice.
            autoFocus={linkCode !== null}
            value={code}
            error={code && !codeOk ? 'No spaces: the characters under the bars' : null}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
          <SelectField
            label="Pack it is printed on"
            value={packId}
            options={[
              ...active.map((p) => ({
                value: p.id,
                label: `${p.name} (${formatQty(p.qtyBase, item.baseUom)})`,
              })),
              { value: '', label: `No pack: one ${item.baseUom}` },
            ]}
            onChange={setChosen}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!codeOk || !writes || add.isPending}
          >
            Link barcode
          </button>
        </form>
      ) : null}
      {add.isError || remove.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(add.error ?? remove.error)}
        </div>
      ) : null}
    </section>
  );
}

function Archive({ item, onArchived }: { item: ItemDetail; onArchived: () => void }) {
  const writes = useWritesAllowed();
  const [asking, setAsking] = useState(false);
  const archive = useInventoryWrite(onArchived);
  return (
    <section className="card stack" aria-labelledby="item-archive">
      <h2 id="item-archive">Archive</h2>
      <p className="muted">
        An archived item disappears from lists and frees its barcodes. Allowed only with nothing on
        hand and no active recipe using it. History stays.
      </p>
      <div className="row">
        {asking ? (
          <>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!writes || archive.isPending}
              onClick={() => {
                archive.mutate({
                  path: `/inventory/items/${item.id}/archive`,
                  body: { expectedVersion: item.version },
                });
              }}
            >
              Archive {item.name}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setAsking(false);
              }}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes}
            onClick={() => {
              setAsking(true);
            }}
          >
            Archive this item…
          </button>
        )}
      </div>
      {archive.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(archive.error)}
        </div>
      ) : null}
    </section>
  );
}

/** Every movement of the item, newest first, with the on-hand after it (step 4.7). */
function History({ item }: { item: ItemDetail }) {
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const movements = useMovements(item.id, { type, from, to });
  const list = movements.data?.items ?? [];
  const showValue = list.some((m) => m.valueDelta !== null);
  return (
    <section className="card stack" aria-labelledby="item-history">
      <h2 id="item-history">Movement history</h2>
      <div className="row">
        <SelectField
          label="Kind"
          value={type}
          options={[
            { value: '', label: 'All' },
            ...Object.entries(MOVEMENT_TYPES)
              .filter(([k]) => k !== 'rounding')
              .map(([value, label]) => ({ value, label })),
          ]}
          onChange={setType}
        />
        <Field
          label="From"
          type="date"
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
          }}
        />
        <Field
          label="To"
          type="date"
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
          }}
        />
      </div>
      {movements.isPending ? <Loading label="Loading movements" /> : null}
      {movements.data && list.length === 0 ? <p className="muted">No movements.</p> : null}
      {list.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Change</th>
              <th scope="col">On hand after</th>
              {showValue ? <th scope="col">Value</th> : null}
              <th scope="col">By</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.businessDate}
                  <div className="muted">
                    {new Date(m.occurredAt).toLocaleTimeString('en-GB', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </td>
                <td>
                  {MOVEMENT_TYPES[m.type]}
                  <div className="muted">
                    {[
                      m.source,
                      m.reasonCode,
                      ...m.lots.map(
                        (l) => `lot ${l.lotCode ?? '—'}${l.expired ? ' (expired)' : ''}`,
                      ),
                      ...m.flags.map((f) => f.replaceAll('_', ' ')),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {m.note ? <div className="muted">{m.note}</div> : null}
                </td>
                <td>
                  {Number(m.qtyDelta) > 0 ? '+' : ''}
                  {formatQty(m.qtyDelta, item.baseUom)}
                </td>
                <td>{formatQty(m.balanceAfter, item.baseUom)}</td>
                {showValue ? <td>{m.valueDelta === null ? '—' : rupees(m.valueDelta)}</td> : null}
                <td>{m.actor ?? 'System'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
