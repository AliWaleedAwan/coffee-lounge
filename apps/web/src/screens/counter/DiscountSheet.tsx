/**
 * A manual discount or a comp (D-14, D-21): % or a fixed amount, on one item or the whole
 * bill, always with a reason. Above the person's limit (cashier 10 %, manager 20 %) a
 * manager or the owner approves on this device; a comp makes one item free.
 */
import { useState, type SubmitEvent } from 'react';
import { ApiError, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { ApprovalFields, approvalReady, noApproval } from './Approval.tsx';
import type { Bill } from './counter-api.ts';
import { approve, useCommand } from './useCommand.ts';

export type SheetMode =
  { kind: 'discount'; lineId: string | null } | { kind: 'comp'; lineId: string };

export function DiscountSheet({
  bill,
  mode,
  onClose,
}: {
  bill: Bill;
  mode: SheetMode;
  onClose: () => void;
}) {
  const writes = useWritesAllowed();
  const [target, setTarget] = useState(mode.lineId ?? '');
  const [kind, setKind] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState(noApproval);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useCommand(onClose);

  const comp = mode.kind === 'comp';
  const item = bill.lines.find((l) => l.orderLineId === (comp ? mode.lineId : target));
  const valueOk =
    comp ||
    (/^\d{1,9}(\.\d{1,2})?$/.test(value.trim()) &&
      Number(value) > 0 &&
      (kind === 'fixed' || Number(value) <= 100));
  const ready =
    writes &&
    !send.isPending &&
    valueOk &&
    reason.trim().length >= 3 &&
    (!needsApproval || approvalReady(approval));

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const stepUpId = needsApproval
        ? await approve({
            action: 'discount.over_limit',
            entityType: 'invoice',
            entityId: bill.invoice.id,
            username: approval.username,
            pin: approval.pin,
            reason: reason.trim(),
          })
        : undefined;
      await send.mutateAsync(
        comp
          ? {
              path: `/invoices/${bill.invoice.id}/comps`,
              body: { orderLineId: mode.lineId, reason: reason.trim() },
            }
          : {
              path: `/invoices/${bill.invoice.id}/discounts`,
              body: {
                orderLineId: target || null,
                kind,
                value: value.trim(),
                reason: reason.trim(),
                ...(stepUpId ? { stepUpId } : {}),
              },
            },
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED' && !needsApproval) {
        setNeedsApproval(true);
      }
      setError(messageOf(e));
    }
  };

  return (
    <form
      className="card stack sheet"
      noValidate
      aria-labelledby="discount-heading"
      onSubmit={(e) => {
        void submit(e);
      }}
    >
      <h3 id="discount-heading">
        {comp ? `Comp ${item?.description ?? 'item'} (free)` : 'Discount'}
      </h3>
      {comp ? (
        <p className="muted">The item stays on the bill at no charge; its cost still counts.</p>
      ) : (
        <>
          <SelectField
            label="On"
            value={target}
            options={[
              { value: '', label: 'The whole bill' },
              ...bill.lines
                .filter((l) => !l.isComp)
                .map((l) => ({
                  value: l.orderLineId,
                  label: `${String(l.billableQty)}× ${l.description}`,
                })),
            ]}
            onChange={setTarget}
          />
          <div className="row">
            <SelectField
              label="Type"
              value={kind}
              options={[
                { value: 'percent', label: 'Percent (%)' },
                { value: 'fixed', label: 'Amount (Rs)' },
              ]}
              onChange={(k) => {
                setKind(k === 'fixed' ? 'fixed' : 'percent');
              }}
            />
            <Field
              label={kind === 'percent' ? 'Percent' : 'Amount'}
              inputMode="decimal"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
              }}
            />
          </div>
        </>
      )}
      <Field
        label="Reason"
        maxLength={120}
        placeholder={comp ? 'e.g. Birthday, long wait' : 'e.g. Regular guest, staff'}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      {needsApproval ? (
        <ApprovalFields
          legend="Over your limit: a manager approves on this device"
          value={approval}
          onChange={setApproval}
        />
      ) : null}
      {error ? (
        <div role="alert" className="banner banner-danger">
          {error}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {send.isPending ? 'Sending…' : comp ? 'Make it free' : 'Apply discount'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Back <kbd>Esc</kbd>
        </button>
      </div>
    </form>
  );
}
