/**
 * Approvals (API.md §5.4, D-07, D-36): guest orders waiting for this person, oldest
 * first. Accept reserves stock for the whole order or refuses it; Decline needs a reason
 * the guest will see. Orders waiting more than 3 minutes are marked and reach cashiers.
 * If someone else decided first, the screen says who (ROUND_ALREADY_DECIDED).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, messageOf } from '../../api/client.ts';
import { Field } from '../../components/Field.tsx';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { rupees } from '../../order/cart.ts';
import type { Round } from '../../order/RoundList.tsx';
import { Loading } from '../../components/Loading.tsx';

interface Pending extends Round {
  escalated: boolean;
  stockShort: string[];
  session: { id: string; sessionNo: string; orderType: string; tableName: string | null };
}

const REASONS = ['Out of stock', 'Kitchen is closed for this', 'Please ask a member of staff'];

function waited(submittedAt: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(submittedAt).getTime()) / 60_000));
  return min < 1 ? 'just now' : `${String(min)} min`;
}

function decisionMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'ROUND_ALREADY_DECIDED') {
    const by = typeof error.body['decidedBy'] === 'string' ? ` by ${error.body['decidedBy']}` : '';
    const status = typeof error.body['status'] === 'string' ? error.body['status'] : 'decided';
    return `Already ${status.replace('_', ' ')}${by}.`;
  }
  if (error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK') {
    return `${error.message}. Decline the order so the guest can choose something else.`;
  }
  return messageOf(error);
}

export function ApprovalsScreen() {
  const queue = useQuery({
    queryKey: ['approvals'],
    queryFn: ({ signal }) => api<{ items: Pending[] }>('/approvals', { signal }),
    meta: { topics: ['approvals'] },
  });
  const now = queue.dataUpdatedAt;
  const items = queue.data?.items ?? [];
  return (
    <>
      <h1>Approvals</h1>
      {queue.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(queue.error)}
        </div>
      ) : null}
      {queue.isPending ? <Loading label="Loading orders waiting for approval" /> : null}
      {queue.data && items.length === 0 ? <p className="muted">No orders are waiting.</p> : null}
      <ol className="stack" role="list">
        {items.map((r) => (
          <PendingRound key={r.id} round={r} now={now} />
        ))}
      </ol>
    </>
  );
}

function PendingRound({ round, now }: { round: Pending; now: number }) {
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: { accept: true } | { accept: false; reason: string }) =>
      api(`/rounds/${round.id}/${decision.accept ? 'accept' : 'reject'}`, {
        method: 'POST',
        body: decision.accept ? {} : { reason: decision.reason },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ['approvals'] }),
  });
  const where =
    round.session.tableName ?? (round.session.orderType === 'takeaway' ? 'Takeaway' : 'Delivery');
  const headingId = `round-${round.id}`;
  return (
    <li className="card stack round-card" aria-labelledby={headingId}>
      <div className="section-head">
        <h2 id={headingId}>
          {where} · order {round.roundNo}
        </h2>
        <span className="muted">{waited(round.submittedAt, now)}</span>
        {round.escalated ? <span className="chip chip-danger">Waiting too long</span> : null}
        {round.afterBillRequest ? <span className="chip chip-info">After bill request</span> : null}
      </div>
      <ul className="stack stack-tight" role="list">
        {round.lines.map((l) => (
          <li key={l.id} className="cart-line">
            <span>
              {l.qty} × {l.item} · {l.variant}
              {l.modifiers.length > 0 ? (
                <span className="muted"> ({l.modifiers.map((m) => m.name).join(', ')})</span>
              ) : null}
              {l.notes ? <span className="muted"> “{l.notes}”</span> : null}
            </span>
            <span className="cart-price">{rupees(l.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <p>
        <strong>Total {rupees(round.quotedTotal)}</strong>
      </p>
      {round.stockShort.length > 0 ? (
        <div role="status" className="banner banner-warning">
          Probably not enough {round.stockShort.join(', ')}.
        </div>
      ) : null}
      {decide.isError ? (
        <div role="alert" className="banner banner-danger">
          {decisionMessage(decide.error)}
        </div>
      ) : null}
      {declining ? (
        <form
          className="stack"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= 3) decide.mutate({ accept: false, reason: reason.trim() });
          }}
        >
          <div className="row">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setReason(r);
                }}
              >
                {r}
              </button>
            ))}
          </div>
          <Field
            label="Reason the guest will see"
            maxLength={200}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
          <div className="row">
            <button
              type="submit"
              className="btn btn-danger"
              disabled={!writes || decide.isPending || reason.trim().length < 3}
            >
              Decline order
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setDeclining(false);
              }}
            >
              Back
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={!writes || decide.isPending}
            onClick={() => {
              decide.mutate({ accept: true });
            }}
          >
            Accept{' '}
            <span className="visually-hidden">
              {where} order {round.roundNo}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!writes || decide.isPending}
            onClick={() => {
              setDeclining(true);
            }}
          >
            Decline{' '}
            <span className="visually-hidden">
              {where} order {round.roundNo}
            </span>
          </button>
        </div>
      )}
    </li>
  );
}
