/**
 * CSV exports (FINANCE_REPORTING.md §8; AT-103): UTF-8 with a byte-order mark so Excel
 * reads it as UTF-8, comma-separated, one header row, ISO dates, amounts as plain decimals
 * (no thousands separators, no currency), then the totals row: the same rows and totals
 * as the screen, from the same `runReport` (AC-RPT-1). The filters are in the file name.
 */
import type { Cell, Column, Report } from './engine.ts';

const BOM = '﻿';

/**
 * A cell as CSV text. Text a person typed that starts like a formula (= + - @, tab or
 * carriage return) is prefixed with an apostrophe so a spreadsheet shows it rather than
 * running it; numbers are written as they are.
 */
export function csvCell(kind: Column['kind'], v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  let text = String(v);
  if ((kind === 'text' || kind === 'date') && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(report: Report): Buffer {
  const cols = report.columns;
  const lines = [cols.map((c) => csvCell('text', c.label)).join(',')];
  for (const row of report.rows) lines.push(cols.map((c) => csvCell(c.kind, row[c.key])).join(','));
  if (report.rows.length > 0 && cols.some((c) => report.totals[c.key] !== null)) {
    lines.push(
      cols
        .map((c, i) =>
          i === 0 && report.totals[c.key] === null
            ? 'Total'
            : csvCell(c.kind, report.totals[c.key]),
        )
        .join(','),
    );
  }
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}

const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);

/**
 * "sales-by-day_2026-10-01_2026-10-31_category-hot-coffee.csv": the report, its period and
 * each filter by name (FINANCE_REPORTING.md §8). ASCII only, safe on every file system.
 */
export function exportFileName(
  report: Pick<Report, 'key' | 'period' | 'filters'>,
  labels: Record<string, string>,
  extension: 'csv' | 'pdf',
): string {
  const parts = [report.key, report.period.from];
  if (report.period.to !== report.period.from) parts.push(report.period.to);
  for (const [k, v] of Object.entries(report.filters)) {
    const name = slug(labels[k] ?? v);
    const key = slug(k.replace(/Id$/, '').replace(/([a-z])([A-Z])/g, '$1-$2'));
    if (name) parts.push(`${key}-${name}`);
  }
  return `${parts.join('_')}.${extension}`;
}
