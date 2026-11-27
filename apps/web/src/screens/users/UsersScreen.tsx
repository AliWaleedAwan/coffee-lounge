/**
 * Users & roles (RBAC.md; UI_UX.md §6 Owner; Phase 5 step 5.5). People and their roles,
 * a forgotten password or PIN, and what each person may actually do: the effective
 * permissions with where each one comes from (a role, or an override), so the owner can
 * see the result of a change before anyone is surprised by it (AT-38). Role grants follow
 * The owner may give any permission (0032); RBAC.md's ✕ and 🔒 show as "Sensitive".
 */
import { GROUPS, inWords } from './permission-words.ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { permissionSet, ROLE_LABELS } from '../../auth/session.ts';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useSignedIn } from '../Shell.tsx';

interface User {
  id: string;
  username: string;
  displayName: string;
  isOwner: boolean;
  status: 'active' | 'disabled';
  roles: string[];
  hasPin: boolean;
}
interface Catalog {
  permissions: { key: string; module: string; description: string; isProtected: boolean }[];
  roles: {
    key: string;
    name: string;
    grants: { key: string; scope: Record<string, string> | null }[];
    policies: Record<string, 'grantable' | 'forbidden'>;
  }[];
}
interface Effective {
  key: string;
  scopes: 'all' | Record<string, string>[];
  sources: string[];
}
interface Override {
  key: string;
  effect: 'grant' | 'deny';
  reason: string;
  grantedBy: string;
}

const roleName = (key: string) => ROLE_LABELS[key] ?? key;
const sourceName = (s: string) =>
  s.startsWith('role:')
    ? `role ${roleName(s.slice(5))}`
    : s === 'override:grant'
      ? 'granted to this person'
      : s;

function useAccess() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['access'] });
  return useMutation({
    mutationFn: (c: { path: string; method: 'POST' | 'PUT' | 'DELETE'; body?: unknown }) =>
      api(c.path, { method: c.method, ...(c.body !== undefined ? { body: c.body } : {}) }),
    onSettled: refresh,
  });
}

export function UsersScreen() {
  const me = useSignedIn();
  const permissions = permissionSet(me);
  const canRoles = permissions.has('roles.manage');
  const [tab, setTab] = useState<'people' | 'roles'>('people');
  return (
    <>
      <h1>Users &amp; roles</h1>
      {canRoles ? (
        <div className="tabs" role="tablist" aria-label="Users and roles sections">
          {(['people', 'roles'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`users-tab-${t}`}
              aria-selected={tab === t}
              aria-controls="users-panel"
              onClick={() => {
                setTab(t);
              }}
            >
              {t === 'people' ? 'People' : 'Roles'}
            </button>
          ))}
        </div>
      ) : null}
      <div
        id="users-panel"
        className="stack"
        role={canRoles ? 'tabpanel' : undefined}
        aria-labelledby={canRoles ? `users-tab-${tab}` : undefined}
      >
        {tab === 'people' ? (
          <People canRoles={canRoles} isOwner={me.roles.includes('owner')} />
        ) : (
          <Roles />
        )}
      </div>
    </>
  );
}

function People({ canRoles, isOwner }: { canRoles: boolean; isOwner: boolean }) {
  const users = useQuery({
    queryKey: ['access', 'users'],
    queryFn: ({ signal }) => api<{ items: User[] }>('/users', { signal }),
  });
  const catalog = useQuery({
    queryKey: ['access', 'catalog'],
    queryFn: ({ signal }) => api<Catalog>('/access/catalog', { signal }),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = users.data?.items.find((u) => u.id === openId) ?? null;
  return (
    <>
      <AddUser roles={catalog.data?.roles.map((r) => r.key) ?? []} isOwner={isOwner} />
      <section className="card stack" aria-labelledby="people-head">
        <h2 id="people-head">People</h2>
        {users.isPending ? <Loading label="Loading users" /> : null}
        {users.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(users.error)}
          </div>
        ) : null}
        {users.data ? (
          <table className="data" aria-label="People">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Username</th>
                <th scope="col">Roles</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id} className={u.status === 'disabled' ? 'muted' : undefined}>
                  <td>{u.displayName}</td>
                  <td>{u.username}</td>
                  <td>{u.roles.map(roleName).join(', ')}</td>
                  <td>
                    {u.status === 'active' ? 'Active' : 'Disabled'}
                    {u.hasPin ? '' : ' · no PIN'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-pressed={openId === u.id}
                      onClick={() => {
                        setOpenId(openId === u.id ? null : u.id);
                      }}
                    >
                      Open<span className="visually-hidden"> {u.displayName}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
      {open && catalog.data ? (
        <Person
          key={open.id}
          user={open}
          catalog={catalog.data}
          canRoles={canRoles}
          isOwner={isOwner}
        />
      ) : null}
    </>
  );
}

function AddUser({ roles, isOwner }: { roles: string[]; isOwner: boolean }) {
  const writes = useWritesAllowed();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const add = useAccess();
  if (!open) {
    return (
      <div className="stack">
        {done ? (
          <div role="status" className="banner banner-success">
            {done}
          </div>
        ) : null}
        <div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!writes}
            onClick={() => {
              setOpen(true);
              setDone(null);
            }}
          >
            Add a person
          </button>
        </div>
      </div>
    );
  }
  const ready =
    username.trim() !== '' && name.trim() !== '' && password.length >= 10 && chosen.length > 0;
  return (
    <form
      className="card stack"
      aria-label="Add a person"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || !writes) return;
        add.mutate(
          {
            path: '/users',
            method: 'POST',
            body: {
              username: username.trim(),
              displayName: name.trim(),
              password,
              ...(pin ? { pin } : {}),
              roles: chosen,
            },
          },
          {
            onSuccess: () => {
              setDone(
                `${name.trim()} can log in as ${username.trim()} and must choose a new password.`,
              );
              setOpen(false);
              setUsername('');
              setName('');
              setPassword('');
              setPin('');
              setChosen([]);
            },
          },
        );
      }}
    >
      <h2>Add a person</h2>
      <div className="row">
        <Field
          label="Name shown"
          maxLength={60}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <Field
          label="Username"
          maxLength={40}
          autoComplete="off"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
          }}
        />
        <Field
          label="Temporary password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters; changed at the first login"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <Field
          label="PIN (4–6 digits, optional)"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value);
          }}
        />
      </div>
      <RolePicker roles={roles} value={chosen} onChange={setChosen} allowOwner={isOwner} />
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(add.error)}
        </div>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!ready || !writes || add.isPending}
        >
          Add
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function RolePicker({
  roles,
  value,
  onChange,
  allowOwner,
}: {
  roles: string[];
  value: string[];
  onChange: (roles: string[]) => void;
  allowOwner: boolean;
}) {
  return (
    <fieldset className="row">
      <legend>Roles</legend>
      {roles
        .filter((r) => allowOwner || r !== 'owner')
        .map((r) => (
          <label key={r} className="row">
            <input
              type="checkbox"
              checked={value.includes(r)}
              onChange={(e) => {
                onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r));
              }}
            />{' '}
            {roleName(r)}
          </label>
        ))}
    </fieldset>
  );
}

function Person({
  user,
  catalog,
  canRoles,
  isOwner,
}: {
  user: User;
  catalog: Catalog;
  canRoles: boolean;
  isOwner: boolean;
}) {
  const writes = useWritesAllowed();
  const effective = useQuery({
    queryKey: ['access', 'effective', user.id],
    queryFn: ({ signal }) =>
      api<{ permissions: Effective[] }>(`/users/${user.id}/effective-permissions`, { signal }),
  });
  const overrides = useQuery({
    queryKey: ['access', 'overrides', user.id],
    queryFn: ({ signal }) =>
      api<{ items: Override[] }>(`/users/${user.id}/permission-overrides`, { signal }),
  });
  const change = useAccess();
  const [roles, setRoles] = useState(user.roles);
  const [roleReason, setRoleReason] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [overrideKey, setOverrideKey] = useState('');
  const [effect, setEffect] = useState<'grant' | 'deny'>('grant');
  const [overrideReason, setOverrideReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const describe = new Map(catalog.permissions.map((p) => [p.key, p.description]));
  const run = (c: Parameters<typeof change.mutate>[0], message: string, then?: () => void) => {
    setDone(null);
    change.mutate(c, {
      onSuccess: () => {
        setDone(message);
        then?.();
      },
    });
  };
  const rolesChanged = [...roles].sort().join() !== [...user.roles].sort().join();
  return (
    <section className="card stack" aria-labelledby="person-head">
      <h2 id="person-head">
        {user.displayName} ({user.username})
      </h2>
      {done ? (
        <div role="status" className="banner banner-success">
          {done}
        </div>
      ) : null}
      {change.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(change.error)}
        </div>
      ) : null}

      {canRoles ? (
        <form
          className="stack"
          aria-label="Roles"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!rolesChanged || roles.length === 0 || roleReason.trim().length < 3 || !writes)
              return;
            run(
              {
                path: `/users/${user.id}/roles`,
                method: 'PUT',
                body: { roles, reason: roleReason.trim() },
              },
              `Roles of ${user.displayName} saved.`,
              () => {
                setRoleReason('');
              },
            );
          }}
        >
          <RolePicker
            roles={catalog.roles.map((r) => r.key)}
            value={roles}
            onChange={setRoles}
            allowOwner={isOwner}
          />
          <div className="row">
            <Field
              label="Why the roles change"
              maxLength={200}
              value={roleReason}
              onChange={(e) => {
                setRoleReason(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={
                !rolesChanged ||
                roles.length === 0 ||
                roleReason.trim().length < 3 ||
                !writes ||
                change.isPending
              }
            >
              Save roles
            </button>
          </div>
        </form>
      ) : (
        <p>Roles: {user.roles.map(roleName).join(', ')}</p>
      )}

      <div className="row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!writes || change.isPending}
          onClick={() => {
            const status = user.status === 'active' ? 'disabled' : 'active';
            run(
              { path: `/users/${user.id}/status`, method: 'POST', body: { status } },
              status === 'disabled'
                ? `${user.displayName} can no longer log in.`
                : `${user.displayName} can log in again.`,
            );
          }}
        >
          {user.status === 'active' ? 'Disable' : 'Enable'} {user.displayName}
        </button>
      </div>

      <form
        className="row"
        aria-label="Reset password and PIN"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length < 10 || !writes) return;
          run(
            {
              path: `/users/${user.id}/credentials`,
              method: 'POST',
              body: { password, ...(pin ? { pin } : {}) },
            },
            `${user.displayName} logs in with the new password and must change it.`,
            () => {
              setPassword('');
              setPin('');
            },
          );
        }}
      >
        <Field
          label="New temporary password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <Field
          label="New PIN (optional)"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value);
          }}
        />
        <button
          type="submit"
          className="btn btn-secondary"
          disabled={password.length < 10 || !writes || change.isPending}
        >
          Reset
        </button>
      </form>

      <h3>Overrides for this person</h3>
      {overrides.data && overrides.data.items.length === 0 ? (
        <p className="muted">None: only the roles count.</p>
      ) : null}
      {overrides.data && overrides.data.items.length > 0 ? (
        <ul aria-label="Overrides">
          {overrides.data.items.map((o) => (
            <li key={o.key}>
              <strong>{o.effect === 'deny' ? 'Denied' : 'Granted'}</strong>{' '}
              {describe.get(o.key) ?? o.key} <code>{o.key}</code> · {o.reason} · by {o.grantedBy}
              {canRoles ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!writes || change.isPending}
                    onClick={() => {
                      run(
                        {
                          path: `/users/${user.id}/permission-overrides/${o.key}?reason=${encodeURIComponent('Removed on the users screen')}`,
                          method: 'DELETE',
                        },
                        `Override of ${o.key} removed.`,
                      );
                    }}
                  >
                    Remove<span className="visually-hidden"> override of {o.key}</span>
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {canRoles ? (
        <form
          className="row"
          aria-label="Add an override"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!overrideKey || overrideReason.trim().length < 3 || !writes) return;
            run(
              {
                path: `/users/${user.id}/permission-overrides/${overrideKey}`,
                method: 'PUT',
                body: { effect, reason: overrideReason.trim() },
              },
              `${effect === 'deny' ? 'Denied' : 'Granted'} ${overrideKey} for ${user.displayName}.`,
              () => {
                setOverrideKey('');
                setOverrideReason('');
              },
            );
          }}
        >
          <SelectField
            label="Permission"
            value={overrideKey}
            options={[
              { value: '', label: 'Choose…' },
              ...catalog.permissions
                .filter((p) => !p.isProtected)
                .map((p) => ({ value: p.key, label: `${p.description} (${p.key})` })),
            ]}
            onChange={setOverrideKey}
          />
          <SelectField
            label="Effect"
            value={effect}
            options={[
              { value: 'grant', label: 'Grant' },
              { value: 'deny', label: 'Deny (wins over roles)' },
            ]}
            onChange={(v) => {
              setEffect(v as 'grant' | 'deny');
            }}
          />
          <Field
            label="Why"
            maxLength={200}
            value={overrideReason}
            onChange={(e) => {
              setOverrideReason(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={
              !overrideKey || overrideReason.trim().length < 3 || !writes || change.isPending
            }
          >
            Add override
          </button>
        </form>
      ) : null}

      <h3>What {user.displayName} may do</h3>
      {effective.isPending ? <Loading label="Working out permissions" /> : null}
      {effective.data ? (
        <table className="data" aria-label="Effective permissions">
          <thead>
            <tr>
              <th scope="col">Permission</th>
              <th scope="col">Key</th>
              <th scope="col">From</th>
            </tr>
          </thead>
          <tbody>
            {effective.data.permissions.map((p) => (
              <tr key={p.key}>
                <td>{describe.get(p.key) ?? p.key}</td>
                <td>
                  <code>{p.key}</code>
                </td>
                <td>
                  {p.sources.map(sourceName).join(', ')}
                  {p.scopes === 'all' ? '' : ' (limited)'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function Roles() {
  const writes = useWritesAllowed();
  const catalog = useQuery({
    queryKey: ['access', 'catalog'],
    queryFn: ({ signal }) => api<Catalog>('/access/catalog', { signal }),
  });
  const [role, setRole] = useState('manager');
  const [reason, setReason] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const change = useAccess();
  const r = catalog.data?.roles.find((x) => x.key === role);
  const granted = new Set(r?.grants.map((g) => g.key));
  const why = reason.trim().length >= 3 ? reason.trim() : 'Changed by the owner';
  const permissions = catalog.data?.permissions ?? [];
  const known = new Set(GROUPS.flatMap((g) => g.modules));
  const groups = [
    ...GROUPS,
    {
      title: 'Other',
      modules: [...new Set(permissions.map((p) => p.module))].filter((m) => !known.has(m)),
    },
  ];
  return (
    <section className="card stack" aria-labelledby="roles-head">
      <h2 id="roles-head">What each role may do</h2>
      <p className="muted">
        Tick what this role may do. It applies to everyone with the role. To give one person
        something extra, use the People tab.
      </p>
      <div className="row">
        <SelectField
          label="Role"
          value={role}
          options={(catalog.data?.roles ?? [])
            .filter((x) => x.key !== 'owner')
            .map((x) => ({ value: x.key, label: x.name }))}
          onChange={setRole}
        />
        <Field
          label="Why (optional)"
          maxLength={200}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </div>
      <CheckField label="Show technical names" checked={showKeys} onChange={setShowKeys} />
      {change.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(change.error)}
        </div>
      ) : null}
      {catalog.isPending ? <Loading label="Loading roles" /> : null}
      {r && catalog.data ? (
        <div className="stack" aria-label={`Permissions of ${r.name}`}>
          {groups.map((g) => {
            const inGroup = permissions.filter((p) => g.modules.includes(p.module));
            if (inGroup.length === 0) return null;
            const on = inGroup.filter((p) => granted.has(p.key)).length;
            return (
              <details key={g.title} className="perm-group">
                <summary>
                  <span>{g.title}</span>
                  <span className="muted">
                    {on} of {inGroup.length} allowed
                  </span>
                </summary>
                {inGroup.map((p) => (
                  <label key={p.key} className="perm-row">
                    <input
                      type="checkbox"
                      checked={granted.has(p.key)}
                      disabled={!writes || change.isPending}
                      onChange={(e) => {
                        change.mutate({
                          path: `/roles/${role}/permissions/${p.key}${e.target.checked ? '' : `?reason=${encodeURIComponent(why)}`}`,
                          method: e.target.checked ? 'PUT' : 'DELETE',
                          ...(e.target.checked ? { body: { reason: why } } : {}),
                        });
                      }}
                    />
                    <span>{inWords(p.key, p.description)}</span>
                    {p.isProtected || r.policies[p.key] === 'forbidden' ? (
                      <span className="chip chip-warning">Sensitive</span>
                    ) : null}
                    {showKeys ? <code>{p.key}</code> : null}
                  </label>
                ))}
              </details>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
