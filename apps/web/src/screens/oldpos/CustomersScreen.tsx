/**
 * Customers (owner's request, Nov 2026): the people the old POS knew, by mobile number. Search
 * by any part of a name or a number; the delivery form fills in a known customer by itself.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, messageOf } from '../../api/client.ts';
import { Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';

interface Customer {
  id: string;
  mobile: string;
  name: string | null;
  location: string | null;
  lastSeen: string | null;
  bills: number;
}

export function CustomersScreen() {
  const [q, setQ] = useState('');
  const term = q.trim();
  const customers = useQuery({
    queryKey: ['customers', term],
    queryFn: ({ signal }) =>
      api<{ items: Customer[]; total: number }>(
        `/customers${term ? `?q=${encodeURIComponent(term)}` : ''}`,
        { signal },
      ),
  });
  const items = customers.data?.items ?? [];
  return (
    <>
      <h1>Customers</h1>
      <section className="card stack" aria-labelledby="customers-head">
        <h2 id="customers-head" className="visually-hidden">
          Find a customer
        </h2>
        <Field
          label="Search by name or mobile"
          value={q}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
          }}
        />
        {customers.isPending ? <Loading label="Loading customers" /> : null}
        {customers.isError ? (
          <div role="alert" className="banner banner-danger">
            {messageOf(customers.error)}
          </div>
        ) : null}
        {customers.data ? (
          <p className="muted">
            {customers.data.total === 0
              ? 'No customers yet. The owner brings them in from the old POS (Inventory, Import).'
              : `${String(customers.data.total)} customers${term ? `; ${String(items.length)} match` : ''}${items.length === 50 ? ' (the first 50 shown)' : ''}.`}
          </p>
        ) : null}
        {items.length > 0 ? (
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Mobile</th>
                <th scope="col">Location</th>
                <th scope="col">Old bills</th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{c.name ?? '—'}</td>
                  <td>
                    <a href={`tel:${c.mobile}`}>{c.mobile}</a>
                  </td>
                  <td>{c.location ?? '—'}</td>
                  <td>{c.bills}</td>
                  <td>{c.lastSeen ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </section>
    </>
  );
}
