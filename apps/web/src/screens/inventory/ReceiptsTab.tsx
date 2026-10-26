/**
 * Posted receipts, newest first, and one receipt's lines. A wrong receipt is reversed as a
 * whole while its stock is still available (RECIPE_INVENTORY.md §7), with a reason; then
 * the right one is received again. Costs show only to those who receive or see costs.
 */
import { useState } from 'react';
import { Field } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  formatQty,
  rupees,
  useInventoryCommand,
  useReceipt,
  useReceipts,
} from './inventory-api.ts';

const CHANNELS = { cash: 'Cash', card: 'Card', transfer: 'Transfer' } as const;

export function ReceiptsTab({ canReverse }: { canReverse: boolean }) {
  const receipts = useReceipts();
  const [open, setOpen] = useState<string | null>(null);
  if (open) {
    return (
      <ReceiptDetail
        id={open}
        canReverse={canReverse}
        onClose={() => {
          setOpen(null);
        }}
      />
    );
  }
  const list = receipts.data?.items ?? [];
  return (
    <section className="card stack" aria-labelledby="receipts-head">
      <h2 id="receipts-head">Receipts</h2>
      {receipts.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(receipts.error)}
        </div>
      ) : null}
      {receipts.isPending ? <Loading label="Loading receipts" /> : null}
      {receipts.data && list.length === 0 ? <p className="muted">No receipts yet.</p> : null}
      {list.length > 0 ? (
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Receipt</th>
              <th scope="col">Date</th>
              <th scope="col">Supplier</th>
              <th scope="col">Lines</th>
              <th scope="col">Total</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.receiptNo}
                  {r.status === 'reversed' ? (
                    <>
                      {' '}
                      <span className="chip chip-warning">Reversed</span>
                    </>
                  ) : null}
                </td>
                <td>{r.businessDate}</td>
                <td>
                  {r.supplierName ?? '—'}
                  {r.supplierInvoiceRef ? (
                    <div className="muted">{r.supplierInvoiceRef}</div>
                  ) : null}
                </td>
                <td>{r.lineCount}</td>
                <td>{r.totalCost === null ? '—' : rupees(r.totalCost)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setOpen(r.id);
                    }}
                  >
                    Open <span className="visually-hidden">{r.receiptNo}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

function ReceiptDetail({
  id,
  canReverse,
  onClose,
}: {
  id: string;
  canReverse: boolean;
  onClose: () => void;
}) {
  const writes = useWritesAllowed();
  const receipt = useReceipt(id);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const reverse = useInventoryCommand(() => {
    setAsking(false);
  });
  const r = receipt.data;

  return (
    <section className="card stack" aria-labelledby="receipt-head">
      <div className="section-head">
        <h2 id="receipt-head">{r ? r.receiptNo : 'Receipt'}</h2>
        {r?.status === 'reversed' ? <span className="chip chip-warning">Reversed</span> : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back to receipts
        </button>
      </div>
      {receipt.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(receipt.error)}
        </div>
      ) : null}
      {!r ? <Loading label="Loading the receipt" /> : null}
      {r ? (
        <>
          <dl className="kv">
            <dt>Received</dt>
            <dd>
              {r.businessDate} by {r.postedBy}
            </dd>
            <dt>Supplier</dt>
            <dd>
              {r.supplierName ?? '—'}
              {r.supplierInvoiceRef ? ` · invoice ${r.supplierInvoiceRef}` : ''}
            </dd>
            <dt>Payment</dt>
            <dd>
              {r.paidNow && r.paymentChannel
                ? `Paid now · ${CHANNELS[r.paymentChannel]}${r.paymentReference ? ` · ${r.paymentReference}` : ''}`
                : 'Not paid at receipt'}
            </dd>
            {r.totalCost !== null ? (
              <>
                <dt>Total</dt>
                <dd>{rupees(r.totalCost)}</dd>
              </>
            ) : null}
            {r.status === 'reversed' ? (
              <>
                <dt>Reversed</dt>
                <dd>{r.reversalReason}</dd>
              </>
            ) : null}
          </dl>
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Received</th>
                <th scope="col">Lot · expiry</th>
                {r.totalCost !== null ? <th scope="col">Line cost</th> : null}
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.lineId}>
                  <td>{l.name}</td>
                  <td>
                    {l.packName && l.packQty
                      ? `${String(Number(l.packQty))} × ${l.packName} = ${formatQty(l.qtyBase, l.baseUom)}`
                      : formatQty(l.qtyBase, l.baseUom)}
                  </td>
                  <td>{[l.lotCode, l.expiryDate].filter(Boolean).join(' · ') || '—'}</td>
                  {r.totalCost !== null ? (
                    <td>
                      {l.lineCost === null ? '—' : rupees(l.lineCost)}
                      {l.unitCost ? (
                        <div className="muted">
                          Rs {l.unitCost} / {l.baseUom}
                        </div>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {canReverse && r.status === 'posted' ? (
            asking ? (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim().length >= 3 && writes) {
                    reverse.mutate({
                      path: `/purchase-receipts/${r.id}/reverse`,
                      body: { reason: reason.trim() },
                    });
                  }
                }}
                noValidate
              >
                <Field
                  label="Why is this receipt wrong?"
                  maxLength={200}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                  }}
                />
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={reason.trim().length < 3 || !writes || reverse.isPending}
                >
                  Reverse {r.receiptNo}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setAsking(false);
                  }}
                >
                  Keep it
                </button>
              </form>
            ) : (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={!writes}
                  onClick={() => {
                    setAsking(true);
                  }}
                >
                  Reverse this receipt…
                </button>
                <span className="muted">
                  Takes all its stock back out; then receive the right quantities again.
                </span>
              </div>
            )
          ) : null}
          {reverse.isError ? (
            <div role="alert" className="banner banner-danger">
              {writeMessage(reverse.error)}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
