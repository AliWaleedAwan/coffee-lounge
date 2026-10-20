/**
 * Modifier groups ("Milk", "Extra shot"…) and their choices. A group's minimum and
 * maximum are enforced by the server when an order is placed (AT-113). Changing what a
 * choice costs needs the price permission, like any other price.
 */
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import {
  rupees,
  useMenu,
  useMenuWrite,
  writeMessage,
  type MenuOption,
  type ModifierGroup,
} from './menu-api.ts';

const WHOLE_RUPEES = /^\d{1,9}$/;
const COUNT = /^\d{1,2}$/;

export function ChoicesTab({ canPrice }: { canPrice: boolean }) {
  const menu = useMenu(true);
  return (
    <>
      {menu.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(menu.error)}
        </div>
      ) : null}
      {(menu.data?.modifierGroups ?? []).map((g) => (
        <GroupSection key={g.id} group={g} canPrice={canPrice} />
      ))}
      {menu.data?.modifierGroups?.length === 0 ? (
        <p className="muted">No choice groups yet.</p>
      ) : null}
      <NewGroup />
    </>
  );
}

function rangeText(g: { minSelect: number; maxSelect: number }): string {
  if (g.minSelect === 0) return `Optional, up to ${String(g.maxSelect)}`;
  if (g.minSelect === g.maxSelect) return `Choose exactly ${String(g.minSelect)}`;
  return `Choose ${String(g.minSelect)} to ${String(g.maxSelect)}`;
}

function GroupSection({ group, canPrice }: { group: ModifierGroup; canPrice: boolean }) {
  const writes = useWritesAllowed();
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(group.minSelect));
  const [max, setMax] = useState(String(group.maxSelect));
  const [option, setOption] = useState({ name: '', price: '0' });
  const write = useMenuWrite(() => {
    setEditing(false);
    setOption({ name: '', price: '0' });
  });
  const version = group.version ?? 0;
  const headingId = `group-${group.id}`;
  const rangeOk =
    COUNT.test(min) && COUNT.test(max) && Number(min) <= Number(max) && Number(max) >= 1;

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>{group.name}</h2>
        <span className="chip chip-info">{rangeText(group)}</span>
        {group.isActive === false ? <span className="chip chip-warning">Hidden</span> : null}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setEditing(!editing);
          }}
        >
          Change limits
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || write.isPending}
          onClick={() => {
            write.mutate({
              path: `/modifier-groups/${group.id}`,
              method: 'PATCH',
              body: { expectedVersion: version, isActive: group.isActive === false },
            });
          }}
        >
          {group.isActive === false ? 'Show' : 'Hide'}
        </button>
      </div>
      {editing ? (
        <form
          className="row"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (rangeOk && writes) {
              write.mutate({
                path: `/modifier-groups/${group.id}`,
                method: 'PATCH',
                body: { expectedVersion: version, minSelect: Number(min), maxSelect: Number(max) },
              });
            }
          }}
        >
          <Field
            label="At least"
            inputMode="numeric"
            value={min}
            onChange={(e) => {
              setMin(e.target.value);
            }}
          />
          <Field
            label="At most"
            inputMode="numeric"
            value={max}
            onChange={(e) => {
              setMax(e.target.value);
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={!rangeOk || !writes}>
            Save limits
          </button>
        </form>
      ) : null}
      {write.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(write.error)}
        </div>
      ) : null}
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Choice</th>
            <th scope="col">Extra charge</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {group.options.map((o) => (
            <OptionRow key={o.id} option={o} canPrice={canPrice} />
          ))}
        </tbody>
      </table>
      <form
        className="row"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (option.name.trim() && WHOLE_RUPEES.test(option.price) && writes) {
            write.mutate({
              path: `/modifier-groups/${group.id}/options`,
              body: { name: option.name.trim(), priceDelta: option.price },
            });
          }
        }}
      >
        <Field
          label={`New choice in ${group.name}`}
          maxLength={80}
          value={option.name}
          onChange={(e) => {
            setOption({ ...option, name: e.target.value });
          }}
        />
        <Field
          label="Extra charge (Rs)"
          inputMode="numeric"
          value={option.price}
          onChange={(e) => {
            setOption({ ...option, price: e.target.value });
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={!option.name.trim() || !WHOLE_RUPEES.test(option.price) || !writes}
        >
          Add choice
        </button>
      </form>
    </section>
  );
}

function OptionRow({ option, canPrice }: { option: MenuOption; canPrice: boolean }) {
  const writes = useWritesAllowed();
  const [pricing, setPricing] = useState(false);
  const [price, setPrice] = useState(option.priceDelta.split('.')[0] ?? '0');
  const write = useMenuWrite(() => {
    setPricing(false);
  });
  const version = option.version ?? 0;
  return (
    <tr>
      <td>
        {option.name}
        {option.isActive === false ? (
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
              if (WHOLE_RUPEES.test(price) && writes) {
                write.mutate({
                  path: `/modifier-options/${option.id}`,
                  method: 'PATCH',
                  body: { expectedVersion: version, priceDelta: price },
                });
              }
            }}
          >
            <Field
              label={`Extra charge for ${option.name}`}
              inputMode="numeric"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!WHOLE_RUPEES.test(price) || !writes}
            >
              Save
            </button>
          </form>
        ) : option.priceDelta === '0.00' ? (
          'No charge'
        ) : (
          `+ ${rupees(option.priceDelta)}`
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
              Change charge <span className="visually-hidden">for {option.name}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || write.isPending}
            onClick={() => {
              write.mutate({
                path: `/modifier-options/${option.id}`,
                method: 'PATCH',
                body: { expectedVersion: version, isActive: option.isActive === false },
              });
            }}
          >
            {option.isActive === false ? 'Show' : 'Hide'}{' '}
            <span className="visually-hidden">{option.name}</span>
          </button>
        </div>
      </td>
    </tr>
  );
}

function NewGroup() {
  const writes = useWritesAllowed();
  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [max, setMax] = useState('1');
  const [options, setOptions] = useState('');
  const write = useMenuWrite(() => {
    setName('');
    setOptions('');
  });
  const names = options
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const valid = name.trim().length > 0 && COUNT.test(max) && Number(max) >= 1 && names.length > 0;

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!valid || !writes || write.isPending) return;
    write.mutate({
      path: '/modifier-groups',
      body: {
        name: name.trim(),
        minSelect: required ? 1 : 0,
        maxSelect: Number(max),
        options: names.map((n) => ({ name: n })),
      },
    });
  };

  return (
    <section className="card stack" aria-labelledby="new-group">
      <h2 id="new-group">New choice group</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="row">
          <Field
            label="Group name"
            placeholder="e.g. Milk"
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Field
            label="Most a guest can pick"
            inputMode="numeric"
            value={max}
            onChange={(e) => {
              setMax(e.target.value);
            }}
          />
        </div>
        <CheckField label="A choice is required" checked={required} onChange={setRequired} />
        <div className="field">
          <label htmlFor="new-group-options">
            Choices, one per line (free; set charges afterwards)
          </label>
          <textarea
            id="new-group-options"
            rows={4}
            value={options}
            onChange={(e) => {
              setOptions(e.target.value);
            }}
          />
        </div>
        {write.isError ? (
          <div role="alert" className="banner banner-danger">
            {writeMessage(write.error)}
          </div>
        ) : null}
        <div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!valid || !writes || write.isPending}
          >
            Create group
          </button>
        </div>
      </form>
    </section>
  );
}
