/**
 * A report as a file (FINANCE_REPORTING.md §8): the same CSV or PDF for a download on screen
 * (step 6.5) and for a scheduled e-mail (step 6.6), so the two can never differ.
 */
import { z } from 'zod';
import type { Queryable } from '../../platform/db/pool.ts';
import { AppError } from '../../platform/errors.ts';
import { readSetting } from '../../platform/settings.ts';
import { parseInput } from '../../platform/validation.ts';
import { readBranding } from '../settings/index.ts';
import { exportFileName, toCsv } from './csv.ts';
import { REPORTS } from './catalog.ts';
import { dayEndOf, dayEndView, type StoredDayEnd } from './day-end.ts';
import { runReport, type Report, type ReportDefinition } from './engine.ts';
import { renderDayEndPdf, renderReportPdf, type PdfBrand } from './pdf.ts';

export const FORMATS = ['csv', 'pdf'] as const;
export type Format = (typeof FORMATS)[number];

export interface ReportFile {
  name: string;
  contentType: string;
  body: Buffer;
}

/** Names for the footer and the file name instead of ids (FINANCE_REPORTING.md §6, §8). */
const LABEL_QUERIES: Record<string, string> = {
  categoryId: 'SELECT name FROM cl.menu_categories WHERE id = $1',
  itemId: 'SELECT name FROM cl.menu_items WHERE id = $1',
  staffId: 'SELECT display_name AS name FROM cl.users WHERE id = $1',
  riderId: 'SELECT display_name AS name FROM cl.staff_profiles WHERE id = $1',
  inventoryItemId: 'SELECT name FROM cl.inventory_items WHERE id = $1',
  supplierId: 'SELECT name FROM cl.suppliers WHERE id = $1',
};

export async function filterLabels(
  db: Queryable,
  filters: Record<string, unknown>,
  report: string,
): Promise<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const [key, sql] of Object.entries(LABEL_QUERIES)) {
    const value = filters[key];
    if (typeof value !== 'string') continue;
    // The expense report's categories are expense categories, not menu ones.
    const query =
      key === 'categoryId' && report === 'expenses'
        ? 'SELECT name FROM cl.expense_categories WHERE id = $1'
        : sql;
    const { rows } = await db.query<{ name: string }>(query, [value]);
    if (rows[0]) labels[key] = rows[0].name;
  }
  return labels;
}

async function pdfSetup(db: Queryable): Promise<{ brand: PdfBrand; timeZone: string }> {
  const branding = await readBranding(db);
  return {
    brand: {
      shopName: branding.shopName,
      addressLine: branding.addressLine,
      primary: branding.primary,
    },
    timeZone: await readSetting(db, 'shop.timezone', z.string().min(1)),
  };
}

export async function reportFile(
  db: Queryable,
  report: Report,
  labels: Record<string, string>,
  format: Format,
): Promise<ReportFile> {
  const name = exportFileName(report, labels, format);
  if (format === 'csv')
    return { name, contentType: 'text/csv; charset=utf-8', body: toCsv(report) };
  const { brand, timeZone } = await pdfSetup(db);
  return {
    name,
    contentType: 'application/pdf',
    body: await renderReportPdf(report, brand, { timeZone }),
  };
}

export async function dayEndFile(
  db: Queryable,
  d: StoredDayEnd,
  canProfit: boolean,
): Promise<ReportFile> {
  const { brand, timeZone } = await pdfSetup(db);
  const view = dayEndView(d.report, canProfit);
  return {
    name: `day-end_${d.date}.pdf`,
    contentType: 'application/pdf',
    body: await renderDayEndPdf({ ...view, generatedAt: d.generatedAt }, brand, { timeZone }),
  };
}

// ---------------------------------------------------------------- scheduled reports (step 6.6)

/** What a schedule may send: the day-end, or a report from the catalogue (not drill-downs). */
export function schedulable(key: string) {
  if (key === 'day-end') return { key, title: 'Day-end report', permission: 'reports.sales' };
  const def = REPORTS.find((r) => r.key === key && r.key !== 'bill-lines');
  return def ? { key: def.key, title: def.title, permission: def.permission } : null;
}

/** Checks a schedule's report and filters against the catalogue and what its owner may open. */
export function checkSchedule(
  key: string,
  filters: Record<string, unknown>,
  can: (permission: string) => boolean,
): void {
  const report = schedulable(key);
  if (!report) throw new AppError('VALIDATION_FAILED', 'That report cannot be scheduled');
  if (!can(report.permission) || !can('reports.export'))
    throw new AppError('FORBIDDEN', `You need ${report.permission} and reports.export to send it`);
  if (key === 'day-end') {
    if (Object.keys(filters).length > 0)
      throw new AppError('VALIDATION_FAILED', 'The day-end takes no filters');
    return;
  }
  if ('from' in filters || 'to' in filters)
    throw new AppError('VALIDATION_FAILED', 'The period comes from the schedule');
  const def = REPORTS.find((r) => r.key === key);
  parseInput(def?.filters as z.ZodType, { ...filters, from: '2026-01-01', to: '2026-01-01' });
}

/**
 * The file of one completed period, made with the permissions its owner has now (costs only
 * with `reports.profit`), and a line or two for the e-mail's text.
 */
export async function scheduledFile(
  db: Queryable,
  input: {
    key: string;
    filters: Record<string, unknown>;
    period: { from: string; to: string };
    today: string;
    can: (permission: string) => boolean;
  },
): Promise<ReportFile & { title: string; summary: string }> {
  const report = schedulable(input.key);
  if (!report) throw new Error(`${input.key} cannot be scheduled`);
  if (!input.can(report.permission) || !input.can('reports.export'))
    throw new Error(`the schedule's owner may no longer open ${report.title}`);
  if (input.key === 'day-end') {
    const d = await dayEndOf(db, input.period.from, input.today, 'worker');
    const file = await dayEndFile(db, d, input.can('reports.profit'));
    const s = d.report.sales;
    return {
      ...file,
      title: report.title,
      summary: `Net sales Rs ${s.net_sales} from ${String(s.orders)} orders; collected Rs ${s.collected ?? '0'}.`,
    };
  }
  const def = REPORTS.find((r) => r.key === input.key) as unknown as ReportDefinition<{
    from: string;
    to: string;
  }>;
  const filters = parseInput(def.filters, { ...input.filters, ...input.period });
  const labels = await filterLabels(db, filters, def.key);
  const result = await runReport(def, { db, can: input.can, today: input.today }, filters, labels);
  const format: Format = (def.formats ?? FORMATS).includes('pdf') ? 'pdf' : 'csv';
  const file = await reportFile(db, result, labels, format);
  return {
    ...file,
    title: report.title,
    summary: `${result.footer.period}: ${String(result.rows.length)} rows.`,
  };
}
