/** Categories, items and sizes; the temporarily-unavailable switch per size. */
import { useState, type SubmitEvent } from 'react';
import { Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { ItemEditor } from './ItemEditor.tsx';
import {
  rupees,
  useMenu,
  useMenuWrite,
  writeMessage,
  type MenuCategory,
  type MenuItem,
  type MenuVariant,
} from './menu-api.ts';

export interface MenuAbilities {
  manage: boolean;
  price: boolean;
  toggle: boolean;
}

export function ItemsTab({ can }: { can: MenuAbilities }) {
  const menu = useMenu(can.manage);
  // The item is looked up on every render, so the editor always shows the latest prices
  // and versions after a write or a live update (a snapshot would send stale versions).
  const [editing, setEditing] = useState<{ itemId: string | null; categoryId: string } | null>(
    null,
  );
  const items = menu.data?.categories.flatMap((c) => c.items) ?? [];
  const current = editing?.itemId ? items.find((i) => i.id === editing.itemId) : undefined;

  if (editing && menu.data && (editing.itemId === null || current)) {
    return (
      <ItemEditor
        key={editing.itemId ?? 'new'}
        menu={menu.data}
        item={current ?? null}
        categoryId={editing.categoryId}
        canPrice={can.price}
        onClose={() => {
          setEditing(null);
        }}
      />
    );
  }

  return (
    <>
      {menu.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(menu.error)}
        </div>
      ) : null}
      {menu.isPending ? <p className="muted">Loading the menu…</p> : null}
      {menu.data?.categories.length === 0 ? (
        <p className="muted">The menu is empty. Add a category to start.</p>
      ) : null}
      {(menu.data?.categories ?? []).map((category) => (
        <CategorySection
          key={category.id}
          category={category}
          can={can}
          onEdit={(item) => {
            setEditing({ itemId: item?.id ?? null, categoryId: category.id });
          }}
        />
      ))}
      {can.manage ? <NewCategory /> : null}
    </>
  );
}

function CategorySection({
  category,
  can,
  onEdit,
}: {
  category: MenuCategory;
  can: MenuAbilities;
  onEdit: (item: MenuItem | null) => void;
}) {
  const writes = useWritesAllowed();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(category.name);
  const write = useMenuWrite(() => {
    setRenaming(false);
  });
  const version = category.version ?? 0;
  const headingId = `category-${category.id}`;

  const rename = (event: SubmitEvent): void => {
    event.preventDefault();
    if (name.trim() && writes) {
      write.mutate({
        path: `/menu/categories/${category.id}`,
        method: 'PATCH',
        body: { expectedVersion: version, name: name.trim() },
      });
    }
  };

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>{category.name}</h2>
        {category.isActive === false ? <span className="chip chip-warning">Hidden</span> : null}
        {can.manage ? (
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!writes}
              onClick={() => {
                onEdit(null);
              }}
            >
              Add item
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setName(category.name);
                setRenaming(!renaming);
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes || write.isPending}
              onClick={() => {
                write.mutate({
                  path: `/menu/categories/${category.id}`,
                  method: 'PATCH',
                  body: { expectedVersion: version, isActive: category.isActive === false },
                });
              }}
            >
              {category.isActive === false ? 'Show' : 'Hide'}
            </button>
            {category.items.length === 0 ? (
              <button
                type="button"
                className="btn btn-danger"
                disabled={!writes || write.isPending}
                onClick={() => {
                  write.mutate({
                    path: `/menu/categories/${category.id}/archive`,
                    body: { expectedVersion: version },
                  });
                }}
              >
                Archive
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {renaming ? (
        <form className="row" onSubmit={rename} noValidate>
          <Field
            label="Category name"
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || !writes}>
            Save name
          </button>
        </form>
      ) : null}
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(write.error)}
        </div>
      ) : null}
      {category.items.length === 0 ? (
        <p className="muted">No items in this category.</p>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Sizes and prices</th>
              <th scope="col">Dietary tags</th>
              {can.manage ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {category.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  {item.isActive === false ? (
                    <>
                      {' '}
                      <span className="chip chip-warning">Hidden</span>
                    </>
                  ) : null}
                </td>
                <td>
                  {item.variants.map((v) => (
                    <VariantLine key={v.id} variant={v} canToggle={can.toggle} />
                  ))}
                </td>
                <td>{item.dietaryTags.length > 0 ? item.dietaryTags.join(' · ') : '—'}</td>
                {can.manage ? (
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        onEdit(item);
                      }}
                    >
                      Edit <span className="visually-hidden">{item.name}</span>
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function VariantLine({ variant, canToggle }: { variant: MenuVariant; canToggle: boolean }) {
  const writes = useWritesAllowed();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const write = useMenuWrite(() => {
    setAsking(false);
    setReason('');
  });
  // Only the manual switch can be turned back on here; stock comes back by itself.
  const marked = variant.unavailableReason === 'marked_unavailable';
  const setAvailable = (available: boolean): void => {
    write.mutate({
      path: `/menu/variants/${variant.id}/availability`,
      body: available
        ? { available }
        : { available, ...(reason.trim() ? { reason: reason.trim() } : {}) },
    });
  };

  return (
    <div className="stack stack-tight">
      <div className="variant-line">
        <span>{variant.name}</span>
        {variant.promotionPrice ? (
          <>
            <span className="strike">{rupees(variant.price)}</span>
            <span>{rupees(variant.promotionPrice)}</span>
            <span className="chip chip-info">Promotion</span>
          </>
        ) : (
          <span>{rupees(variant.price)}</span>
        )}
        {variant.isActive === false ? <span className="chip chip-warning">Hidden</span> : null}
        {marked ? (
          <span className="chip chip-danger">
            Unavailable{variant.unavailableNote ? `: ${variant.unavailableNote}` : ''}
          </span>
        ) : null}
        {variant.unavailableReason === 'out_of_stock' ? (
          <span className="chip chip-danger">Out of stock</span>
        ) : null}
        {canToggle && !asking ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || write.isPending}
            onClick={() => {
              if (marked) setAvailable(true);
              else setAsking(true);
            }}
          >
            {marked ? 'Mark available' : 'Mark unavailable'}
            <span className="visually-hidden"> ({variant.name})</span>
          </button>
        ) : null}
      </div>
      {asking ? (
        <form
          className="row"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setAvailable(false);
          }}
        >
          <Field
            label={`Why is ${variant.name} unavailable? (optional)`}
            placeholder="e.g. Blender broken"
            maxLength={120}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <button type="submit" className="btn btn-danger" disabled={!writes || write.isPending}>
            Mark unavailable
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setAsking(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(write.error)}
        </div>
      ) : null}
    </div>
  );
}

function NewCategory() {
  const writes = useWritesAllowed();
  const [name, setName] = useState('');
  const write = useMenuWrite(() => {
    setName('');
  });
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (name.trim() && writes && !write.isPending) {
      write.mutate({ path: '/menu/categories', body: { name: name.trim() } });
    }
  };
  return (
    <section className="card stack" aria-labelledby="new-category">
      <h2 id="new-category">New category</h2>
      <form className="row" onSubmit={submit} noValidate>
        <Field
          label="Category name"
          placeholder="e.g. Cold drinks"
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!name.trim() || !writes || write.isPending}
        >
          Add category
        </button>
      </form>
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(write.error)}
        </div>
      ) : null}
    </section>
  );
}
