/**
 * New product from a scanned barcode (Phase 8 step 8.2): one form for what used to take
 * several screens. Whoever may not set prices saves it not on sale, for a manager (P8-3).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SubmitEvent } from 'react';
import { api, API_BASE, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useSignedIn } from '../Shell.tsx';

const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const QTY = /^\d{1,10}(\.\d{1,4})?$/;

export function ProductForm({
  barcode,
  onCreated,
  onCancel,
}: {
  barcode: string;
  onCreated: (itemId: string) => void;
  onCancel: () => void;
}) {
  const permissions = permissionSet(useSignedIn());
  const canPrice = permissions.has('menu.price_change');
  const canPhoto = permissions.has('menu.manage');
  const canStock =
    permissions.has('inventory.opening_balance') || permissions.has('inventory.receive');
  const writes = useWritesAllowed();
  const client = useQueryClient();
  const menu = useQuery({
    queryKey: ['menu', 'product-categories'],
    queryFn: ({ signal }) =>
      api<{ categories: { id: string; name: string }[] }>('/menu', { signal }),
  });
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [price, setPrice] = useState('');
  const [low, setLow] = useState('');
  const [hasExpiry, setHasExpiry] = useState(false);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [expiry, setExpiry] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  // The same key on a retry: a dropped connection cannot create it twice.
  const key = useRef(crypto.randomUUID());

  const create = useMutation({
    mutationFn: async () => {
      const made = await api<{ itemId: string; menuItemId: string }>('/products', {
        method: 'POST',
        idempotencyKey: key.current,
        body: {
          barcode,
          name: name.trim(),
          categoryId,
          ...(canPrice && price ? { price } : {}),
          ...(low ? { lowThreshold: low } : {}),
          trackExpiry: hasExpiry,
          ...(qty
            ? { opening: { qty, unitCost: cost, ...(expiry ? { expiryDate: expiry } : {}) } }
            : {}),
        },
      });
      if (photo) {
        await fetch(`${API_BASE}/menu/items/${made.menuItemId}/photo`, {
          method: 'PUT',
          headers: { 'content-type': photo.type, 'x-cl-request': '1' },
          body: photo,
        });
      }
      return made;
    },
    onSuccess: async (made) => {
      await client.invalidateQueries({ queryKey: ['inventory'] });
      await client.invalidateQueries({ queryKey: ['menu'] });
      onCreated(made.itemId);
    },
  });

  const stockOk =
    qty === '' || (QTY.test(qty) && AMOUNT.test(cost) && (!hasExpiry || expiry !== ''));
  const ready =
    writes &&
    !create.isPending &&
    name.trim() !== '' &&
    categoryId !== '' &&
    (price === '' || AMOUNT.test(price)) &&
    (low === '' || QTY.test(low)) &&
    stockOk;
  const submit = (e: SubmitEvent): void => {
    e.preventDefault();
    if (ready) create.mutate();
  };

  return (
    <form className="card stack" noValidate onSubmit={submit} aria-label="New product">
      <div className="section-head">
        <h2>New product</h2>
        <span className="chip chip-info">Barcode {barcode}</span>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Back to inventory
        </button>
      </div>
      <div className="row">
        <Field
          label="Name"
          autoFocus
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <SelectField
          label="Menu category"
          value={categoryId}
          options={[
            { value: '', label: 'Choose…' },
            ...(menu.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name })),
          ]}
          onChange={setCategoryId}
        />
      </div>
      <div className="row">
        {canPrice ? (
          <Field
            label="Selling price (Rs)"
            inputMode="decimal"
            value={price}
            hint="Empty: saved, but not on sale yet"
            onChange={(e) => {
              setPrice(e.target.value.trim());
            }}
          />
        ) : null}
        <Field
          label="Warn when stock falls to"
          inputMode="decimal"
          value={low}
          onChange={(e) => {
            setLow(e.target.value.trim());
          }}
        />
      </div>
      {canPrice ? null : (
        <p className="muted">A manager sets the selling price; until then it is not on sale.</p>
      )}
      <CheckField
        label="This product has an expiry date"
        checked={hasExpiry}
        onChange={setHasExpiry}
      />
      {canStock ? (
        <fieldset className="stack">
          <legend>Stock you have now (optional)</legend>
          <div className="row">
            <Field
              label="Quantity"
              inputMode="decimal"
              value={qty}
              onChange={(e) => {
                setQty(e.target.value.trim());
              }}
            />
            <Field
              label="Cost of one (Rs)"
              inputMode="decimal"
              value={cost}
              onChange={(e) => {
                setCost(e.target.value.trim());
              }}
            />
            {hasExpiry ? (
              <Field
                label="Expiry date"
                type="date"
                value={expiry}
                onChange={(e) => {
                  setExpiry(e.target.value);
                }}
              />
            ) : null}
          </div>
          <p className="muted">
            Without a quantity, stock tracking starts after the first delivery: receive it, then
            activate the recipe under Menu → Recipes.
          </p>
        </fieldset>
      ) : null}
      {canPhoto ? (
        <div className="field">
          <label htmlFor="product-photo">Photo (optional)</label>
          <input
            id="product-photo"
            type="file"
            accept="image/jpeg,image/png"
            onChange={(e) => {
              setPhoto(e.target.files?.[0] ?? null);
            }}
          />
        </div>
      ) : null}
      {create.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(create.error)}
        </div>
      ) : null}
      <div>
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          Save product
        </button>
      </div>
    </form>
  );
}
