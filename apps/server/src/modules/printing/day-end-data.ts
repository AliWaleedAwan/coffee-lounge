/**
 * What the 80 mm day-end shows (FINANCE_REPORTING.md §7; P6-9): read from the stored
 * day-end (cl.day_end_reports), the same figures as its PDF, without costs or margins.
 */
import type { Queryable } from '../../platform/db/pool.ts';
import type { DayEndPrintData } from './documents.ts';

export async function dayEndPrintData(db: Queryable, id: string): Promise<DayEndPrintData> {
  const { rows } = await db.query<{
    business_date: string;
    generated_at: Date;
    data: Omit<DayEndPrintData, 'date' | 'generatedAt'>;
  }>('SELECT business_date::text, generated_at, data FROM cl.day_end_reports WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) throw new Error(`day-end ${id} not found`);
  const d = row.data;
  return {
    date: row.business_date,
    generatedAt: row.generated_at,
    sales: d.sales,
    byOrderType: d.byOrderType,
    payments: d.payments,
    openBills: d.openBills,
    cod: d.cod,
    shifts: d.shifts,
    voids: d.voids,
    waste: { records: d.waste.records },
    topItems: d.topItems,
    alerts: d.alerts,
  };
}
