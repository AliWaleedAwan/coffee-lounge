/**
 * Recipes (RECIPE_INVENTORY.md §2, §4; step 4.8). Every size shows whether it is tracked:
 * untracked sizes sell normally with no stock (D-29). A size's recipe is edited as a draft
 * (a copy of the active one), saved, then activated; activation needs every ingredient
 * counted. The size is then switched to track stock. Choices change ingredients through
 * rules (add, remove, replace, scale); the preview shows what one unit takes.
 */
import { UNITS, unitsFor, type UnitCode } from '@cl/shared';
import { useState } from 'react';
import { CheckField, Field, SelectField, TextAreaField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { formatQty, useItems } from '../inventory/inventory-api.ts';
import { writeMessage } from './menu-api.ts';
import {
  previewRecipe,
  useRecipeOverview,
  useRecipeWrite,
  useVariantRecipes,
  wastePercent,
  type OrderType,
  type PreviewLine,
  type RecipeComponent,
  type RecipeVersion,
  type VariantRecipes,
} from './recipe-api.ts';

const ORDER_TYPES: { value: OrderType; label: string }[] = [
  { value: 'dine_in', label: 'Dine-in' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'delivery', label: 'Delivery' },
];

export function RecipesTab({ canManage }: { canManage: boolean }) {
  const overview = useRecipeOverview();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <RecipeEditor
        variantId={open}
        canManage={canManage}
        onClose={() => {
          setOpen(null);
        }}
      />
    );
  }
  const items = overview.data?.items ?? [];
  const sizes = items.flatMap((i) => i.variants);
  const tracked = sizes.filter((v) => v.stockMode === 'recipe').length;
  return (
    <section className="card stack" aria-labelledby="recipes-head">
      <h2 id="recipes-head">Recipes</h2>
      {overview.isPending ? <Loading label="Loading recipes" /> : null}
      {overview.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(overview.error)}
        </div>
      ) : null}
      {overview.data ? (
        <p className="muted">
          {tracked} of {sizes.length} sizes track stock. Untracked sizes sell normally; start with
          the best sellers (D-29).
        </p>
      ) : null}
      {items.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Size</th>
              <th scope="col">Recipe</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.flatMap((item) =>
              item.variants.map((v) => (
                <tr key={v.id}>
                  <td>
                    {item.name}
                    <div className="muted">{item.category}</div>
                  </td>
                  <td>{v.name}</td>
                  <td>
                    {v.stockMode === 'recipe' ? (
                      <span className="chip chip-ok">Tracks stock · v{v.activeVersion}</span>
                    ) : (
                      <span className="chip">Untracked</span>
                    )}
                    {v.stockMode === 'untracked' && v.activeVersion !== null ? (
                      <div className="muted">Recipe v{v.activeVersion} ready</div>
                    ) : null}
                    {v.draftVersion !== null ? (
                      <div className="muted">Draft v{v.draftVersion}</div>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setOpen(v.id);
                      }}
                    >
                      Open{' '}
                      <span className="visually-hidden">
                        {item.name} {v.name}
                      </span>
                    </button>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function RecipeEditor({
  variantId,
  canManage,
  onClose,
}: {
  variantId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const recipes = useVariantRecipes(variantId);
  const r = recipes.data;
  const active = r?.versions.find((v) => v.status === 'active') ?? null;
  const draft = r?.versions.find((v) => v.status === 'draft') ?? null;
  return (
    <>
      <section className="card stack" aria-labelledby="recipe-head">
        <div className="section-head">
          <h2 id="recipe-head">{r ? `${r.menuItemName} · ${r.variantName}` : 'Recipe'}</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Back to recipes
          </button>
        </div>
        {recipes.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(recipes.error)}
          </div>
        ) : null}
        {!r ? <Loading label="Loading the recipe" /> : null}
        {r ? <StockMode recipes={r} hasActive={active !== null} canManage={canManage} /> : null}
        {active ? (
          <ComponentTable title={`Active recipe · v${String(active.versionNo)}`} version={active} />
        ) : null}
        {r && !active ? <p className="muted">No active recipe yet.</p> : null}
      </section>
      {r && canManage ? (
        <Draft variantId={variantId} draft={draft} hasActive={active !== null} />
      ) : null}
      {r ? <Rules recipes={r} canManage={canManage} /> : null}
      {r && (active ?? draft) ? (
        <Preview recipes={r} hasDraft={draft !== null} hasActive={active !== null} />
      ) : null}
    </>
  );
}

function StockMode({
  recipes,
  hasActive,
  canManage,
}: {
  recipes: VariantRecipes;
  hasActive: boolean;
  canManage: boolean;
}) {
  const writes = useWritesAllowed();
  const change = useRecipeWrite();
  const tracking = recipes.stockMode === 'recipe';
  return (
    <div className="stack">
      <p>
        {tracking
          ? 'This size tracks stock: each sale reserves and uses its ingredients.'
          : 'This size does not track stock yet: it sells with no reservation and no cost.'}
      </p>
      {canManage ? (
        <div className="row">
          <button
            type="button"
            className={tracking ? 'btn btn-ghost' : 'btn btn-primary'}
            disabled={!writes || change.isPending || (!tracking && !hasActive)}
            onClick={() => {
              change.mutate({
                path: `/recipes/variants/${recipes.variantId}/stock-mode`,
                body: { mode: tracking ? 'untracked' : 'recipe' },
              });
            }}
          >
            {tracking ? 'Stop tracking stock' : 'Track stock with this recipe'}
          </button>
        </div>
      ) : null}
      {change.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(change.error)}
        </div>
      ) : null}
    </div>
  );
}

function orderTypes(c: Pick<RecipeComponent, 'forDineIn' | 'forTakeaway' | 'forDelivery'>): string {
  const all = [
    c.forDineIn && 'dine-in',
    c.forTakeaway && 'takeaway',
    c.forDelivery && 'delivery',
  ].filter(Boolean);
  return all.length === 3 ? 'All orders' : all.join(', ');
}

function ComponentTable({ title, version }: { title: string; version: RecipeVersion }) {
  return (
    <div className="stack">
      <h3>{title}</h3>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Ingredient</th>
            <th scope="col">Quantity</th>
            <th scope="col">Waste</th>
            <th scope="col">For</th>
          </tr>
        </thead>
        <tbody>
          {version.components.map((c) => (
            <tr key={c.itemId}>
              <td>{c.name}</td>
              <td>{formatQty(c.qtyBase, c.baseUom)}</td>
              <td>{Number(c.wasteFactor) > 0 ? `${wastePercent(c.wasteFactor)} %` : '—'}</td>
              <td>{orderTypes(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {version.prepInstructions ? <p className="muted">{version.prepInstructions}</p> : null}
    </div>
  );
}

interface Row {
  key: number;
  itemId: string;
  qty: string;
  uom: UnitCode;
  waste: string;
  forDineIn: boolean;
  forTakeaway: boolean;
  forDelivery: boolean;
}

function Draft({
  variantId,
  draft,
  hasActive,
}: {
  variantId: string;
  draft: RecipeVersion | null;
  hasActive: boolean;
}) {
  const writes = useWritesAllowed();
  const start = useRecipeWrite();
  if (!draft) {
    return (
      <section className="card stack" aria-labelledby="draft-head">
        <h2 id="draft-head">Draft</h2>
        <p className="muted">
          {hasActive
            ? 'Changes start as a draft copied from the active recipe; the active one stays until the draft is activated.'
            : 'Start a draft, add its ingredients, then activate it.'}
        </p>
        <div className="row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes || start.isPending}
            onClick={() => {
              start.mutate({ path: `/recipes/variants/${variantId}/draft` });
            }}
          >
            {hasActive ? 'Change the recipe' : 'Start a recipe'}
          </button>
        </div>
        {start.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(start.error)}
          </div>
        ) : null}
      </section>
    );
  }
  return <DraftEditor key={`${draft.id}-${String(draft.version)}`} draft={draft} />;
}

function DraftEditor({ draft }: { draft: RecipeVersion }) {
  const writes = useWritesAllowed();
  const items = useItems({ q: '', category: '', includeArchived: false });
  const stock = items.data?.items ?? [];
  const [rows, setRows] = useState<Row[]>(() =>
    draft.components.map((c, i) => ({
      key: i,
      itemId: c.itemId,
      qty: String(Number(c.qtyBase)),
      uom: c.baseUom,
      waste: wastePercent(c.wasteFactor),
      forDineIn: c.forDineIn,
      forTakeaway: c.forTakeaway,
      forDelivery: c.forDelivery,
    })),
  );
  const [nextKey, setNextKey] = useState(draft.components.length);
  const [instructions, setInstructions] = useState(draft.prepInstructions ?? '');
  const [saved, setSaved] = useState(true);
  const save = useRecipeWrite();
  const activate = useRecipeWrite();
  const patch = (key: number, change: Partial<Row>) => {
    setSaved(false);
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
  };
  const valid =
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.itemId !== '' &&
        /^\d{1,10}(\.\d{1,4})?$/.test(r.qty) &&
        Number(r.qty) > 0 &&
        /^\d{1,2}(\.\d{1,2})?$/.test(r.waste || '0') &&
        (r.forDineIn || r.forTakeaway || r.forDelivery),
    );
  const uncounted = draft.components.filter((c) => !c.stockControlActive).map((c) => c.name);

  return (
    <section className="card stack" aria-labelledby="draft-head">
      <h2 id="draft-head">Draft · v{draft.versionNo}</h2>
      {rows.map((r) => {
        const item = stock.find((i) => i.id === r.itemId);
        const base = item?.baseUom ?? UNITS[r.uom].base;
        return (
          <fieldset key={r.key} className="row" aria-label={`Ingredient ${item?.name ?? 'new'}`}>
            <legend className="visually-hidden">{item?.name ?? 'New ingredient'}</legend>
            <SelectField
              label="Ingredient"
              value={r.itemId}
              options={[
                { value: '', label: 'Choose…' },
                ...stock.map((i) => ({
                  value: i.id,
                  label: `${i.name}${i.stockControlActive ? '' : ' (not counted yet)'}`,
                })),
              ]}
              onChange={(v) => {
                const chosen = stock.find((i) => i.id === v);
                patch(r.key, { itemId: v, ...(chosen ? { uom: chosen.baseUom } : {}) });
              }}
            />
            <Field
              label="Quantity"
              inputMode="decimal"
              value={r.qty}
              onChange={(e) => {
                patch(r.key, { qty: e.target.value.trim() });
              }}
            />
            <SelectField
              label="Unit"
              value={r.uom}
              options={unitsFor(base).map((u) => ({ value: u, label: u }))}
              onChange={(v) => {
                patch(r.key, { uom: v as UnitCode });
              }}
            />
            <Field
              label="Waste %"
              inputMode="decimal"
              value={r.waste}
              onChange={(e) => {
                patch(r.key, { waste: e.target.value.trim() });
              }}
            />
            <div className="checks">
              <CheckField
                label="Dine-in"
                checked={r.forDineIn}
                onChange={(v) => {
                  patch(r.key, { forDineIn: v });
                }}
              />
              <CheckField
                label="Takeaway"
                checked={r.forTakeaway}
                onChange={(v) => {
                  patch(r.key, { forTakeaway: v });
                }}
              />
              <CheckField
                label="Delivery"
                checked={r.forDelivery}
                onChange={(v) => {
                  patch(r.key, { forDelivery: v });
                }}
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSaved(false);
                setRows((all) => all.filter((x) => x.key !== r.key));
              }}
            >
              Remove <span className="visually-hidden">{item?.name ?? 'ingredient'}</span>
            </button>
          </fieldset>
        );
      })}
      <div className="row">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setSaved(false);
            setRows((all) => [
              ...all,
              {
                key: nextKey,
                itemId: '',
                qty: '',
                uom: 'ml',
                waste: '0',
                forDineIn: true,
                forTakeaway: true,
                forDelivery: true,
              },
            ]);
            setNextKey(nextKey + 1);
          }}
        >
          Add ingredient
        </button>
      </div>
      <TextAreaField
        label="How to make it (optional)"
        maxLength={1000}
        value={instructions}
        onChange={(v) => {
          setSaved(false);
          setInstructions(v);
        }}
      />
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!valid || !writes || save.isPending}
          onClick={() => {
            save.mutate({
              path: `/recipes/versions/${draft.id}`,
              method: 'PUT',
              body: {
                expectedVersion: draft.version,
                prepInstructions: instructions.trim() || null,
                components: rows.map((r) => ({
                  itemId: r.itemId,
                  qty: r.qty,
                  uom: r.uom,
                  wastePercent: r.waste || '0',
                  forDineIn: r.forDineIn,
                  forTakeaway: r.forTakeaway,
                  forDelivery: r.forDelivery,
                })),
              },
            });
          }}
        >
          Save draft
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!saved || draft.components.length === 0 || !writes || activate.isPending}
          onClick={() => {
            activate.mutate({ path: `/recipes/versions/${draft.id}/activate` });
          }}
        >
          Activate v{draft.versionNo}
        </button>
      </div>
      {!saved ? <p className="field-hint">Save the draft before activating it.</p> : null}
      {saved && uncounted.length > 0 ? (
        <p className="field-hint">Count these first, then activate: {uncounted.join(', ')}.</p>
      ) : null}
      {save.isError || activate.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(save.error ?? activate.error)}
        </div>
      ) : null}
    </section>
  );
}

const ACTIONS = {
  add: 'adds',
  remove: 'removes',
  replace: 'replaces',
  scale: 'scales',
} as const;

function Rules({ recipes, canManage }: { recipes: VariantRecipes; canManage: boolean }) {
  const writes = useWritesAllowed();
  const items = useItems({ q: '', category: '', includeArchived: false });
  const stock = items.data?.items ?? [];
  const retire = useRecipeWrite();
  const [optionId, setOptionId] = useState('');
  const [action, setAction] = useState<'add' | 'remove' | 'replace' | 'scale'>('replace');
  const [itemId, setItemId] = useState('');
  const [replacementId, setReplacementId] = useState('');
  const [qty, setQty] = useState('');
  const [factor, setFactor] = useState('');
  const [thisSize, setThisSize] = useState(false);
  const add = useRecipeWrite(() => {
    setItemId('');
    setReplacementId('');
    setQty('');
    setFactor('');
  });
  const ok =
    optionId !== '' &&
    itemId !== '' &&
    (action !== 'replace' || replacementId !== '') &&
    (action !== 'add' || Number(qty) > 0) &&
    (action !== 'scale' || Number(factor) > 0);
  const describe = (rule: VariantRecipes['rules'][number]) => {
    switch (rule.action) {
      case 'add':
        return `adds ${formatQty(rule.qtyBase ?? '0', rule.baseUom)} ${rule.itemName}`;
      case 'remove':
        return `removes ${rule.itemName}`;
      case 'replace':
        return `replaces ${rule.itemName} with ${rule.replacementName ?? '?'}`;
      case 'scale':
        return `scales ${rule.itemName} × ${String(Number(rule.scaleFactor))}`;
    }
  };

  if (recipes.options.length === 0) return null;
  return (
    <section className="card stack" aria-labelledby="rules-head">
      <h2 id="rules-head">Choices</h2>
      {recipes.rules.length === 0 ? (
        <p className="muted">No choice changes the ingredients yet.</p>
      ) : null}
      {recipes.rules.map((rule) => (
        <div key={rule.id} className="row">
          <span>
            <strong>{rule.optionName}</strong> {describe(rule)}
            {rule.variantId ? ' (this size)' : ''}
          </span>
          {canManage ? (
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!writes || retire.isPending}
              onClick={() => {
                retire.mutate({ path: `/recipes/rules/${rule.id}/retire` });
              }}
            >
              End <span className="visually-hidden">{rule.optionName} rule</span>
            </button>
          ) : null}
        </div>
      ))}
      {canManage ? (
        <form
          className="stack"
          aria-label="New choice rule"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok || !writes) return;
            add.mutate({
              path: '/recipes/rules',
              body: {
                optionId,
                action,
                itemId,
                ...(thisSize ? { variantId: recipes.variantId } : {}),
                ...(action === 'replace' ? { replacementItemId: replacementId } : {}),
                ...(action === 'add' ? { qty } : {}),
                ...(action === 'scale' ? { scaleFactor: factor } : {}),
              },
            });
          }}
          noValidate
        >
          <div className="row">
            <SelectField
              label="Choice"
              value={optionId}
              options={[
                { value: '', label: 'Choose…' },
                ...recipes.options.map((o) => ({
                  value: o.id,
                  label: `${o.groupName}: ${o.name}`,
                })),
              ]}
              onChange={setOptionId}
            />
            <SelectField
              label="It"
              value={action}
              options={Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))}
              onChange={(v) => {
                setAction(v as typeof action);
              }}
            />
            <SelectField
              label="Ingredient"
              value={itemId}
              options={[
                { value: '', label: 'Choose…' },
                ...stock.map((i) => ({ value: i.id, label: i.name })),
              ]}
              onChange={setItemId}
            />
            {action === 'replace' ? (
              <SelectField
                label="With"
                value={replacementId}
                options={[
                  { value: '', label: 'Choose…' },
                  ...stock.map((i) => ({ value: i.id, label: i.name })),
                ]}
                onChange={setReplacementId}
              />
            ) : null}
            {action === 'add' ? (
              <Field
                label={`Adds (${stock.find((i) => i.id === itemId)?.baseUom ?? 'base unit'})`}
                inputMode="decimal"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value.trim());
                }}
              />
            ) : null}
            {action === 'scale' ? (
              <Field
                label="Times"
                inputMode="decimal"
                value={factor}
                onChange={(e) => {
                  setFactor(e.target.value.trim());
                }}
              />
            ) : null}
          </div>
          <CheckField
            label={`Only for ${recipes.variantName}`}
            checked={thisSize}
            onChange={setThisSize}
          />
          <div className="row">
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={!ok || !writes || add.isPending}
            >
              Add rule
            </button>
          </div>
          {add.isError || retire.isError ? (
            <div role="alert" className="banner banner-danger">
              {writeMessage(add.error ?? retire.error)}
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

/** What one unit takes for an order type and choices (RECIPE_INVENTORY.md §4.4). */
function Preview({
  recipes,
  hasDraft,
  hasActive,
}: {
  recipes: VariantRecipes;
  hasDraft: boolean;
  hasActive: boolean;
}) {
  const [orderType, setOrderType] = useState<OrderType>('dine_in');
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [useDraft, setUseDraft] = useState(false);
  // The draft when it is all there is, or when asked for while both exist.
  const draftMode = hasDraft && (!hasActive || useDraft);
  const [lines, setLines] = useState<PreviewLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setError(null);
    try {
      const optionIds = Object.entries(chosen).flatMap(([id, n]) =>
        Array.from({ length: n }, () => id),
      );
      const result = await previewRecipe({
        variantId: recipes.variantId,
        orderType,
        optionIds,
        draft: draftMode,
      });
      setLines(result.lines);
    } catch (e) {
      setError(writeMessage(e));
      setLines(null);
    }
  };
  return (
    <section className="card stack" aria-labelledby="preview-head">
      <h2 id="preview-head">Preview</h2>
      <div className="row">
        <SelectField
          label="Order type"
          value={orderType}
          options={ORDER_TYPES}
          onChange={(v) => {
            setOrderType(v as OrderType);
          }}
        />
        {hasDraft && hasActive ? (
          <CheckField label="Use the draft" checked={useDraft} onChange={setUseDraft} />
        ) : null}
      </div>
      {recipes.options.length > 0 ? (
        <div className="row" role="group" aria-label="Choices for the preview">
          {recipes.options.map((o) => (
            <Field
              key={o.id}
              label={`${o.name} ×`}
              inputMode="numeric"
              value={String(chosen[o.id] ?? 0)}
              onChange={(e) => {
                const n = Math.max(0, Math.min(5, Number(e.target.value) || 0));
                setChosen({ ...chosen, [o.id]: n });
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="row">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void run();
          }}
        >
          Show what one takes
        </button>
      </div>
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      {lines ? (
        <table className="data" aria-label="One unit takes">
          <thead>
            <tr>
              <th scope="col">Ingredient</th>
              <th scope="col">One unit</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.itemId}>
                <td>{l.name}</td>
                <td>{formatQty(l.qtyPerUnit, l.baseUom)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
