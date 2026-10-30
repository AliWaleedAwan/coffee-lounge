/**
 * Reports (FINANCE_REPORTING.md §6; UI_UX.md §5; Phase 6 steps 6.2–6.4). The overview opens
 * first: the headline tiles against the same weekday(s) last week, sales by day and by hour,
 * the top items, and what is open in the inboxes. Every tile and every chart opens the report
 * behind it, and a report's rows open the next level down (a day → its items; an item → its
 * days). Figures come from the server exactly as the exports will (AC-RPT-1); costs and
 * margins only for those who may see them.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';

type Cell = string | number | null;
interface Column {
  key: string;
  label: string;
  kind: 'date' | 'text' | 'int' | 'qty' | 'money' | 'cost' | 'pct';
  total?: 'sum' | 'derived' | 'none';
  formula?: string;
}
interface Report {
  key: string;
  title: string;
  period: { from: string; to: string };
  columns: Column[];
  rows: Record<string, Cell>[];
  totals: Record<string, Cell>;
  footer: {
    period: string;
    businessDay: string;
    filters: string[];
    formulas: { column: string; formula: string }[];
    notes: string[];
    generatedAt: string;
  };
}
interface Tile {
  key: string;
  label: string;
  kind: Column['kind'];
  value: Cell;
  compare: Cell;
  change: string | null;
  report: string;
  note: string | null;
}
interface CatalogEntry {
  key: string;
  title: string;
  filters: string[];
  drillOnly: boolean;
}
interface Overview {
  period: { from: string; to: string };
  compare: { from: string; to: string };
  tiles: Tile[];
  coverage: string | null;
  byDay: { date: string; net_sales: string; orders: number }[];
  byHour: { hour: string; sales: string; orders: number }[];
  topItems: { item: string; items: number; net_sales: string; margin?: string | null }[];
  topByMargin: { item: string; items: number; net_sales: string; margin: string }[] | null;
  alerts: { operational: number; stock: number; ledger: number };
}

const TOPICS = { topics: ['cashier', 'inventory', 'expenses', 'ledger', 'alerts'] };
const number = (v: Cell, digits = 2) =>
  Number(v).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export function show(kind: Column['kind'], v: Cell): string {
  if (v === null || v === '') return '—';
  if (kind === 'money' || kind === 'cost') return `Rs ${number(v)}`;
  if (kind === 'pct') return `${number(v)} %`;
  if (kind === 'int') return Number(v).toLocaleString('en-US');
  if (kind === 'qty') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 });
  return String(v);
}

function today(): string {
  const d = new Date();
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** The period presets (Monday-to-Sunday weeks, FINANCE_REPORTING.md §1). */
function preset(name: string): { from: string; to: string } {
  const t = today();
  const weekday = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monthStart = `${t.slice(0, 7)}-01`;
  switch (name) {
    case 'yesterday':
      return { from: shift(t, -1), to: shift(t, -1) };
    case 'week':
      return { from: shift(t, -weekday), to: t };
    case 'month':
      return { from: monthStart, to: t };
    case 'last-month': {
      const end = shift(monthStart, -1);
      return { from: `${end.slice(0, 7)}-01`, to: end };
    }
    default:
      return { from: t, to: t };
  }
}

export function ReportsScreen() {
  const [params, setParams] = useSearchParams();
  const catalog = useQuery({
    queryKey: ['reports', 'catalog'],
    queryFn: ({ signal }) => api<{ items: CatalogEntry[] }>('/reports', { signal }),
  });
  // The overview is built from the sales reports; without them (a stock clerk) the first
  // report the person may open comes up instead.
  const items = catalog.data?.items ?? [];
  const overview = items.some((r) => r.key === 'sales-by-day');
  const open =
    params.get('report') ?? (overview ? null : (items.find((r) => !r.drillOnly)?.key ?? null));
  const entry = catalog.data?.items.find((r) => r.key === open);
  const goTo = (report: string | null, extra: Record<string, string> = {}) => {
    setParams(report ? { report, ...extra } : {});
  };
  return (
    <>
      <h1>Reports</h1>
      <div className="tabs" role="tablist" aria-label="Reports">
        {overview ? (
          <button
            type="button"
            role="tab"
            id="reports-tab-overview"
            aria-selected={open === null}
            aria-controls="reports-panel"
            onClick={() => {
              goTo(null);
            }}
          >
            Overview
          </button>
        ) : null}
        {items
          .filter((r) => !r.drillOnly)
          .map((r) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              id={`reports-tab-${r.key}`}
              aria-selected={open === r.key}
              aria-controls="reports-panel"
              onClick={() => {
                goTo(r.key);
              }}
            >
              {r.title}
            </button>
          ))}
      </div>
      <div
        id="reports-panel"
        role="tabpanel"
        {...(entry?.drillOnly
          ? { 'aria-label': entry.title }
          : { 'aria-labelledby': `reports-tab-${open ?? 'overview'}` })}
        className="stack"
      >
        {catalog.isPending ? null : open === null ? (
          <OverviewPanel onOpen={goTo} />
        ) : entry ? (
          <ReportPanel key={open} entry={entry} onOpen={goTo} />
        ) : null}
      </div>
    </>
  );
}

function PeriodPicker({
  value,
  onChange,
}: {
  value: { from: string; to: string };
  onChange: (p: { from: string; to: string }) => void;
}) {
  return (
    <div className="row" role="group" aria-label="Period">
      {[
        ['today', 'Today'],
        ['yesterday', 'Yesterday'],
        ['week', 'This week'],
        ['month', 'This month'],
        ['last-month', 'Last month'],
      ].map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            onChange(preset(key ?? 'today'));
          }}
        >
          {label}
        </button>
      ))}
      <Field
        label="From"
        type="date"
        value={value.from}
        max={value.to}
        onChange={(e) => {
          onChange({ ...value, from: e.target.value });
        }}
      />
      <Field
        label="To"
        type="date"
        value={value.to}
        min={value.from}
        onChange={(e) => {
          onChange({ ...value, to: e.target.value });
        }}
      />
    </div>
  );
}

function OverviewPanel({
  onOpen,
}: {
  onOpen: (report: string, extra?: Record<string, string>) => void;
}) {
  const [period, setPeriod] = useState(() => preset('today'));
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(period.from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(period.to) &&
    period.from <= period.to;
  const data = useQuery({
    queryKey: ['reports', 'overview', period.from, period.to],
    queryFn: ({ signal }) =>
      api<Overview>(`/reports/overview?${new URLSearchParams(period).toString()}`, { signal }),
    meta: TOPICS,
    enabled: valid,
    placeholderData: (previous) => previous,
  });
  const o = data.data;
  const range = { from: period.from, to: period.to };
  return (
    <>
      <PeriodPicker value={period} onChange={setPeriod} />
      {data.isPending ? <Loading label="Loading the overview" /> : null}
      {data.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(data.error)}
        </div>
      ) : null}
      {o ? (
        <>
          <section aria-label="Headline figures" className="tiles">
            {o.tiles.map((t) => (
              <button
                key={t.key}
                type="button"
                className="card tile"
                onClick={() => {
                  onOpen(t.report, range);
                }}
              >
                <span className="tile-label">{t.label}</span>
                <strong className="tile-value">
                  {t.key === 'operating_result' && t.value === null
                    ? 'Needs recipes'
                    : show(t.kind, t.value)}
                </strong>
                <span className="muted">
                  {t.change === null
                    ? `Last week: ${show(t.kind, t.compare)}`
                    : `${Number(t.change) >= 0 ? '▲' : '▼'} ${t.change.replace('-', '')} % vs last week`}
                </span>
                {t.note ? <span className="muted">{t.note}</span> : null}
              </button>
            ))}
          </section>
          <div className="row overview-row">
            <Chart
              title="Net sales by day"
              rows={o.byDay.map((d) => ({ label: d.date, value: Number(d.net_sales) }))}
              onOpen={() => {
                onOpen('sales-by-day', range);
              }}
            />
            <Chart
              title="Sales by hour"
              rows={o.byHour.map((h) => ({ label: h.hour, value: Number(h.sales) }))}
              onOpen={() => {
                onOpen('sales-by-hour', range);
              }}
            />
          </div>
          <div className="row overview-row">
            <section className="card stack" aria-labelledby="top-items">
              <h2 id="top-items">Top items by sales</h2>
              <ItemList rows={o.topItems} showMargin={o.topByMargin !== null} />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  onOpen('sales-by-item', range);
                }}
              >
                All items
              </button>
            </section>
            {o.topByMargin ? (
              <section className="card stack" aria-labelledby="top-margin">
                <h2 id="top-margin">Top items by margin</h2>
                {o.coverage !== null && Number(o.coverage) < 100 ? (
                  <p className="muted">Recipe items only: COGS coverage {o.coverage} %.</p>
                ) : null}
                <ItemList rows={o.topByMargin} showMargin />
              </section>
            ) : null}
            <section className="card stack" aria-labelledby="open-items">
              <h2 id="open-items">Waiting for someone</h2>
              <ul>
                <li>
                  <Link to="/operations">{o.alerts.operational} in the operations inbox</Link>
                </li>
                <li>
                  <Link to="/inventory">{o.alerts.stock} stock alerts</Link>
                </li>
                {o.alerts.ledger > 0 ? (
                  <li>
                    <Link to="/ledger">{o.alerts.ledger} ledger check problems</Link>
                  </li>
                ) : null}
              </ul>
            </section>
          </div>
          <p className="muted">
            Compared with{' '}
            {o.compare.from === o.compare.to
              ? o.compare.from
              : `${o.compare.from} to ${o.compare.to}`}{' '}
            (the same weekdays a week earlier). Business days run from 04:00 to 03:59.
          </p>
        </>
      ) : null}
    </>
  );
}

function ItemList({
  rows,
  showMargin,
}: {
  rows: { item: string; items: number; net_sales: string; margin?: string | null }[];
  showMargin: boolean;
}) {
  if (rows.length === 0) return <p className="muted">Nothing sold in this period.</p>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Sold</th>
          <th scope="col">Net sales</th>
          {showMargin ? <th scope="col">Margin</th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.item}>
            <td>{r.item}</td>
            <td>{r.items}</td>
            <td>{show('money', r.net_sales)}</td>
            {showMargin ? <td>{show('pct', r.margin ?? null)}</td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A plain bar chart with its numbers beside it (P6-5): readable on screen, on paper and by screen readers. */
function Chart({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: { label: string; value: number }[];
  onOpen: () => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const width = 28;
  const height = 120;
  const busy = rows.filter((r) => r.value !== 0);
  return (
    <section className="card stack chart" aria-label={title}>
      <h2>{title}</h2>
      <svg
        role="img"
        aria-label={`${title}: ${busy.length === 0 ? 'nothing yet' : busy.map((r) => `${r.label} Rs ${r.value.toFixed(0)}`).join(', ')}`}
        viewBox={`0 0 ${String(rows.length * width)} ${String(height + 16)}`}
        className="chart-svg"
      >
        {rows.map((r, i) => {
          const h = Math.round((r.value / max) * height);
          return (
            <g key={r.label}>
              <rect
                x={i * width + 4}
                y={height - h}
                width={width - 8}
                height={h}
                className="chart-bar"
              />
              {rows.length <= 31 && i % Math.ceil(rows.length / 8) === 0 ? (
                <text
                  x={i * width + width / 2}
                  y={height + 12}
                  textAnchor="middle"
                  className="chart-label"
                >
                  {r.label.length > 5 ? r.label.slice(8) : r.label.slice(0, 2)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <details>
        <summary>Numbers</summary>
        <table className="data">
          <tbody>
            {busy.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td>{show('money', r.value.toFixed(2))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <div>
        <button type="button" className="btn btn-ghost" onClick={onOpen}>
          Open the report<span className="visually-hidden"> {title}</span>
        </button>
      </div>
    </section>
  );
}

const ORDER_TYPES = [
  { value: '', label: 'All order types' },
  { value: 'dine_in', label: 'Dine-in' },
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'delivery', label: 'Delivery' },
];
const KINDS = [
  { value: '', label: 'Everything' },
  { value: 'promotion', label: 'Promotions' },
  { value: 'discount', label: 'Discounts' },
  { value: 'comp', label: 'Comps' },
  { value: 'refund', label: 'Refunds' },
];
const WASTE_KINDS = [
  { value: '', label: 'All waste' },
  { value: 'ingredient', label: 'Ingredients' },
  { value: 'prepared_item', label: 'Prepared items' },
  { value: 'expired_lot', label: 'Expired lots' },
  { value: 'failed_delivery', label: 'Failed deliveries' },
];
const RECORDS = [
  { value: '', label: 'Every record' },
  { value: 'invoice', label: 'Bills' },
  { value: 'order_round', label: 'Orders' },
  { value: 'dining_session', label: 'Tables and sessions' },
  { value: 'delivery_order', label: 'Deliveries' },
  { value: 'cash_shift', label: 'Cash shifts' },
  { value: 'expense', label: 'Expenses' },
  { value: 'ledger_entry', label: 'Ledger entries' },
  { value: 'purchase_receipt', label: 'Purchase receipts' },
  { value: 'inventory_item', label: 'Stock items' },
  { value: 'stock_count', label: 'Stock counts' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'menu_variant', label: 'Menu' },
  { value: 'asset', label: 'Assets' },
  { value: 'user', label: 'People' },
  { value: 'device', label: 'Devices' },
  { value: 'setting', label: 'Settings' },
];
/** Who the staff filter picks, in each report's own words. */
const STAFF_LABEL: Record<string, string> = {
  discounts: 'By',
  'staff-activity': 'Person',
  'audit-log': 'Who',
};
const CHANNELS = [
  { value: '', label: 'All channels' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'other', label: 'Other' },
];
const STATUSES = [
  { value: '', label: 'All outcomes' },
  { value: 'pending_dispatch', label: 'Waiting to go' },
  { value: 'out_for_delivery', label: 'On the way' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'converted_to_pickup', label: 'Picked up instead' },
];
const FILTER_KEYS = [
  'orderType',
  'categoryId',
  'itemId',
  'staffId',
  'kind',
  'channel',
  'riderId',
  'status',
  'invoiceId',
  'stockCategory',
  'inventoryItemId',
  'supplierId',
  'entityType',
] as const;
type Names = { id: string; name: string }[];

/** A list of names for a filter, when the caller may read it (otherwise the filter is not offered). */
function useNames(key: string, path: string, enabled: boolean, pick: (body: unknown) => Names) {
  return useQuery({
    queryKey: ['reports', 'names', key],
    queryFn: async ({ signal }) => pick(await api<unknown>(path, { signal })),
    enabled,
    retry: false,
  });
}

function ReportPanel({
  entry,
  onOpen,
}: {
  entry: CatalogEntry;
  onOpen: (report: string | null, extra?: Record<string, string>) => void;
}) {
  const [params] = useSearchParams();
  const initial = preset('month');
  const [filters, setFilters] = useState<Record<string, string>>(() => ({
    from: params.get('from') ?? initial.from,
    to: params.get('to') ?? initial.to,
    ...Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])),
  }));
  const has = (k: string) => entry.filters.includes(k);
  const set = (k: string) => (v: string) => {
    setFilters({
      ...filters,
      [k]: v,
      ...(k === 'categoryId' ? { itemId: '' } : {}),
      ...(k === 'stockCategory' ? { inventoryItemId: '' } : {}),
    });
  };
  const menu = useQuery({
    queryKey: ['reports', 'menu'],
    queryFn: ({ signal }) =>
      api<{ categories: { id: string; name: string; items: { id: string; name: string }[] }[] }>(
        '/menu',
        {
          signal,
        },
      ),
    enabled: has('itemId') || (has('categoryId') && entry.key !== 'expenses'),
    retry: false,
  });
  const expenseCategories = useNames(
    'expense-categories',
    '/expense-categories',
    entry.key === 'expenses',
    (b) => (b as { items: Names }).items,
  );
  const staff = useNames(
    'staff',
    '/reports/staff',
    has('staffId'),
    (b) => (b as { items: Names }).items,
  );
  const stock = useQuery({
    queryKey: ['reports', 'stock-items'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; name: string; category: string | null }[]; categories: string[] }>(
        '/inventory/items',
        { signal },
      ),
    enabled: has('stockCategory') || has('inventoryItemId'),
    retry: false,
  });
  const suppliers = useNames(
    'suppliers',
    '/suppliers?includeInactive=true',
    has('supplierId'),
    (b) => (b as { items: Names }).items,
  );
  const riders = useNames(
    'riders',
    '/riders?all=true',
    has('riderId'),
    (b) => (b as { items: Names }).items,
  );
  const query = new URLSearchParams(
    Object.entries(filters).filter(([k, v]) => v !== '' && (k === 'from' || k === 'to' || has(k))),
  ).toString();
  const valid =
    filters['from'] !== '' &&
    filters['to'] !== '' &&
    (filters['from'] ?? '') <= (filters['to'] ?? '');
  const report = useQuery({
    queryKey: ['reports', entry.key, query],
    queryFn: ({ signal }) => api<Report>(`/reports/${entry.key}?${query}`, { signal }),
    meta: TOPICS,
    enabled: valid,
    placeholderData: (previous) => previous,
  });
  const r = report.data;
  const categories = menu.data?.categories ?? [];
  const items = categories.flatMap((c) =>
    (filters['categoryId'] ?? '') === '' || c.id === filters['categoryId'] ? c.items : [],
  );
  const period = { from: filters['from'] ?? '', to: filters['to'] ?? '' };
  const drill = (row: Record<string, Cell>): (() => void) | null => {
    const id = typeof row['id'] === 'string' ? row['id'] : null;
    if (entry.key === 'sales-by-day' && typeof row['date'] === 'string') {
      const day = row['date'];
      return () => {
        onOpen('bills', { from: day, to: day });
      };
    }
    if ((entry.key === 'bills' || entry.key === 'discounts') && id) {
      return () => {
        onOpen('bill-lines', { ...period, invoiceId: id });
      };
    }
    if ((entry.key === 'sales-by-item' || entry.key === 'menu-engineering') && id) {
      return () => {
        onOpen('sales-by-day', { ...period, itemId: id });
      };
    }
    return null;
  };
  const select = (k: string, label: string, options: { value: string; label: string }[]) => (
    <SelectField label={label} value={filters[k] ?? ''} options={options} onChange={set(k)} />
  );
  return (
    <>
      {entry.drillOnly ? (
        <div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              onOpen('bills', period);
            }}
          >
            Back to the bills
          </button>
        </div>
      ) : (
        <PeriodPicker
          value={period}
          onChange={(p) => {
            setFilters({ ...filters, ...p });
          }}
        />
      )}
      <div className="row" role="group" aria-label="Filters">
        {has('orderType') ? select('orderType', 'Order type', ORDER_TYPES) : null}
        {has('categoryId') && entry.key === 'expenses' && expenseCategories.data
          ? select('categoryId', 'Category', [
              { value: '', label: 'All categories' },
              ...expenseCategories.data.map((c) => ({ value: c.id, label: c.name })),
            ])
          : null}
        {has('categoryId') && entry.key !== 'expenses' && categories.length > 0
          ? select('categoryId', 'Category', [
              { value: '', label: 'All categories' },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ])
          : null}
        {has('itemId') && categories.length > 0
          ? select('itemId', 'Item', [
              { value: '', label: 'All items' },
              ...items.map((i) => ({ value: i.id, label: i.name })),
            ])
          : null}
        {has('staffId') && staff.data
          ? select('staffId', STAFF_LABEL[entry.key] ?? 'Settled by', [
              { value: '', label: 'Anyone' },
              ...staff.data.map((p) => ({ value: p.id, label: p.name })),
            ])
          : null}
        {has('kind') ? select('kind', 'What', entry.key === 'waste' ? WASTE_KINDS : KINDS) : null}
        {has('stockCategory') && stock.data
          ? select('stockCategory', 'Stock category', [
              { value: '', label: 'All categories' },
              ...stock.data.categories.map((c) => ({ value: c, label: c })),
            ])
          : null}
        {has('inventoryItemId') && stock.data
          ? select('inventoryItemId', 'Stock item', [
              { value: '', label: 'All items' },
              ...stock.data.items
                .filter(
                  (i) =>
                    (filters['stockCategory'] ?? '') === '' ||
                    i.category === filters['stockCategory'],
                )
                .map((i) => ({ value: i.id, label: i.name })),
            ])
          : null}
        {has('supplierId') && suppliers.data
          ? select('supplierId', 'Supplier', [
              { value: '', label: 'All suppliers' },
              ...suppliers.data.map((p) => ({ value: p.id, label: p.name })),
            ])
          : null}
        {has('entityType') ? select('entityType', 'Record', RECORDS) : null}
        {has('channel') ? select('channel', 'Channel', CHANNELS) : null}
        {has('riderId') && riders.data
          ? select('riderId', 'Rider', [
              { value: '', label: 'Any rider' },
              ...riders.data.map((p) => ({ value: p.id, label: p.name })),
            ])
          : null}
        {has('status') ? select('status', 'Outcome', STATUSES) : null}
      </div>
      {report.isPending && valid ? <Loading label="Loading the report" /> : null}
      {report.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(report.error)}
        </div>
      ) : null}
      {r ? (
        <section className="card stack" aria-labelledby="report-head">
          <h2 id="report-head">
            {r.title} · {r.footer.period}
          </h2>
          {r.footer.notes.map((n) => (
            <p key={n} className="banner banner-warning">
              {n}
            </p>
          ))}
          {r.rows.length === 0 ? <p className="muted">Nothing in this period.</p> : null}
          <div className="table-scroll">
            <table className="data" aria-label={r.title}>
              <thead>
                <tr>
                  {r.columns.map((c) => (
                    <th key={c.key} scope="col">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => {
                  const open = drill(row);
                  return (
                    <tr key={String(row['id'] ?? row['date'] ?? row['hour'] ?? i) + String(i)}>
                      {r.columns.map((c, j) => (
                        <td key={c.key}>
                          {j === 0 && open ? (
                            <button type="button" className="btn-link" onClick={open}>
                              {show(c.kind, row[c.key] ?? null)}
                            </button>
                          ) : (
                            show(c.kind, row[c.key] ?? null)
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  {r.columns.map((c, j) => (
                    <th key={c.key} scope={j === 0 ? 'row' : undefined}>
                      {j === 0 ? 'Total' : show(c.kind, r.totals[c.key] ?? null)}
                    </th>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <details>
            <summary>How these figures are worked out</summary>
            <ul>
              <li>{r.footer.businessDay}</li>
              {r.footer.filters.length > 0 ? (
                <li>Filters: {r.footer.filters.join(' · ')}</li>
              ) : null}
              {r.footer.formulas.map((f) => (
                <li key={f.column}>
                  <strong>{f.column}</strong>: {f.formula}
                </li>
              ))}
              <li>Worked out at {new Date(r.footer.generatedAt).toLocaleString('en-GB')}</li>
            </ul>
          </details>
        </section>
      ) : null}
    </>
  );
}
