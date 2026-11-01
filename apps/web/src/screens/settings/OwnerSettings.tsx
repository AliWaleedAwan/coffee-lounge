/**
 * Owner settings used so far (UI_UX.md §6 Owner: "Settings (shop, branding, tables & QR,
 * printer & templates, thresholds)"; AT-130). Each value is saved on its own with the
 * version it was read at, so two people editing cannot overwrite each other unseen. The
 * brand colour is checked live for AA contrast, and the server refuses one that fails.
 */
import { brandColourProblem, contrastRatio } from '@cl/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { Link } from 'react-router';
import { api, messageOf } from '../../api/client.ts';
import { CheckField, Field, SelectField, TextAreaField } from '../../components/Field.tsx';
import { permissionSet } from '../../auth/session.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { useSignedIn } from '../Shell.tsx';
import { Loading } from '../../components/Loading.tsx';

interface Setting {
  key: string;
  value: unknown;
  version: number;
  label: string;
  group: string;
  hint: string;
  editable: boolean;
  /** Owner-only (settings.financial). */
  financial: boolean;
}

interface Branding {
  shopName: string;
  addressLine: string | null;
  phone: string | null;
  footer: string;
  primary: string;
  version: number;
}

function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => api<{ items: Setting[]; branding: Branding }>('/settings', { signal }),
  });
}

function useSave<T>(onDone?: (r: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (w: { path: string; method: 'PATCH' | 'PUT'; body: unknown }) =>
      api<T>(w.path, { method: w.method, body: w.body }),
    onSuccess: (r) => {
      onDone?.(r);
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['settings'] }),
        client.invalidateQueries({ queryKey: ['branding'] }),
      ]);
    },
  });
}

export function OwnerSettings() {
  const settings = useSettings();
  if (settings.isError) {
    return (
      <div role="alert" className="banner banner-danger">
        {messageOf(settings.error)}
      </div>
    );
  }
  if (!settings.data) return <Loading label="Loading settings" />;
  const items = settings.data.items;
  const hours = items.find((s) => s.key === 'shop.business_hours');
  const groups = [
    ...new Set(items.filter((s) => s.key !== 'shop.business_hours').map((s) => s.group)),
  ];
  return (
    <>
      <BrandingForm branding={settings.data.branding} />
      {hours ? <Hours setting={hours} /> : null}
      <section className="card stack" aria-labelledby="thresholds">
        <h2 id="thresholds">Thresholds and lists</h2>
        <p className="muted">
          Expense categories are kept on <Link to="/expenses">Expenses</Link> → Categories.
        </p>
        {groups.map((g) => (
          <fieldset key={g} className="card stack">
            <legend>{g}</legend>
            {items
              .filter((s) => s.group === g && s.key !== 'shop.business_hours')
              .map((s) => (
                <SettingRow key={s.key} setting={s} />
              ))}
          </fieldset>
        ))}
      </section>
    </>
  );
}

function SettingRow({ setting }: { setting: Setting }) {
  const writes = useWritesAllowed();
  const mayFinancial = permissionSet(useSignedIn()).has('settings.financial');
  const isList = Array.isArray(setting.value);
  const [value, setValue] = useState(
    isList ? (setting.value as string[]).join('\n') : String(setting.value),
  );
  const [saved, setSaved] = useState(false);
  const save = useSave(() => {
    setSaved(true);
  });
  const kind = isList
    ? 'list'
    : typeof setting.value === 'boolean'
      ? 'boolean'
      : typeof setting.value === 'number'
        ? 'number'
        : setting.key === 'billing.cash_rounding_unit'
          ? 'rounding'
          : 'text';
  const parsed: unknown =
    kind === 'list'
      ? value
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : kind === 'boolean'
        ? value === 'true'
        : kind === 'number'
          ? Number(value)
          : value;
  const changed = JSON.stringify(parsed) !== JSON.stringify(setting.value);
  const send = () => {
    setSaved(false);
    save.mutate({
      path: `/settings/${setting.key}`,
      method: 'PATCH',
      body: { value: parsed, expectedVersion: setting.version },
    });
  };
  const canEdit = setting.editable && (!setting.financial || mayFinancial);
  if (!canEdit) {
    return (
      <p>
        <strong>{setting.label}:</strong>{' '}
        {Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value)}{' '}
        <span className="muted">
          · {setting.editable ? 'the owner changes this' : setting.hint}
        </span>
      </p>
    );
  }
  return (
    <form
      className="row setting-row"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (writes && changed) send();
      }}
    >
      {kind === 'list' ? (
        <TextAreaField
          label={setting.label}
          hint={setting.hint}
          rows={6}
          value={value}
          onChange={setValue}
        />
      ) : kind === 'boolean' ? (
        <CheckField
          label={setting.label}
          checked={value === 'true'}
          onChange={(c) => {
            setValue(String(c));
          }}
        />
      ) : kind === 'rounding' ? (
        <SelectField
          label={setting.label}
          value={value}
          options={['1.00', '5.00', '10.00'].map((v) => ({
            value: v,
            label: `Rs ${String(Number(v))}`,
          }))}
          onChange={setValue}
        />
      ) : (
        <Field
          label={setting.label}
          inputMode={kind === 'number' ? 'numeric' : 'decimal'}
          hint={setting.hint}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
      )}
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={!writes || !changed || save.isPending}
      >
        Save <span className="visually-hidden">{setting.label}</span>
      </button>
      {save.isError ? (
        <span role="alert" className="field-error">
          {messageOf(save.error)}
        </span>
      ) : null}
      {saved && !changed ? (
        <span role="status" className="muted">
          Saved
        </span>
      ) : null}
    </form>
  );
}

function Hours({ setting }: { setting: Setting }) {
  const writes = useWritesAllowed();
  const current = setting.value as { opens: string; closes: string };
  const [always, setAlways] = useState(current.opens === current.closes);
  const [opens, setOpens] = useState(always ? '08:00' : current.opens);
  const [closes, setCloses] = useState(always ? '23:00' : current.closes);
  const [saved, setSaved] = useState(false);
  const save = useSave(() => {
    setSaved(true);
  });
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!writes) return;
    setSaved(false);
    save.mutate({
      path: '/settings/shop.business_hours',
      method: 'PATCH',
      body: {
        value: always ? { opens: '00:00', closes: '00:00' } : { opens, closes },
        expectedVersion: setting.version,
      },
    });
  };
  return (
    <form className="card stack" noValidate onSubmit={submit} aria-labelledby="hours">
      <h2 id="hours">Guest ordering hours</h2>
      <p className="muted">{setting.hint}.</p>
      <CheckField label="Guests can order at any time" checked={always} onChange={setAlways} />
      {always ? null : (
        <div className="row">
          <Field
            label="Opens"
            type="time"
            value={opens}
            onChange={(e) => {
              setOpens(e.target.value);
            }}
          />
          <Field
            label="Closes"
            type="time"
            value={closes}
            onChange={(e) => {
              setCloses(e.target.value);
            }}
          />
        </div>
      )}
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="muted">
          Saved. Guests see it at once.
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!writes || save.isPending || (!always && opens === closes)}
        >
          Save hours
        </button>
      </div>
    </form>
  );
}

function BrandingForm({ branding }: { branding: Branding }) {
  const writes = useWritesAllowed();
  const [form, setForm] = useState({
    shopName: branding.shopName,
    addressLine: branding.addressLine ?? '',
    phone: branding.phone ?? '',
    footer: branding.footer,
    primary: branding.primary,
  });
  const [saved, setSaved] = useState(false);
  const save = useSave(() => {
    setSaved(true);
  });
  const valid = /^#[0-9a-fA-F]{6}$/.test(form.primary);
  const problem = brandColourProblem(form.primary);
  const ratio = valid ? contrastRatio(form.primary, '#FFFFFF') : null;
  const set = (key: keyof typeof form) => (value: string) => {
    setSaved(false);
    setForm({ ...form, [key]: value });
  };
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!writes || problem || !form.shopName.trim()) return;
    save.mutate({
      path: '/settings/branding',
      method: 'PUT',
      body: { ...form, expectedVersion: branding.version },
    });
  };
  return (
    <form className="card stack" noValidate onSubmit={submit} aria-labelledby="branding">
      <h2 id="branding">Shop and branding</h2>
      <p className="muted">
        The name shows on every screen and on receipts; the address, phone and footer on receipts.
      </p>
      <div className="row">
        <Field
          label="Shop name"
          maxLength={40}
          value={form.shopName}
          onChange={(e) => {
            set('shopName')(e.target.value);
          }}
        />
        <Field
          label="Receipt phone"
          maxLength={30}
          value={form.phone}
          onChange={(e) => {
            set('phone')(e.target.value);
          }}
        />
      </div>
      <Field
        label="Receipt address line"
        maxLength={80}
        value={form.addressLine}
        onChange={(e) => {
          set('addressLine')(e.target.value);
        }}
      />
      <Field
        label="Receipt footer"
        hint="Once a receipt design is saved, the Receipt design page sets the bottom of the receipt instead."
        maxLength={80}
        value={form.footer}
        onChange={(e) => {
          set('footer')(e.target.value);
        }}
      />
      <div className="row brand-row">
        <Field
          label="Brand colour"
          maxLength={7}
          value={form.primary}
          error={valid ? problem : 'Use a colour like #6B4435'}
          hint={
            ratio && !problem
              ? `White text on it: ${ratio.toFixed(1)}:1 (AA needs 4.5:1)`
              : undefined
          }
          onChange={(e) => {
            set('primary')(e.target.value);
          }}
        />
        <label className="field">
          <span>Pick</span>
          <input
            type="color"
            aria-label="Pick a brand colour"
            value={valid ? form.primary : '#6B4435'}
            onChange={(e) => {
              set('primary')(e.target.value.toUpperCase());
            }}
          />
        </label>
        <span
          className="btn btn-lg brand-preview"
          aria-hidden="true"
          style={valid ? { background: form.primary } : undefined}
        >
          Send order
        </span>
      </div>
      {save.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(save.error)}
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="muted">
          Saved. Every screen and the next receipts use it.
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!writes || save.isPending || problem !== null || !form.shopName.trim()}
        >
          Save branding
        </button>
      </div>
    </form>
  );
}
