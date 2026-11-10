/**
 * Old POS sales (owner's request, Nov 2026): the old till's paid bills as history, by shop day,
 * and its best sellers. Kept apart from Coffee Lounge's own reports, cash and stock.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';

interface OldSales {
  available: { first: string | null; last: string | null };
  totals: { bills: number; sales: number };
  days: { date: string; bills: number; sales: number }[];
  items: { item: string; category: string | null; qty: number; amount: number }[];
}

const rupees = (n: number) => `Rs ${Math.round(n).toLocaleString('en-US')}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function OldSalesScreen() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(isoDay(today));
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const report = useQuery({
    queryKey: ['reports', 'old-pos', from, to],
    queryFn: ({ signal }) => api<OldSales>(`/reports/old-pos?from=${from}&to=${to}`, { signal }),
    enabled: valid,
  });
  const data = report.data;
  return (
    <>
      <h1>Old POS sales</h1>
      <section className="card stack" aria-labelledby="old-sales-head">
        <h2 id="old-sales-head" className="visually-hidden">
          Period
        </h2>
        <p className="muted">
          The old till&apos;s paid bills, kept as history. They are not part of Coffee Lounge&apos;s
          own reports, cash or stock.
          {data?.available.first
            ? ` History from ${data.available.first} to ${data.available.last ?? ''}.`
            : ''}
        </p>
        <div className="row">
          <Field
            label="From"
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
            }}
          />
          <Field
            label="To"
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
            }}
          />
        </div>
        {!valid ? (
          <div role="alert" className="banner banner-warning">
            The start must be on or before the end.
          </div>
        ) : null}
        {report.isPending && valid ? <Loading label="Loading old sales" /> : null}
        {report.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(report.error)}
          </div>
        ) : null}
        {data ? (
          <>
            <p>
              <strong>{rupees(data.totals.sales)}</strong> from {data.totals.bills} paid bills.
            </p>
            {data.days.length > 0 ? (
              <table className="data" aria-label="Old sales by day">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Bills</th>
                    <th scope="col">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date}>
                      <td>{d.date}</td>
                      <td>{d.bills}</td>
                      <td>{rupees(d.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No old sales in this period.</p>
            )}
            {data.items.length > 0 ? (
              <table className="data" aria-label="Best sellers in the old POS">
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Category</th>
                    <th scope="col">Sold</th>
                    <th scope="col">Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={`${i.item}-${i.category ?? ''}`}>
                      <td>{i.item}</td>
                      <td>{i.category ?? '—'}</td>
                      <td>{i.qty}</td>
                      <td>{rupees(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}
