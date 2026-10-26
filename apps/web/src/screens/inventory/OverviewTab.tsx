/**
 * Inventory overview (UI_UX.md §6 "Overview & alerts"; RECIPE_INVENTORY.md §10): what
 * needs attention now. Open alerts first (a balance mismatch on top), then out of stock,
 * low, short of what accepted orders need, lots to use first and expired lots, overstock,
 * and how far stock control has come (D-29). An item opens in place.
 */
import { useState } from 'react';
import { Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import { InventoryItemEditor } from './InventoryItemEditor.tsx';
import {
  formatQty,
  rupees,
  useInventoryWrite,
  useOverview,
  type InventoryAlert,
  type LotLine,
  type StockLine,
} from './inventory-api.ts';

function alertTitle(a: InventoryAlert): string {
  const item = a.itemName ?? 'An item';
  const lot = a.lotCode ? ` lot ${a.lotCode}` : '';
  switch (a.kind) {
    case 'low':
      return `Low: ${item}`;
    case 'zero':
      return `Out: ${item}`;
    case 'near_expiry':
      return `Use first: ${item}${lot}, expires ${a.expiryDate ?? ''}`;
    case 'expired':
      return 'usedBy' in a.detail
        ? `Expired lot went into an order: ${item}${lot}`
        : `Expired: ${item}${lot}`;
    case 'overstock':
      return `Overstock: ${item}`;
    case 'reservation_shortfall':
      return `Less than accepted orders need: ${item}`;
    case 'stale_reservation':
      return `Orders reserved over 12 hours: ${item}`;
    case 'balance_mismatch':
      return `Stock record does not add up: ${item}`;
    case 'found_stock':
      return `Stock found at a pickup: ${item}`;
  }
}

export function OverviewTab({ canManage }: { canManage: boolean }) {
  const overview = useOverview();
  const [openItem, setOpenItem] = useState<string | null>(null);
  if (openItem) {
    return (
      <InventoryItemEditor
        itemId={openItem}
        linkCode={null}
        canManage={canManage}
        onCreated={() => undefined}
        onClose={() => {
          setOpenItem(null);
        }}
      />
    );
  }
  const o = overview.data;
  if (!o) {
    return overview.isError ? (
      <div role="alert" className="banner banner-danger">
        {writeMessage(overview.error)}
      </div>
    ) : (
      <Loading label="Loading the overview" />
    );
  }
  const notCounted = o.stockControl.total - o.stockControl.counted;
  return (
    <>
      <div className="grid-tiles">
        <div className="card">
          <div className="muted">Open alerts</div>
          <div className="tile-value">{o.alerts.length}</div>
        </div>
        <div className="card">
          <div className="muted">Items in stock control</div>
          <div className="tile-value">
            {o.stockControl.counted} of {o.stockControl.total}
          </div>
        </div>
        {o.stockValue !== null ? (
          <div className="card">
            <div className="muted">Stock value</div>
            <div className="tile-value">{rupees(o.stockValue)}</div>
          </div>
        ) : null}
      </div>
      {notCounted > 0 ? (
        <p className="muted">
          {notCounted} item{notCounted === 1 ? '' : 's'} not counted yet: drinks using them stay
          untracked until they are (D-29).
        </p>
      ) : null}
      <Alerts alerts={o.alerts} onOpen={setOpenItem} />
      <StockList title="Out of stock" rows={o.out} onOpen={setOpenItem} />
      <StockList title="Low" rows={o.low} onOpen={setOpenItem} threshold="Low at" />
      <StockList title="Short of accepted orders" rows={o.short} onOpen={setOpenItem} />
      <LotList
        title="Expired lots"
        hint="Not counted as available. Record them as waste when they are thrown away."
        rows={o.expired}
        onOpen={setOpenItem}
      />
      <LotList
        title="Use first"
        hint="These lots expire soon."
        rows={o.expiring}
        onOpen={setOpenItem}
      />
      <StockList
        title="Overstock"
        rows={o.overstock}
        onOpen={setOpenItem}
        threshold="Overstock at"
      />
    </>
  );
}

function Alerts({ alerts, onOpen }: { alerts: InventoryAlert[]; onOpen: (id: string) => void }) {
  return (
    <section className="card stack" aria-labelledby="alerts-head">
      <h2 id="alerts-head">Needs attention</h2>
      {alerts.length === 0 ? <p className="muted">Nothing needs attention.</p> : null}
      {alerts.map((a) => (
        <AlertRow key={a.id} alert={a} onOpen={onOpen} />
      ))}
    </section>
  );
}

function AlertRow({ alert, onOpen }: { alert: InventoryAlert; onOpen: (id: string) => void }) {
  const writes = useWritesAllowed();
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const seen = useInventoryWrite();
  const close = useInventoryWrite();
  const critical = alert.kind === 'balance_mismatch';
  return (
    <div
      className={`stack banner ${critical ? 'banner-danger' : alert.state === 'acknowledged' ? 'banner-info' : 'banner-warning'}`}
      role="group"
      aria-label={alertTitle(alert)}
    >
      <div className="section-head">
        <strong>{alertTitle(alert)}</strong>
        {alert.state === 'acknowledged' ? <span className="chip">Seen</span> : null}
        <span className="muted">{new Date(alert.createdAt).toLocaleString('en-GB')}</span>
      </div>
      <div className="row">
        {alert.itemId ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (alert.itemId) onOpen(alert.itemId);
            }}
          >
            Open item
          </button>
        ) : null}
        {alert.state === 'open' ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || seen.isPending}
            onClick={() => {
              seen.mutate({ path: `/inventory/alerts/${alert.id}/acknowledge` });
            }}
          >
            Seen
          </button>
        ) : null}
        {alert.manual ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setClosing(!closing);
            }}
          >
            Close…
          </button>
        ) : null}
      </div>
      {closing ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3 && writes) {
              close.mutate({
                path: `/inventory/alerts/${alert.id}/close`,
                body: { note: note.trim() },
              });
            }
          }}
          noValidate
        >
          <Field
            label="What was found or done"
            maxLength={200}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={note.trim().length < 3 || !writes || close.isPending}
          >
            Close alert
          </button>
        </form>
      ) : null}
      {seen.isError || close.isError ? (
        <span className="field-error">{writeMessage(seen.error ?? close.error)}</span>
      ) : null}
    </div>
  );
}

function StockList({
  title,
  rows,
  onOpen,
  threshold,
}: {
  title: string;
  rows: StockLine[];
  onOpen: (id: string) => void;
  threshold?: string;
}) {
  if (rows.length === 0) return null;
  const id = `stock-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="card stack" aria-labelledby={id}>
      <h2 id={id}>
        {title} · {rows.length}
      </h2>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">On hand</th>
            <th scope="col">Reserved</th>
            <th scope="col">Available</th>
            {threshold ? <th scope="col">{threshold}</th> : null}
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemId}>
              <td>
                {r.name}
                <div className="muted">{r.sku}</div>
              </td>
              <td>{formatQty(r.onHand, r.baseUom)}</td>
              <td>{formatQty(r.reserved, r.baseUom)}</td>
              <td>{formatQty(r.available, r.baseUom)}</td>
              {threshold ? <td>{r.threshold ? formatQty(r.threshold, r.baseUom) : '—'}</td> : null}
              <td>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    onOpen(r.itemId);
                  }}
                >
                  Open <span className="visually-hidden">{r.name}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function LotList({
  title,
  hint,
  rows,
  onOpen,
}: {
  title: string;
  hint: string;
  rows: LotLine[];
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  const id = `lots-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="card stack" aria-labelledby={id}>
      <h2 id={id}>
        {title} · {rows.length}
      </h2>
      <p className="muted">{hint}</p>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Lot</th>
            <th scope="col">Expiry</th>
            <th scope="col">Left</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.lotId}>
              <td>{r.name}</td>
              <td>{r.lotCode ?? '—'}</td>
              <td>{r.expiryDate}</td>
              <td>{formatQty(r.qtyRemaining, r.baseUom)}</td>
              <td>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    onOpen(r.itemId);
                  }}
                >
                  Open <span className="visually-hidden">{r.name}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
