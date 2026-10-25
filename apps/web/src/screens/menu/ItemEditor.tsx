/**
 * Create or edit one item: details, dietary tags (exactly as typed, AT-126), where it
 * can be ordered, its modifier groups, and its sizes. Prices of existing sizes change
 * only through "Change price", which asks for a reason and keeps history.
 */
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField, TextAreaField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import {
  parseTags,
  rupees,
  useMenuWrite,
  writeMessage,
  type Menu,
  type MenuItem,
  type MenuVariant,
} from './menu-api.ts';

const WHOLE_RUPEES = /^\d{1,9}$/;

interface NewVariant {
  name: string;
  price: string;
}

export function ItemEditor({
  menu,
  item,
  categoryId: initialCategory,
  canPrice,
  onClose,
}: {
  menu: Menu;
  item: MenuItem | null;
  categoryId: string;
  canPrice: boolean;
  onClose: () => void;
}) {
  const writes = useWritesAllowed();
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? initialCategory);
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [tags, setTags] = useState(item?.dietaryTags.join('\n') ?? '');
  const [allow, setAllow] = useState({
    dineIn: item?.allowDineIn ?? true,
    takeaway: item?.allowTakeaway ?? true,
    delivery: item?.allowDelivery ?? true,
  });
  const [groupIds, setGroupIds] = useState<string[]>(item?.modifierGroups.map((g) => g.id) ?? []);
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [variants, setVariants] = useState<NewVariant[]>([{ name: 'Regular', price: '' }]);
  const save = useMenuWrite(onClose);

  const groups = menu.modifierGroups ?? [];
  const variantsOk =
    item !== null || variants.every((v) => v.name.trim() && WHOLE_RUPEES.test(v.price));
  const valid =
    name.trim().length > 0 && (allow.dineIn || allow.takeaway || allow.delivery) && variantsOk;

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || save.isPending) return;
    const fields = {
      categoryId,
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      dietaryTags: parseTags(tags),
      allowDineIn: allow.dineIn,
      allowTakeaway: allow.takeaway,
      allowDelivery: allow.delivery,
      modifierGroupIds: groupIds,
    };
    if (item) {
      save.mutate({
        path: `/menu/items/${item.id}`,
        method: 'PATCH',
        body: { expectedVersion: item.version ?? 0, ...fields, isActive },
      });
    } else {
      save.mutate({
        path: '/menu/items',
        body: {
          ...fields,
          variants: variants.map((v) => ({ name: v.name.trim(), price: v.price })),
        },
      });
    }
  };

  return (
    <>
      <section className="card stack" aria-labelledby="item-editor">
        <div className="section-head">
          <h2 id="item-editor">{item ? `Edit ${item.name}` : 'New item'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Back to the menu
          </button>
        </div>
        <form className="stack" onSubmit={submit} noValidate>
          <div className="row">
            <Field
              label="Name"
              maxLength={80}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <SelectField
              label="Category"
              value={categoryId}
              options={menu.categories.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setCategoryId}
            />
          </div>
          <TextAreaField
            label="Description (optional)"
            maxLength={500}
            value={description}
            onChange={setDescription}
          />
          <TextAreaField
            label="Dietary and allergen tags"
            hint="One per line. Guests see them exactly as written here; nothing is added for you."
            value={tags}
            onChange={setTags}
          />
          <fieldset className="stack">
            <legend>Can be ordered for</legend>
            <div className="checks">
              <CheckField
                label="Dine-in"
                checked={allow.dineIn}
                onChange={(v) => {
                  setAllow({ ...allow, dineIn: v });
                }}
              />
              <CheckField
                label="Takeaway"
                checked={allow.takeaway}
                onChange={(v) => {
                  setAllow({ ...allow, takeaway: v });
                }}
              />
              <CheckField
                label="Delivery"
                checked={allow.delivery}
                onChange={(v) => {
                  setAllow({ ...allow, delivery: v });
                }}
              />
            </div>
          </fieldset>
          {groups.length > 0 ? (
            <fieldset className="stack">
              <legend>Choices offered with this item</legend>
              <div className="checks">
                {groups.map((g) => (
                  <CheckField
                    key={g.id}
                    label={g.name}
                    checked={groupIds.includes(g.id)}
                    onChange={(on) => {
                      setGroupIds(on ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id));
                    }}
                  />
                ))}
              </div>
            </fieldset>
          ) : null}
          {item ? (
            <CheckField label="Shown on the menu" checked={isActive} onChange={setIsActive} />
          ) : (
            <fieldset className="stack">
              <legend>Sizes and prices (whole rupees)</legend>
              {variants.map((v, i) => (
                <div className="row" key={i}>
                  <Field
                    label={`Size ${String(i + 1)}`}
                    maxLength={80}
                    value={v.name}
                    onChange={(e) => {
                      setVariants(
                        variants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      );
                    }}
                  />
                  <Field
                    label={`Price of size ${String(i + 1)}`}
                    inputMode="numeric"
                    value={v.price}
                    error={v.price && !WHOLE_RUPEES.test(v.price) ? 'Whole rupees, e.g. 450' : null}
                    onChange={(e) => {
                      setVariants(
                        variants.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)),
                      );
                    }}
                  />
                  {variants.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setVariants(variants.filter((_, j) => j !== i));
                      }}
                    >
                      Remove size {i + 1}
                    </button>
                  ) : null}
                </div>
              ))}
              <div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setVariants([...variants, { name: '', price: '' }]);
                  }}
                >
                  Add another size
                </button>
              </div>
            </fieldset>
          )}
          {save.isError ? (
            <div role="alert" className="banner banner-danger">
              {writeMessage(save.error)}
            </div>
          ) : null}
          <div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!valid || !writes || save.isPending}
            >
              {save.isPending ? 'Saving…' : item ? 'Save changes' : 'Create item'}
            </button>
          </div>
        </form>
      </section>
      {item ? <Sizes item={item} canPrice={canPrice} /> : null}
    </>
  );
}

/** Sizes of an existing item: add, rename, make default, archive, change price. */
function Sizes({ item, canPrice }: { item: MenuItem; canPrice: boolean }) {
  const writes = useWritesAllowed();
  const [adding, setAdding] = useState<NewVariant>({ name: '', price: '' });
  const add = useMenuWrite(() => {
    setAdding({ name: '', price: '' });
  });
  return (
    <section className="card stack" aria-labelledby="sizes">
      <h2 id="sizes">Sizes and prices</h2>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Size</th>
            <th scope="col">Price</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {item.variants.map((v) => (
            <SizeRow key={v.id} variant={v} canPrice={canPrice} />
          ))}
        </tbody>
      </table>
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (adding.name.trim() && WHOLE_RUPEES.test(adding.price) && writes) {
            add.mutate({
              path: `/menu/items/${item.id}/variants`,
              body: { name: adding.name.trim(), price: adding.price },
            });
          }
        }}
      >
        <Field
          label="New size"
          placeholder="e.g. Large"
          maxLength={80}
          value={adding.name}
          onChange={(e) => {
            setAdding({ ...adding, name: e.target.value });
          }}
        />
        <Field
          label="Its price"
          inputMode="numeric"
          value={adding.price}
          onChange={(e) => {
            setAdding({ ...adding, price: e.target.value });
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!adding.name.trim() || !WHOLE_RUPEES.test(adding.price) || !writes}
        >
          Add size
        </button>
      </form>
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(add.error)}
        </div>
      ) : null}
    </section>
  );
}

function SizeRow({ variant, canPrice }: { variant: MenuVariant; canPrice: boolean }) {
  const writes = useWritesAllowed();
  const [pricing, setPricing] = useState(false);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const write = useMenuWrite(() => {
    setPricing(false);
    setPrice('');
    setReason('');
  });
  const version = variant.version ?? 0;
  const priceOk = WHOLE_RUPEES.test(price) && reason.trim().length >= 3;

  return (
    <tr>
      <td>
        {variant.name}
        {variant.isDefault ? <span className="muted"> (default)</span> : null}
        {variant.isActive === false ? (
          <>
            {' '}
            <span className="chip chip-warning">Hidden</span>
          </>
        ) : null}
      </td>
      <td>
        {pricing ? (
          <form
            className="row"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (priceOk && writes) {
                write.mutate({
                  path: `/menu/variants/${variant.id}/price`,
                  body: { expectedVersion: version, price, reason: reason.trim() },
                });
              }
            }}
          >
            <Field
              label={`New price for ${variant.name}`}
              inputMode="numeric"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
            />
            <Field
              label="Reason"
              placeholder="e.g. Milk price went up"
              maxLength={200}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={!priceOk || !writes}>
              Save price
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPricing(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          rupees(variant.price)
        )}
        {write.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(write.error)}
          </div>
        ) : null}
      </td>
      <td>
        <div className="row">
          {canPrice && !pricing ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes}
              onClick={() => {
                setPricing(true);
              }}
            >
              Change price <span className="visually-hidden">of {variant.name}</span>
            </button>
          ) : null}
          {!variant.isDefault ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes || write.isPending}
              onClick={() => {
                write.mutate({
                  path: `/menu/variants/${variant.id}`,
                  method: 'PATCH',
                  body: { expectedVersion: version, isDefault: true },
                });
              }}
            >
              Make default <span className="visually-hidden">({variant.name})</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-danger"
            disabled={!writes || write.isPending}
            onClick={() => {
              write.mutate({
                path: `/menu/variants/${variant.id}/archive`,
                body: { expectedVersion: version },
              });
            }}
          >
            Archive <span className="visually-hidden">{variant.name}</span>
          </button>
        </div>
      </td>
    </tr>
  );
}
