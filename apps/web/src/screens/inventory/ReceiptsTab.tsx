/**
 * Posted receipts, newest first, and one receipt's lines. A wrong receipt is reversed as a
 * whole while its stock is still available (RECIPE_INVENTORY.md §7), with a reason; then
 * the right one is received again. Costs show only to those who receive or see costs.
 */
import { useState } from 'react';
import { Decimal, unitsFor, type UnitCode } from '@cl/shared';
import { CheckField, Field, SelectField } from '../../components/Field.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { writeMessage } from '../menu/menu-api.ts';
import {
  formatQty,
  rupees,
  useInventoryCommand,
  useReceipt,
  useReceipts,
  type PaymentChannel,
  type ReceiptDetail,
  type ReceiptLine,
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
  const [returning, setReturning] = useState<string | null>(null);
  const canReturn = canReverse && r?.status === 'posted';
  const returningLine = r?.lines.find((l) => l.lineId === returning) ?? null;

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
                {canReturn ? (
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                ) : null}
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
                    {Number(l.returnedQty) > 0 ? (
                      <div className="muted">
                        {formatQty(l.returnedQty, l.baseUom)} returned to the supplier
                      </div>
                    ) : null}
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
                  {canReturn ? (
                    <td>
                      {new Decimal(l.qtyBase).greaterThan(l.returnedQty) ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => {
                            setReturning(l.lineId);
                          }}
                        >
                          Return… <span className="visually-hidden">{l.name}</span>
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          {returningLine ? (
            <ReturnForm
              receiptId={r.id}
              line={returningLine}
              onDone={() => {
                setReturning(null);
              }}
            />
          ) : null}
          {r.returns.length > 0 ? <Returns receipt={r} /> : null}
          {canReverse && r.status === 'posted' && r.returns.length === 0 ? (
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

/** Stock back to the supplier against this line (RECIPE_INVENTORY.md §11, AT-110). */
function ReturnForm({
  receiptId,
  line,
  onDone,
}: {
  receiptId: string;
  line: ReceiptLine;
  onDone: () => void;
}) {
  const writes = useWritesAllowed();
  const left = new Decimal(line.qtyBase).minus(line.returnedQty);
  const [qty, setQty] = useState('');
  const [uom, setUom] = useState<UnitCode>(line.baseUom);
  const [reason, setReason] = useState('');
  const [refunded, setRefunded] = useState(false);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState<PaymentChannel>('cash');
  const [reference, setReference] = useState('');
  const send = useInventoryCommand(onDone);
  const qtyOk = /^\d{1,10}(\.\d{1,4})?$/.test(qty) && Number(qty) > 0;
  const amountOk = !refunded || /^\d{1,10}(\.\d{1,2})?$/.test(amount);
  const valid = qtyOk && reason.trim().length >= 3 && amountOk;
  return (
    <form
      className="card stack"
      aria-label={`Return ${line.name} to the supplier`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || !writes) return;
        send.mutate({
          path: `/purchase-receipts/${receiptId}/returns`,
          body: {
            lineId: line.lineId,
            qty,
            uom,
            reason: reason.trim(),
            ...(refunded
              ? {
                  refundAmount: amount,
                  refundChannel: channel,
                  ...(reference.trim() ? { refundReference: reference.trim() } : {}),
                }
              : {}),
          },
        });
      }}
      noValidate
    >
      <strong>
        Return {line.name} to the supplier · up to {formatQty(left.toFixed(4), line.baseUom)}
      </strong>
      <div className="row">
        <Field
          label="How much goes back"
          inputMode="decimal"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value.trim());
          }}
        />
        <SelectField
          label="Unit"
          value={uom}
          options={unitsFor(line.baseUom).map((u) => ({ value: u, label: u }))}
          onChange={(v) => {
            setUom(v as UnitCode);
          }}
        />
        <Field
          label="Why"
          maxLength={200}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
          }}
        />
      </div>
      <CheckField label="The supplier refunded us" checked={refunded} onChange={setRefunded} />
      {refunded ? (
        <div className="row">
          <Field
            label="Refund (Rs)"
            inputMode="decimal"
            value={amount}
            error={amount && !amountOk ? 'Rupees, e.g. 550' : null}
            onChange={(e) => {
              setAmount(e.target.value.trim());
            }}
          />
          <SelectField
            label="Refunded by"
            value={channel}
            options={[
              { value: 'cash', label: 'Cash' },
              { value: 'card', label: 'Card' },
              { value: 'transfer', label: 'Bank / JazzCash / Easypaisa' },
            ]}
            onChange={(v) => {
              setChannel(v as PaymentChannel);
            }}
          />
          <Field
            label="Reference (optional)"
            hint="Never a card number"
            maxLength={60}
            value={reference}
            onChange={(e) => {
              setReference(e.target.value);
            }}
          />
        </div>
      ) : null}
      <div className="row">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!valid || !writes || send.isPending}
        >
          Return to supplier
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {send.isError ? (
        <div role="alert" className="banner banner-danger">
          {writeMessage(send.error)}
        </div>
      ) : null}
    </form>
  );
}

function Returns({ receipt }: { receipt: ReceiptDetail }) {
  const showMoney = receipt.returns.some((x) => x.value !== null);
  return (
    <section className="stack" aria-labelledby="receipt-returns">
      <h3 id="receipt-returns">Returned to the supplier</h3>
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Quantity</th>
            <th scope="col">Why</th>
            <th scope="col">Refund</th>
            {showMoney ? <th scope="col">Stock value out</th> : null}
          </tr>
        </thead>
        <tbody>
          {receipt.returns.map((x) => (
            <tr key={x.id}>
              <td>
                {x.name}
                <div className="muted">
                  {x.businessDate} by {x.returnedBy}
                </div>
              </td>
              <td>{formatQty(x.qtyBase, x.baseUom)}</td>
              <td>{x.reason}</td>
              <td>
                {x.refundChannel
                  ? `${x.refundAmount === null ? 'Yes' : rupees(x.refundAmount)} · ${CHANNELS[x.refundChannel]}${
                      x.refundReference ? ` · ${x.refundReference}` : ''
                    }`
                  : 'None'}
              </td>
              {showMoney ? <td>{x.value === null ? '—' : rupees(x.value)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
