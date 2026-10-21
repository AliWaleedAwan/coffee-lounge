/**
 * Taking payment on a prepared bill (ORDER_STATE_MACHINE.md §6 P1): cash with the change
 * worked out, card with the terminal's approval code (never the card number), or a
 * JazzCash / Easypaisa / bank transfer with its transaction ID once someone has seen the
 * money arrive. Several payments may settle one bill (split tender); each goes with the
 * bill's lock version, so a bill changed meanwhile is refused (BILL_CHANGED).
 */
import { Decimal, money } from '@cl/shared';
import { useState, type RefObject, type SubmitEvent } from 'react';
import { ApiError, messageOf } from '../../api/client.ts';
import { CheckField, Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import type { Bill, PaymentResult, Shift } from './counter-api.ts';
import { useCommand } from './useCommand.ts';

export const METHODS = [
  { id: 'cash', label: 'Cash', key: 'F4' },
  { id: 'card', label: 'Card', key: 'F5' },
  { id: 'jazzcash', label: 'JazzCash', key: null },
  { id: 'easypaisa', label: 'Easypaisa', key: null },
  { id: 'bank', label: 'Bank transfer', key: null },
] as const;
export type Method = (typeof METHODS)[number]['id'];

const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/** Quick "cash received" amounts: exact, then the next round notes above it. */
export function tenderOptions(amount: string): string[] {
  if (!AMOUNT.test(amount)) return [];
  const value = new Decimal(amount);
  const options = [money.format(value)];
  for (const note of [100, 500, 1000, 5000]) {
    const up = value.dividedBy(note).ceil().times(note);
    const text = money.format(up);
    if (up.gt(value) && !options.includes(text)) options.push(text);
  }
  return options.slice(0, 4);
}

export function PaymentPanel({
  bill,
  shift,
  method,
  onMethod,
  focusRef,
  onPaid,
}: {
  bill: Bill;
  shift: Shift | null;
  method: Method;
  onMethod: (m: Method) => void;
  /** The field F4 / F5 jump to. */
  focusRef: RefObject<HTMLInputElement | null>;
  onPaid: (result: PaymentResult) => void;
}) {
  const writes = useWritesAllowed();
  const due = bill.invoice.due;
  const [amount, setAmount] = useState('');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [seen, setSeen] = useState(false);
  const pay = useCommand<PaymentResult>((r) => {
    setAmount('');
    setTendered('');
    setReference('');
    setSeen(false);
    onPaid(r);
  });

  const value = amount.trim() === '' ? due : amount.trim();
  const amountOk = AMOUNT.test(value) && new Decimal(value).gt(0) && new Decimal(value).lte(due);
  const tenderedOk =
    AMOUNT.test(tendered.trim()) && amountOk && new Decimal(tendered.trim()).gte(value);
  const change = tenderedOk ? money.format(new Decimal(tendered.trim()).minus(value)) : null;
  const transfer = method === 'jazzcash' || method === 'easypaisa' || method === 'bank';
  const ready =
    writes &&
    !pay.isPending &&
    amountOk &&
    (method === 'cash'
      ? tenderedOk && shift !== null
      : transfer
        ? reference.trim() !== '' && seen
        : true);

  const submit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (!ready) return;
    const ref = reference.trim();
    pay.mutate({
      path: `/invoices/${bill.invoice.id}/payments`,
      body: {
        lockVersion: bill.invoice.lockVersion,
        method: method === 'cash' ? 'cash' : method === 'card' ? 'card_manual' : 'transfer',
        amount: value,
        ...(method === 'cash' ? { tendered: tendered.trim() } : {}),
        ...(transfer ? { provider: method, confirmed: seen } : {}),
        ...(ref && method !== 'cash' ? { reference: ref } : {}),
      },
    });
  };

  const label = METHODS.find((m) => m.id === method)?.label ?? '';
  return (
    <form className="card stack" onSubmit={submit} noValidate aria-labelledby="pay-heading">
      <div className="section-head">
        <h3 id="pay-heading">Take payment</h3>
        <strong className="amount-due">Due {rupees(due)}</strong>
      </div>
      <div className="method-tiles" role="group" aria-label="Payment method">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            className="method-tile"
            aria-pressed={method === m.id}
            onClick={() => {
              onMethod(m.id);
            }}
          >
            {m.label}
            {m.key ? <kbd>{m.key}</kbd> : null}
          </button>
        ))}
      </div>
      <Field
        label="Amount for this payment"
        inputMode="decimal"
        placeholder={due}
        value={amount}
        hint="Leave as is for the full amount; less to split between methods."
        error={amount.trim() && !amountOk ? `Between Rs 1 and ${rupees(due)}` : null}
        onChange={(e) => {
          setAmount(e.target.value);
        }}
      />
      {method === 'cash' ? (
        <>
          {shift === null ? (
            <div role="alert" className="banner banner-warning">
              No cash shift is open. Open it above, or take card or transfer.
            </div>
          ) : null}
          <Field
            ref={focusRef}
            label="Cash received"
            inputMode="decimal"
            value={tendered}
            onChange={(e) => {
              setTendered(e.target.value);
            }}
          />
          <div className="row" role="group" aria-label="Quick amounts">
            {tenderOptions(value).map((t, i) => (
              <button
                key={t}
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setTendered(t);
                }}
              >
                {i === 0 ? 'Exact' : rupees(t)}
              </button>
            ))}
          </div>
          <p className="change-due" aria-live="polite">
            Change <strong>{change ? rupees(change) : '—'}</strong>
          </p>
        </>
      ) : (
        <>
          <Field
            ref={focusRef}
            label={
              method === 'card'
                ? 'Approval code from the terminal slip (optional)'
                : `${label} transaction ID`
            }
            maxLength={32}
            autoComplete="off"
            value={reference}
            hint={method === 'card' ? 'Never the card number.' : undefined}
            onChange={(e) => {
              setReference(e.target.value);
            }}
          />
          {transfer ? (
            <CheckField
              label="I checked the money arrived in the shop's account"
              checked={seen}
              onChange={setSeen}
            />
          ) : null}
        </>
      )}
      {pay.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(pay.error)}
          {pay.error instanceof ApiError && pay.error.code === 'BILL_CHANGED'
            ? ' The new figures are shown above.'
            : ''}
        </div>
      ) : null}
      <button type="submit" className="btn btn-primary btn-lg" disabled={!ready}>
        {pay.isPending
          ? 'Sending…'
          : `Take ${rupees(amountOk ? money.format(new Decimal(value)) : due)} by ${label.toLowerCase()}`}
      </button>
    </form>
  );
}
