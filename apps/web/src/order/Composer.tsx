/**
 * Order composer (UI_UX.md §7): pick items from the menu, choose size and choices, then
 * send the cart. Waiters see the menu and the order side by side (`Composer`); the guest
 * app shows the menu and the order as separate screens (`MenuPicker`, `CartPanel`,
 * step 3.11). The parent owns the cart and the sending. Lines the server could not make
 * are flagged in place and the cart is kept (AT-26).
 */
import { useId, useState, type ReactNode } from 'react';
import {
  cartTotal,
  choiceProblems,
  rupees,
  unitPrice,
  type CartLine,
  type MenuCategory,
  type MenuItem,
} from './cart.ts';

export interface ComposerProps {
  categories: MenuCategory[];
  cart: CartLine[];
  onCartChange: (lines: CartLine[]) => void;
  onSend: () => void;
  sending: boolean;
  sendLabel: string;
  /** Problems with the last send, shown above the button. */
  error?: ReactNode;
  /** 1-based positions of cart lines the server could not make. */
  flagged?: number[];
  disabled?: boolean;
}

export function Composer(props: ComposerProps) {
  return (
    <div className="composer">
      <MenuPicker
        categories={props.categories}
        disabled={props.disabled}
        onAdd={(line) => {
          props.onCartChange([...props.cart, line]);
        }}
      />
      <CartPanel {...props} />
    </div>
  );
}

/** Menu categories and items; an item opens its sheet (size, choices, note, quantity). */
export function MenuPicker({
  categories,
  onAdd,
  disabled,
  photoBase,
}: {
  categories: MenuCategory[];
  onAdd: (line: CartLine) => void;
  disabled?: boolean | undefined;
  /** The API base item photos are fetched from; without it no photos are shown. */
  photoBase?: string;
}) {
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [category, setCategory] = useState(categories[0]?.id ?? '');
  const shown = categories.find((c) => c.id === category) ?? categories[0];
  return (
    <section className="stack" aria-label="Menu">
      <div className="tabs" role="tablist" aria-label="Menu categories">
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === shown?.id}
            onClick={() => {
              setCategory(c.id);
              setOpen(null);
            }}
          >
            {c.name}
          </button>
        ))}
      </div>
      {open ? (
        <ItemSheet
          item={open}
          {...(photoBase ? { photoBase } : {})}
          onCancel={() => {
            setOpen(null);
          }}
          onAdd={(line) => {
            onAdd(line);
            setOpen(null);
          }}
        />
      ) : (
        <ul className="menu-list" role="list">
          {(shown?.items ?? []).map((item) => {
            const available = item.variants.some((v) => v.available);
            const cheapest = item.variants.reduce<string | null>(
              (low, v) =>
                low === null || Number(v.promotionPrice ?? v.price) < Number(low)
                  ? (v.promotionPrice ?? v.price)
                  : low,
              null,
            );
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="menu-row"
                  disabled={!available || disabled}
                  onClick={() => {
                    setOpen(item);
                  }}
                >
                  {photoBase && item.imageUrl ? (
                    <img
                      className="menu-row-photo"
                      src={`${photoBase}/${item.imageUrl}`}
                      alt=""
                      loading="lazy"
                    />
                  ) : null}
                  <span className="menu-row-name">{item.name}</span>
                  {item.dietaryTags.length > 0 ? (
                    <span className="muted">{item.dietaryTags.join(' · ')}</span>
                  ) : null}
                  <span className="menu-row-price">
                    {available
                      ? cheapest
                        ? `${item.variants.length > 1 ? 'from ' : ''}${rupees(cheapest)}`
                        : ''
                      : 'Unavailable right now'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The order being put together: lines with − / +, the total and the send button. */
export function CartPanel({
  cart,
  onCartChange,
  onSend,
  sending,
  sendLabel,
  error,
  flagged = [],
  disabled,
  title = 'Order',
  note,
}: Omit<ComposerProps, 'categories'> & { title?: string; note?: ReactNode }) {
  return (
    <section className="card stack cart" aria-label={title}>
      <h2>{title}</h2>
      {cart.length === 0 ? <p className="muted">Nothing added yet.</p> : null}
      <ul className="stack stack-tight" role="list">
        {cart.map((l, i) => (
          <li
            key={l.key}
            className={flagged.includes(i + 1) ? 'cart-line cart-line-flagged' : 'cart-line'}
          >
            <div>
              <strong>
                {l.itemName} · {l.variantName}
              </strong>
              {l.optionNames.length > 0 ? (
                <div className="muted">{l.optionNames.join(', ')}</div>
              ) : null}
              {l.notes ? <div className="muted">“{l.notes}”</div> : null}
              {flagged.includes(i + 1) ? (
                <div className="field-error">Not enough stock for this</div>
              ) : null}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`One less ${l.itemName}`}
                disabled={sending}
                onClick={() => {
                  onCartChange(
                    l.qty > 1
                      ? cart.map((x) => (x.key === l.key ? { ...x, qty: x.qty - 1 } : x))
                      : cart.filter((x) => x.key !== l.key),
                  );
                }}
              >
                −
              </button>
              <span aria-label={`${String(l.qty)} ${l.itemName}`}>{l.qty}</span>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={`One more ${l.itemName}`}
                disabled={sending || l.qty >= 20}
                onClick={() => {
                  onCartChange(cart.map((x) => (x.key === l.key ? { ...x, qty: x.qty + 1 } : x)));
                }}
              >
                +
              </button>
              <span className="cart-price">{rupees(cartTotal([l]))}</span>
            </div>
          </li>
        ))}
      </ul>
      {cart.length > 0 ? (
        <p>
          <strong>Total {rupees(cartTotal(cart))}</strong>
        </p>
      ) : null}
      {note}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={cart.length === 0 || sending || disabled}
        onClick={onSend}
      >
        {sending ? 'Sending…' : sendLabel}
      </button>
    </section>
  );
}

function ItemSheet({
  item,
  onAdd,
  onCancel,
  photoBase,
}: {
  item: MenuItem;
  photoBase?: string;
  onAdd: (line: CartLine) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const sizes = item.variants.filter((v) => v.available);
  const [variantId, setVariantId] = useState(
    (sizes.find((v) => v.isDefault) ?? sizes[0])?.id ?? '',
  );
  const [chosen, setChosen] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [qty, setQty] = useState(1);
  const variant = item.variants.find((v) => v.id === variantId);
  const problems = choiceProblems(item.modifierGroups, chosen);
  const price = variant ? unitPrice(variant, item.modifierGroups, chosen) : '0.00';

  return (
    <div className="card stack" role="group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{item.name}</h2>
      {photoBase && item.imageUrl ? (
        <img
          className="menu-sheet-photo"
          src={`${photoBase}/${item.imageUrl}`}
          alt={`Photo of ${item.name}`}
        />
      ) : null}
      {item.description ? <p className="muted">{item.description}</p> : null}
      {item.dietaryTags.length > 0 ? <p>{item.dietaryTags.join(' · ')}</p> : null}
      {sizes.length > 1 ? (
        <fieldset className="stack">
          <legend>Size</legend>
          <div className="checks">
            {sizes.map((v) => (
              <label key={v.id} className="check">
                <input
                  type="radio"
                  name={`${id}-size`}
                  checked={v.id === variantId}
                  onChange={() => {
                    setVariantId(v.id);
                  }}
                />
                {v.name} · {rupees(v.promotionPrice ?? v.price)}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {item.modifierGroups.map((g) => {
        const picked = chosen.filter((c) => g.options.some((o) => o.id === c));
        return (
          <fieldset key={g.id} className="stack">
            <legend>
              {g.name}
              <span className="muted">
                {g.minSelect > 0
                  ? ` (choose ${g.minSelect === g.maxSelect ? String(g.minSelect) : `${String(g.minSelect)}–${String(g.maxSelect)}`})`
                  : g.maxSelect > 1
                    ? ` (up to ${String(g.maxSelect)})`
                    : ' (optional)'}
              </span>
            </legend>
            <div className="checks">
              {g.options.map((o) => (
                <label key={o.id} className="check">
                  <input
                    type={g.maxSelect === 1 ? 'radio' : 'checkbox'}
                    name={`${id}-${g.id}`}
                    checked={chosen.includes(o.id)}
                    disabled={
                      !o.available ||
                      (!chosen.includes(o.id) && g.maxSelect > 1 && picked.length >= g.maxSelect)
                    }
                    onChange={(e) => {
                      const others = chosen.filter(
                        (c) => !(g.maxSelect === 1 && g.options.some((x) => x.id === c)),
                      );
                      setChosen(
                        e.target.checked
                          ? [...others.filter((c) => c !== o.id), o.id]
                          : chosen.filter((c) => c !== o.id),
                      );
                    }}
                  />
                  {o.name}
                  {o.priceDelta !== '0.00' ? ` +${rupees(o.priceDelta)}` : ''}
                  {o.available ? '' : ' (unavailable)'}
                </label>
              ))}
              {g.maxSelect === 1 && g.minSelect === 0 && picked.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setChosen(chosen.filter((c) => !picked.includes(c)));
                  }}
                >
                  No {g.name.toLowerCase()} choice
                </button>
              ) : null}
            </div>
          </fieldset>
        );
      })}
      <div className="field">
        <label htmlFor={`${id}-notes`}>Note for the kitchen (optional)</label>
        <input
          id={`${id}-notes`}
          maxLength={120}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
          }}
        />
      </div>
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="One less"
          disabled={qty <= 1}
          onClick={() => {
            setQty(qty - 1);
          }}
        >
          −
        </button>
        <span aria-live="polite">{qty}</span>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="One more"
          disabled={qty >= 20}
          onClick={() => {
            setQty(qty + 1);
          }}
        >
          +
        </button>
      </div>
      {problems.length > 0 ? <p className="field-hint">{problems.join('. ')}</p> : null}
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!variant || problems.length > 0}
          onClick={() => {
            if (!variant) return;
            const options = item.modifierGroups.flatMap((g) => g.options);
            onAdd({
              key: crypto.randomUUID(),
              variantId: variant.id,
              itemName: item.name,
              variantName: variant.name,
              optionIds: chosen,
              optionNames: chosen.map((c) => options.find((o) => o.id === c)?.name ?? ''),
              notes: notes.trim(),
              qty,
              unitPrice: price,
            });
          }}
        >
          Add {qty > 1 ? `${String(qty)} ` : ''}to order ·{' '}
          {rupees(cartTotal([{ unitPrice: price, qty } as CartLine]))}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Back to menu
        </button>
      </div>
    </div>
  );
}
