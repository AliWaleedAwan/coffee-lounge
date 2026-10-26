/**
 * Suppliers (`suppliers.manage` to change; anyone reading inventory sees them). Never
 * deleted: an inactive supplier keeps its name on old receipts (D-31).
 */
import { useState, type SubmitEvent } from 'react';
import { CheckField, Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import { useInventoryWrite, useSuppliers, type Supplier } from './inventory-api.ts';

export function SuppliersTab({ canManage }: { canManage: boolean }) {
  const [showInactive, setShowInactive] = useState(false);
  const suppliers = useSuppliers(showInactive);
  const list = suppliers.data?.items ?? [];
  return (
    <section className="card stack" aria-labelledby="suppliers-head">
      <div className="section-head">
        <h2 id="suppliers-head">Suppliers</h2>
        <CheckField label="Show inactive" checked={showInactive} onChange={setShowInactive} />
      </div>
      {suppliers.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(suppliers.error)}
        </div>
      ) : null}
      {suppliers.isPending ? <Loading label="Loading suppliers" /> : null}
      {suppliers.data && list.length === 0 ? <p className="muted">No suppliers yet.</p> : null}
      {list.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Supplier</th>
              <th scope="col">Phone</th>
              <th scope="col">Notes</th>
              {canManage ? (
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <SupplierRow key={s.id} supplier={s} canManage={canManage} />
            ))}
          </tbody>
        </table>
      ) : null}
      {canManage ? <NewSupplier /> : null}
    </section>
  );
}

function SupplierRow({ supplier, canManage }: { supplier: Supplier; canManage: boolean }) {
  const writes = useWritesAllowed();
  const toggle = useInventoryWrite();
  return (
    <tr>
      <td>
        {supplier.name}
        {supplier.isActive ? null : (
          <>
            {' '}
            <span className="chip chip-warning">Inactive</span>
          </>
        )}
        {toggle.isError ? <div className="field-error">{writeMessage(toggle.error)}</div> : null}
      </td>
      <td>{supplier.phone ?? '—'}</td>
      <td>{supplier.notes ?? '—'}</td>
      {canManage ? (
        <td>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes || toggle.isPending}
            onClick={() => {
              toggle.mutate({
                path: `/suppliers/${supplier.id}`,
                method: 'PATCH',
                body: { expectedVersion: supplier.version, isActive: !supplier.isActive },
              });
            }}
          >
            {supplier.isActive ? 'Make inactive' : 'Make active'}{' '}
            <span className="visually-hidden">{supplier.name}</span>
          </button>
        </td>
      ) : null}
    </tr>
  );
}

function NewSupplier() {
  const writes = useWritesAllowed();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const add = useInventoryWrite(() => {
    setName('');
    setPhone('');
    setNotes('');
  });
  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!name.trim() || !writes) return;
    add.mutate({
      path: '/suppliers',
      body: { name: name.trim(), phone: phone.trim(), notes: notes.trim() },
    });
  };
  return (
    <form className="row" onSubmit={submit} noValidate aria-label="New supplier">
      <Field
        label="Supplier name"
        maxLength={80}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
      />
      <Field
        label="Phone (optional)"
        maxLength={30}
        value={phone}
        onChange={(e) => {
          setPhone(e.target.value);
        }}
      />
      <Field
        label="Notes (optional)"
        maxLength={500}
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
        }}
      />
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={!name.trim() || !writes || add.isPending}
      >
        Add supplier
      </button>
      {add.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(add.error)}
        </div>
      ) : null}
    </form>
  );
}
