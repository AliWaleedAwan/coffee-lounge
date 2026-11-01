/**
 * Reports (FINANCE_REPORTING.md §6–§8; UI_UX.md §5; Phase 6 steps 6.2–6.5). The overview opens
 * first: the headline tiles against the same weekday(s) last week, sales by day and by hour,
 * the top items, and what is open in the inboxes. Every tile and every chart opens the report
 * behind it, and a report's rows open the next level down (a day → its items; an item → its
 * days). Figures come from the server exactly as the exports will (AC-RPT-1); costs and
 * margins only for those who may see them. With `reports.export`, each report downloads as
 * CSV or PDF (the same figures); the day-end of a finished business date shows, downloads
 * as a PDF and prints on the counter's receipt printer.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { API_BASE, api, messageOf } from '../../api/client.ts';
import { permissionSet, useMe } from '../../auth/session.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { Chart3D, type ChartKind } from './Chart3D.tsx';
import { Loading } from '../../components/Loading.tsx';
import { EmailsPanel } from './EmailsPanel.tsx';

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
  formats: ('csv' | 'pdf')[];
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

/**
 * The shop's business date, as the server last said (`GET /reports`): between midnight and
 * the 04:00 cutoff it is still yesterday's calendar date (D-22). The screen waits for the
 * catalogue before showing a period, so this is set first; the PC's date is only a fallback.
 */
let businessToday: string | null = null;
function today(): string {
  if (businessToday) return businessToday;
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
    case 'last-14':
      return { from: shift(t, -13), to: t };
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
    queryFn: async ({ signal }) => {
      const body = await api<{ today: string; items: CatalogEntry[] }>('/reports', { signal });
      businessToday = body.today;
      return body;
    },
  });
  // The overview is built from the sales reports; without them (a stock clerk) the first
  // report the person may open comes up instead.
  const items = catalog.data?.items ?? [];
  const overview = items.some((r) => r.key === 'sales-by-day');
  const me = useMe();
  const schedules = me.data ? permissionSet(me.data).has('reports.schedule') : false;
  const open =
    params.get('report') ?? (overview ? null : (items.find((r) => !r.drillOnly)?.key ?? null));
  const entry = catalog.data?.items.find((r) => r.key === open);
  const goTo = (report: string | null, extra: Record<string, string> = {}) => {
    setParams(report ? { report, ...extra } : {});
  };
  return (
    <>
      <h1>Reports</h1>
      <div className="report-picker">
        <SelectField
          label="Report"
          value={open ?? 'overview'}
          options={[
            ...(overview
              ? [
                  { value: 'overview', label: 'Overview' },
                  { value: 'day-end', label: 'Day-end' },
                ]
              : []),
            ...(schedules ? [{ value: 'emails', label: 'E-mails' }] : []),
            ...items.filter((r) => !r.drillOnly).map((r) => ({ value: r.key, label: r.title })),
            // Reached from another report: shown, so the box says where you are.
            ...(entry?.drillOnly ? [{ value: entry.key, label: entry.title }] : []),
          ]}
          onChange={(v) => {
            goTo(v === 'overview' ? null : v);
          }}
        />
      </div>
      <div
        id="reports-panel"
        aria-label={entry?.title ?? (open === null ? 'Overview' : open)}
        className="stack"
      >
        {catalog.isPending ? null : open === null ? (
          <OverviewPanel onOpen={goTo} />
        ) : open === 'day-end' && overview ? (
          <DayEndPanel />
        ) : open === 'emails' && schedules ? (
          <EmailsPanel
            reports={items.filter((r) => !r.drillOnly).map((r) => ({ key: r.key, title: r.title }))}
          />
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
  const keys = ['today', 'yesterday', 'week', 'last-14', 'month', 'last-month'] as const;
  const current = keys.find((k) => {
    const p = preset(k);
    return p.from === value.from && p.to === value.to;
  });
  const [custom, setCustom] = useState(false);
  return (
    <div className="row" role="group" aria-label="Dates">
      <SelectField
        label="Period"
        value={custom || !current ? 'custom' : current}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'yesterday', label: 'Yesterday' },
          { value: 'week', label: 'This week' },
          { value: 'last-14', label: 'Last 14 days' },
          { value: 'month', label: 'This month' },
          { value: 'last-month', label: 'Last month' },
          { value: 'custom', label: 'Choose dates…' },
        ]}
        onChange={(v) => {
          setCustom(v === 'custom');
          if (v !== 'custom') onChange(preset(v));
        }}
      />
      {custom || !current ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

function OverviewPanel({
  onOpen,
}: {
  onOpen: (report: string, extra?: Record<string, string>) => void;
}) {
  // A trend needs more than one day to show anything.
  const [period, setPeriod] = useState(() => preset('last-14'));
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
              initial="line"
              rows={o.byDay.map((d) => ({ label: d.date, value: Number(d.net_sales) }))}
              onOpen={() => {
                onOpen('sales-by-day', range);
              }}
            />
            <Chart
              title="Sales by hour"
              initial="column"
              rows={o.byHour.map((h) => ({ label: h.hour, value: Number(h.sales) }))}
              onOpen={() => {
                onOpen('sales-by-hour', range);
              }}
            />
          </div>
          <div className="row overview-row">
            <Chart
              title="Share of sales by item"
              initial="pie"
              rows={o.topItems.map((i) => ({ label: i.item, value: Number(i.net_sales) }))}
            />
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

/** A chart the reader can change, with its numbers beneath (P6-5). */
function Chart({
  title,
  rows,
  initial,
  onOpen,
}: {
  title: string;
  rows: { label: string; value: number }[];
  initial: ChartKind;
  onOpen?: () => void;
}) {
  const busy = rows.filter((r) => r.value !== 0);
  return (
    <section className="card stack chart" aria-label={title}>
      <h2>{title}</h2>
      <Chart3D title={title} rows={rows} initial={initial} />
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
      <div hidden={!onOpen}>
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
  const me = useMe();
  const canExport = me.data ? permissionSet(me.data).has('reports.export') : false;
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
          {canExport ? (
            <div className="row" role="group" aria-label="Download">
              {entry.formats.map((f) => (
                <a
                  key={f}
                  className="btn btn-ghost"
                  href={`${API_BASE}/reports/${entry.key}/export?format=${f}&${query}`}
                  download
                >
                  Download {f.toUpperCase()}
                </a>
              ))}
            </div>
          ) : null}
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

interface DayEndView {
  date: string;
  generatedAt: string;
  report: {
    sales: Record<string, string | number | null>;
    byOrderType: { type: string; label: string; orders: number; net_sales: string }[];
    payments: {
      method: string;
      payments: number;
      taken: string;
      refunded: string;
      collected: string;
    }[];
    openBills: { count: number; value: string };
    cod: { rider: string; deliveries: number; amount: string }[];
    shifts: {
      till: string;
      cashier: string;
      status: string;
      expected: string | null;
      counted: string | null;
      variance: string | null;
      reason: string | null;
      approved_by: string | null;
    }[];
    voids: { events: number; units: number; value: string };
    waste: { records: number; cost: string | null };
    topItems: { item: string; items: number; net_sales: string; margin: string | null }[];
    profit: Record<string, string | null> | null;
    alerts: { kind: string; label: string; open: number }[];
  };
}

/** Label and value rows (the day-end's figures). */
function Figures({ label, rows }: { label: string; rows: [string, string][] }) {
  return (
    <table className="data" aria-label={label}>
      <tbody>
        {rows.map(([name, value]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td className="num">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The day-end of a finished business date (FINANCE_REPORTING.md §7; P6-9): made once after
 * the 04:00 cutoff and kept, so the screen, the PDF and the printed slip agree.
 */
function DayEndPanel() {
  const [params, setParams] = useSearchParams();
  const yesterday = shift(today(), -1);
  const date = params.get('date') ?? yesterday;
  const me = useMe();
  const canExport = me.data ? permissionSet(me.data).has('reports.export') : false;
  const dayEnd = useQuery({
    queryKey: ['reports', 'day-end', date],
    queryFn: ({ signal }) => api<DayEndView>(`/reports/day-end?date=${date}`, { signal }),
    retry: false,
  });
  const print = useMutation({
    mutationFn: () =>
      api<{ copyNo: number }>('/reports/day-end/print', { method: 'POST', body: { date } }),
  });
  const d = dayEnd.data?.report;
  const money = (v: string | number | null | undefined) => show('money', v ?? null);
  return (
    <>
      <div className="row">
        <Field
          label="Business date"
          type="date"
          value={date}
          max={yesterday}
          onChange={(e) => {
            print.reset();
            setParams({ report: 'day-end', date: e.target.value || yesterday });
          }}
        />
      </div>
      {dayEnd.isPending ? <Loading label="Loading the day-end" /> : null}
      {dayEnd.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(dayEnd.error)}
        </div>
      ) : null}
      {d && dayEnd.data ? (
        <section className="card stack" aria-labelledby="day-end-head">
          <h2 id="day-end-head">Day-end · Business date {dayEnd.data.date}</h2>
          <div className="row" role="group" aria-label="Download or print">
            {canExport ? (
              <a
                className="btn btn-ghost"
                href={`${API_BASE}/reports/day-end/export?format=pdf&date=${dayEnd.data.date}`}
                download
              >
                Download PDF
              </a>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={print.isPending}
              onClick={() => {
                print.mutate();
              }}
            >
              Print on the receipt printer
            </button>
          </div>
          {print.isSuccess ? (
            <p role="status" className="banner banner-success">
              Sent to the printer (copy {print.data.copyNo}).
            </p>
          ) : null}
          {print.isError ? (
            <div role="alert" className="banner banner-danger">
              {messageOf(print.error)}
            </div>
          ) : null}
          <div className="tiles">
            <Figures
              label="Sales"
              rows={[
                ['Gross sales', money(d.sales['gross'])],
                ['Promotions', money(d.sales['promotions'])],
                ['Manual discounts', money(d.sales['manual'])],
                ['Comps', money(d.sales['comps'])],
                ['Refunds', money(d.sales['refunds'])],
                ['Net sales', money(d.sales['net_sales'])],
                ['Cash rounding', money(d.sales['rounding'])],
                ['Orders', show('int', d.sales['orders'] ?? null)],
                ['Average order', money(d.sales['aov'])],
                ...d.byOrderType.map((o): [string, string] => [
                  `${o.label} (${String(o.orders)})`,
                  money(o.net_sales),
                ]),
              ]}
            />
            <Figures
              label="Collected by method"
              rows={d.payments.map((p): [string, string] => [p.method, money(p.collected)])}
            />
            <Figures
              label="Still open when the day ended"
              rows={[
                [`Open bills (${String(d.openBills.count)})`, money(d.openBills.value)],
                ...d.cod.map((c): [string, string] => [`COD with ${c.rider}`, money(c.amount)]),
                [`Voids (${String(d.voids.events)})`, money(d.voids.value)],
                ['Waste records', show('int', d.waste.records)],
                ...(d.waste.cost === null
                  ? []
                  : [['Waste cost', show('cost', d.waste.cost)] as [string, string]]),
                ...d.alerts.map((a): [string, string] => [a.label, show('int', a.open)]),
              ]}
            />
            {d.profit ? (
              <Figures
                label="Costs and margin"
                rows={[
                  ['COGS', show('cost', d.profit['cogs'] ?? null)],
                  ['COGS coverage', show('pct', d.profit['coverage'] ?? null)],
                  ['Gross profit after waste', show('cost', d.profit['gross_profit'] ?? null)],
                  ['Gross margin', show('pct', d.profit['margin'] ?? null)],
                  [
                    'Recorded operating result',
                    d.profit['needs_recipes'] ?? money(d.profit['operating_result']),
                  ],
                ]}
              />
            ) : null}
          </div>
          {d.shifts.length > 0 ? (
            <Figures
              label="Cash shifts"
              rows={d.shifts.map((x): [string, string] => [
                `${x.till}, ${x.cashier} (${x.status})`,
                x.variance === null ? 'Still open' : `Variance ${money(x.variance)}`,
              ])}
            />
          ) : (
            <p className="muted">No cash shift was opened this day.</p>
          )}
          <p className="muted">
            Made once, after the day ended; later changes to that day show in the reports.
          </p>
        </section>
      ) : null}
    </>
  );
}
