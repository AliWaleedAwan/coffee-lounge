/**
 * Scheduled promotions (D-14, AT-112): percent or rupees off chosen items or whole
 * categories, limited by dates, weekdays and hours in shop time. Promotions never
 * stack: each line gets the single best one.
 */
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import {
  describeSchedule,
  rupees,
  useMenu,
  useMenuWrite,
  usePromotions,
  WEEKDAYS,
  writeMessage,
  type Menu,
  type Promotion,
} from './menu-api.ts';

const KIND_OPTIONS = [
  { value: 'percent', label: 'Percent off' },
  { value: 'fixed', label: 'Rupees off' },
] as const;
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

export function PromotionsTab() {
  const menu = useMenu(true);
  const promotions = usePromotions(true);
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const writes = useWritesAllowed();
  const toggle = useMenuWrite();

  if (editing && menu.data) {
    return (
      <PromotionForm
        menu={menu.data}
        promotion={editing === 'new' ? null : editing}
        onClose={() => {
          setEditing(null);
        }}
      />
    );
  }

  const targetNames = (p: Promotion): string => {
    const categories = menu.data?.categories ?? [];
    const items = categories.flatMap((c) => c.items);
    return [
      ...p.categoryIds.map(
        (id) => `All ${categories.find((c) => c.id === id)?.name ?? 'category'}`,
      ),
      ...p.itemIds.map((id) => items.find((i) => i.id === id)?.name ?? 'item'),
    ].join(', ');
  };

  return (
    <>
      <div className="section-head">
        <h2>Promotions</h2>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!writes || !menu.data}
          onClick={() => {
            setEditing('new');
          }}
        >
          New promotion
        </button>
      </div>
      {promotions.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(promotions.error)}
        </div>
      ) : null}
      {toggle.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(toggle.error)}
        </div>
      ) : null}
      {promotions.data?.items.length === 0 ? <p className="muted">No promotions yet.</p> : null}
      {(promotions.data?.items.length ?? 0) > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Discount</th>
              <th scope="col">When</th>
              <th scope="col">On</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(promotions.data?.items ?? []).map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.kind === 'percent' ? `${p.value}% off` : `${rupees(p.value)} off`}</td>
                <td>{describeSchedule(p)}</td>
                <td>{targetNames(p)}</td>
                <td>
                  <span className={p.isActive ? 'chip chip-ok' : 'chip chip-warning'}>
                    {p.isActive ? 'On' : 'Paused'}
                  </span>
                </td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || !menu.data}
                      onClick={() => {
                        setEditing(p);
                      }}
                    >
                      Edit <span className="visually-hidden">{p.name}</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!writes || toggle.isPending}
                      onClick={() => {
                        toggle.mutate({
                          path: `/promotions/${p.id}`,
                          method: 'PATCH',
                          body: { expectedVersion: p.version, isActive: !p.isActive },
                        });
                      }}
                    >
                      {p.isActive ? 'Pause' : 'Resume'}{' '}
                      <span className="visually-hidden">{p.name}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function PromotionForm({
  menu,
  promotion,
  onClose,
}: {
  menu: Menu;
  promotion: Promotion | null;
  onClose: () => void;
}) {
  const writes = useWritesAllowed();
  const [name, setName] = useState(promotion?.name ?? '');
  const [kind, setKind] = useState<string>(promotion?.kind ?? 'percent');
  const [value, setValue] = useState(promotion?.value ?? '');
  const [startsOn, setStartsOn] = useState(promotion?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(promotion?.endsOn ?? '');
  const [days, setDays] = useState<number[]>(promotion?.daysOfWeek ?? [1, 2, 3, 4, 5, 6, 7]);
  const [allDay, setAllDay] = useState(!promotion?.timeFrom);
  const [timeFrom, setTimeFrom] = useState(promotion?.timeFrom?.slice(0, 5) ?? '');
  const [timeTo, setTimeTo] = useState(promotion?.timeTo?.slice(0, 5) ?? '');
  const [categoryIds, setCategoryIds] = useState<string[]>(promotion?.categoryIds ?? []);
  const [itemIds, setItemIds] = useState<string[]>(promotion?.itemIds ?? []);
  const save = useMenuWrite(onClose);

  const valueOk =
    AMOUNT.test(value) && Number(value) > 0 && (kind !== 'percent' || Number(value) <= 100);
  const hoursOk = allDay || (timeFrom !== '' && timeTo !== '' && timeFrom !== timeTo);
  const valid =
    name.trim().length > 0 &&
    valueOk &&
    startsOn !== '' &&
    (endsOn === '' || endsOn >= startsOn) &&
    days.length > 0 &&
    hoursOk &&
    categoryIds.length + itemIds.length > 0;

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || save.isPending) return;
    const body = {
      name: name.trim(),
      kind,
      value,
      startsOn,
      endsOn: endsOn === '' ? null : endsOn,
      daysOfWeek: days.length === 7 ? null : [...days].sort((a, b) => a - b),
      timeFrom: allDay ? null : timeFrom,
      timeTo: allDay ? null : timeTo,
      categoryIds,
      itemIds,
    };
    save.mutate(
      promotion
        ? {
            path: `/promotions/${promotion.id}`,
            method: 'PATCH',
            body: { expectedVersion: promotion.version, ...body },
          }
        : { path: '/promotions', body },
    );
  };

  return (
    <section className="card stack" aria-labelledby="promotion-form">
      <div className="section-head">
        <h2 id="promotion-form">{promotion ? `Edit ${promotion.name}` : 'New promotion'}</h2>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to promotions
        </button>
      </div>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="row">
          <Field
            label="Name"
            placeholder="e.g. Happy hour"
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <SelectField label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <Field
            label={kind === 'percent' ? 'Percent off' : 'Rupees off'}
            inputMode="decimal"
            value={value}
            error={
              value && !valueOk
                ? kind === 'percent'
                  ? 'Between 0 and 100'
                  : 'A positive amount'
                : null
            }
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </div>
        <div className="row">
          <Field
            label="Starts on"
            type="date"
            value={startsOn}
            onChange={(e) => {
              setStartsOn(e.target.value);
            }}
          />
          <Field
            label="Ends on (optional)"
            type="date"
            value={endsOn}
            onChange={(e) => {
              setEndsOn(e.target.value);
            }}
          />
        </div>
        <fieldset className="stack">
          <legend>Days</legend>
          <div className="checks">
            {WEEKDAYS.map((label, i) => (
              <CheckField
                key={label}
                label={label}
                checked={days.includes(i + 1)}
                onChange={(on) => {
                  setDays(on ? [...days, i + 1] : days.filter((d) => d !== i + 1));
                }}
              />
            ))}
          </div>
        </fieldset>
        <CheckField label="All day" checked={allDay} onChange={setAllDay} />
        {allDay ? null : (
          <div className="row">
            <Field
              label="From"
              type="time"
              value={timeFrom}
              onChange={(e) => {
                setTimeFrom(e.target.value);
              }}
            />
            <Field
              label="Until"
              type="time"
              hint="An end before the start runs past midnight."
              value={timeTo}
              onChange={(e) => {
                setTimeTo(e.target.value);
              }}
            />
          </div>
        )}
        <fieldset className="stack">
          <legend>Whole categories</legend>
          <div className="checks">
            {menu.categories.map((c) => (
              <CheckField
                key={c.id}
                label={c.name}
                checked={categoryIds.includes(c.id)}
                onChange={(on) => {
                  setCategoryIds(toggle(categoryIds, c.id, on));
                }}
              />
            ))}
          </div>
        </fieldset>
        <fieldset className="stack">
          <legend>Single items</legend>
          <div className="checks">
            {menu.categories
              .flatMap((c) => c.items)
              .map((item) => (
                <CheckField
                  key={item.id}
                  label={item.name}
                  checked={itemIds.includes(item.id)}
                  onChange={(on) => {
                    setItemIds(toggle(itemIds, item.id, on));
                  }}
                />
              ))}
          </div>
        </fieldset>
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
            {promotion ? 'Save promotion' : 'Create promotion'}
          </button>
        </div>
      </form>
    </section>
  );
}
