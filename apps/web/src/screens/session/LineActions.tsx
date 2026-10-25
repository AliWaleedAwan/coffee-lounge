/**
 * Cancel or void units of an accepted line (ORDER_STATE_MACHINE.md §3). Cancelling asks
 * "Was it already made?": not made releases the stock (L3); made is consumed and written
 * off (L4). Voiding picked-up units (spilled, remade, refused) is waste at the line's
 * cost (L5). Writing off made items needs orders.void_prepared, or a manager's PIN on
 * this device (step-up, RBAC.md §1.4).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, messageOf } from '../../api/client.ts';
import { Field, SelectField } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';

export interface ActionLine {
  id: string;
  item: string;
  open: number;
  voidable: number;
}

const VOID_REASONS = [
  { value: 'spilled', label: 'Spilled' },
  { value: 'remade', label: 'Remade' },
  { value: 'quality', label: 'Quality problem' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'other', label: 'Other (say what)' },
] as const;

type Mode = 'none' | 'cancel' | 'void';

export function LineActions({ line, sessionId }: { line: ActionLine; sessionId: string }) {
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const [mode, setMode] = useState<Mode>('none');
  const [qty, setQty] = useState('1');
  const [made, setMade] = useState<boolean | null>(null);
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState<string>('spilled');
  const [approval, setApproval] = useState({ needed: false, username: '', pin: '' });

  const close = () => {
    setMode('none');
    setMade(null);
    setReason('');
    setApproval({ needed: false, username: '', pin: '' });
  };
  const act = useMutation({
    mutationFn: async () => {
      let stepUpId: string | undefined;
      if (approval.needed) {
        const res = await api<{ stepUpId: string }>('/auth/step-up', {
          method: 'POST',
          body: {
            action: 'line.void_prepared',
            entityType: 'order_line',
            entityId: line.id,
            approverUsername: approval.username.trim(),
            approverPin: approval.pin,
            reason: mode === 'cancel' ? reason.trim() : `Void: ${reasonCode}`,
          },
        });
        stepUpId = res.stepUpId;
      }
      const body =
        mode === 'cancel'
          ? {
              qty: Number(qty),
              made: made === true,
              reason: reason.trim(),
              ...(stepUpId ? { stepUpId } : {}),
            }
          : {
              qty: Number(qty),
              reasonCode,
              ...(reason.trim() ? { note: reason.trim() } : {}),
              ...(stepUpId ? { stepUpId } : {}),
            };
      return api(`/lines/${line.id}/${mode}`, {
        method: 'POST',
        body,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: close,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STEP_UP_REQUIRED')
        setApproval((a) => ({ ...a, needed: true }));
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['session', sessionId] }),
  });

  const max = mode === 'cancel' ? line.open : line.voidable;
  const qtyOptions = Array.from({ length: max }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
  const ready =
    writes &&
    !act.isPending &&
    Number(qty) >= 1 &&
    Number(qty) <= max &&
    (mode === 'cancel'
      ? made !== null && reason.trim().length >= 3
      : reasonCode !== 'other' || reason.trim().length > 0) &&
    (!approval.needed || (approval.username.trim() !== '' && /^\d{4,6}$/.test(approval.pin)));

  if (mode === 'none') {
    return (
      <div className="row">
        {line.open > 0 ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes}
            onClick={() => {
              setQty('1');
              setMode('cancel');
            }}
          >
            Cancel… <span className="visually-hidden">{line.item}</span>
          </button>
        ) : null}
        {line.voidable > 0 ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!writes}
            onClick={() => {
              setQty('1');
              setMode('void');
            }}
          >
            Void… <span className="visually-hidden">{line.item}</span>
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <form
      className="stack card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) act.mutate();
      }}
    >
      <h4>{mode === 'cancel' ? `Cancel ${line.item}` : `Void ${line.item}`}</h4>
      {max > 1 ? (
        <SelectField label="How many" value={qty} options={qtyOptions} onChange={setQty} />
      ) : null}
      {mode === 'cancel' ? (
        <fieldset className="stack">
          <legend>Was it already made?</legend>
          <div className="checks">
            <label className="check">
              <input
                type="radio"
                name={`made-${line.id}`}
                checked={made === false}
                onChange={() => {
                  setMade(false);
                }}
              />
              No, not made yet
            </label>
            <label className="check">
              <input
                type="radio"
                name={`made-${line.id}`}
                checked={made === true}
                onChange={() => {
                  setMade(true);
                }}
              />
              Yes, already made (written off)
            </label>
          </div>
        </fieldset>
      ) : (
        <SelectField
          label="Why"
          value={reasonCode}
          options={VOID_REASONS}
          onChange={setReasonCode}
        />
      )}
      <Field
        label={mode === 'cancel' ? 'Reason' : 'Note (needed for Other)'}
        maxLength={200}
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
        }}
      />
      {approval.needed ? (
        <fieldset className="stack">
          <legend>A manager approves on this device</legend>
          <div className="row">
            <Field
              label="Manager username"
              autoComplete="off"
              value={approval.username}
              onChange={(e) => {
                setApproval({ ...approval, username: e.target.value });
              }}
            />
            <Field
              label="Manager PIN"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={approval.pin}
              onChange={(e) => {
                setApproval({ ...approval, pin: e.target.value });
              }}
            />
          </div>
        </fieldset>
      ) : null}
      {act.isError &&
      !(
        act.error instanceof ApiError &&
        act.error.code === 'STEP_UP_REQUIRED' &&
        !approval.username
      ) ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(act.error)}
        </div>
      ) : null}
      <div className="row">
        <button type="submit" className="btn btn-danger" disabled={!ready}>
          {mode === 'cancel' ? 'Cancel items' : 'Void items'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={close}>
          Back
        </button>
      </div>
    </form>
  );
}
