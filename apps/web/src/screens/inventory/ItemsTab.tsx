/**
 * Inventory items (RECIPE_INVENTORY.md §1–§3, §7; UI_UX.md §6 "Lookup / scan").
 * One box takes a scan or a typed name: a scanner types the code and Enter (P4-4), which
 * opens the item the code names; an unknown code offers to link it to an item. Editing
 * needs `inventory.items_manage`; the server checks every write.
 */
import { useRef, useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import { InventoryItemEditor } from './InventoryItemEditor.tsx';
import {
  formatQty,
  looksLikeBarcode,
  scanCode,
  useItems,
  type ItemSummary,
} from './inventory-api.ts';

/**
 * Which item is open (an existing one, or null for a new one), with the unknown code it
 * was opened to link, if any; null for the list.
 */
type Open = { id: string | null; linkCode: string | null } | null;

export function ItemsTab({ canManage }: { canManage: boolean }) {
  const writes = useWritesAllowed();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [open, setOpen] = useState<Open>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const items = useItems({ q: search, category, includeArchived });

  const close = (): void => {
    setOpen(null);
    setSearch('');
    searchRef.current?.focus();
  };

  if (open) {
    return (
      <InventoryItemEditor
        key={open.id ?? 'new'}
        itemId={open.id}
        linkCode={open.linkCode}
        canManage={canManage}
        onCreated={(id) => {
          setOpen({ id, linkCode: open.linkCode });
        }}
        onClose={close}
      />
    );
  }

  // Enter in the box: a scan (or a typed code or SKU) opens its item; an unknown code
  // that reads as a barcode offers "Link to an item"; anything else just filters.
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const text = search.trim();
    setScanError(null);
    setUnknownCode(null);
    if (!/^[!-~]{1,64}$/.test(text)) return;
    try {
      const { match } = await scanCode(text);
      if (match) {
        setOpen({ id: match.itemId, linkCode: null });
        return;
      }
    } catch (error) {
      setScanError(writeMessage(error));
      return;
    }
    const bySku = items.data?.items.find((i) => i.sku === text.toUpperCase());
    if (bySku) setOpen({ id: bySku.id, linkCode: null });
    else if (looksLikeBarcode(text)) {
      setUnknownCode(text);
      setSearch('');
    }
  };

  const list = items.data?.items ?? [];
  return (
    <>
      {canManage ? (
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes}
            onClick={() => {
              setOpen({ id: null, linkCode: unknownCode });
              setUnknownCode(null);
            }}
          >
            New item
          </button>
        </div>
      ) : null}
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          void submit(e);
        }}
        noValidate
      >
        <Field
          ref={searchRef}
          label="Scan or type barcode / name"
          hint="Scan a barcode, or type part of a name or SKU and press Enter."
          // A scanner is a keyboard that types fast and presses Enter (P4-4).
          autoFocus
          autoComplete="off"
          maxLength={80}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <SelectField
          label="Category"
          value={category}
          options={[
            { value: '', label: 'All categories' },
            ...(items.data?.categories ?? []).map((c) => ({ value: c, label: c })),
          ]}
          onChange={setCategory}
        />
        <CheckField label="Show archived" checked={includeArchived} onChange={setIncludeArchived} />
      </form>
      {scanError ? (
        <div role="alert" className="banner banner-danger">
          {scanError}
        </div>
      ) : null}
      {unknownCode ? (
        <div role="alert" className="banner banner-warning stack">
          <span>
            Barcode <strong>{unknownCode}</strong> isn’t linked to any item yet.
            {canManage ? ' Choose the item it belongs to below, or add a new item.' : ''}
          </span>
          <div className="row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setUnknownCode(null);
                searchRef.current?.focus();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      {items.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(items.error)}
        </div>
      ) : null}
      {items.isPending ? <Loading label="Loading items" /> : null}
      {items.data && list.length === 0 ? (
        <p className="muted">
          {search || category
            ? 'No item matches.'
            : 'No inventory items yet. Add milk, beans and cups first (RECIPE_INVENTORY.md §2).'}
        </p>
      ) : null}
      {list.length > 0 ? (
        <ItemTable
          items={list}
          linkCode={canManage ? unknownCode : null}
          onOpen={(item) => {
            setOpen({ id: item.id, linkCode: canManage ? unknownCode : null });
            setUnknownCode(null);
          }}
        />
      ) : null}
    </>
  );
}

function ItemTable({
  items,
  linkCode,
  onOpen,
}: {
  items: ItemSummary[];
  linkCode: string | null;
  onOpen: (item: ItemSummary) => void;
}) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Category</th>
          <th scope="col">On hand</th>
          <th scope="col">Tracking</th>
          <th scope="col">Packs · barcodes</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              {item.name}
              <div className="muted">{item.sku}</div>
            </td>
            <td>{item.category ?? '—'}</td>
            <td>
              {item.stockControlActive ? (
                formatQty(item.onHand, item.baseUom)
              ) : (
                <span className="chip chip-info">Not counted yet</span>
              )}
            </td>
            <td>
              {item.archived ? <span className="chip chip-warning">Archived</span> : null}
              {item.trackLots ? <span className="chip">Lots</span> : null}
              {item.trackExpiry ? <span className="chip">Expiry</span> : null}
              {!item.archived && !item.trackLots ? <span className="muted">—</span> : null}
            </td>
            <td>
              {item.packCount} · {item.barcodeCount}
            </td>
            <td>
              <button
                type="button"
                className={linkCode ? 'btn btn-secondary' : 'btn btn-ghost'}
                onClick={() => {
                  onOpen(item);
                }}
              >
                {linkCode ? 'Link here' : 'Open'}{' '}
                <span className="visually-hidden">{item.name}</span>
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
