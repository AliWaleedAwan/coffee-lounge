/**
 * One table's visit (API.md §5.4): its rounds and the waiter's composer. A staff round
 * goes straight to the kitchen; if stock is short nothing is saved, the short lines are
 * flagged and the cart is kept (AT-26). The Idempotency-Key lives as long as the intent:
 * a retry after a dropped connection sends the same key and cannot order twice.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError, messageOf } from '../../api/client.ts';
import { permissionSet } from '../../auth/session.ts';
import { useWritesAllowed } from '../../connection/ConnectionBanner.tsx';
import { roundBody, rupees, type CartLine, type MenuCategory } from '../../order/cart.ts';
import { Composer } from '../../order/Composer.tsx';
import { RoundList, type Round } from '../../order/RoundList.tsx';
import { useSignedIn } from '../Shell.tsx';
import { LineActions } from './LineActions.tsx';

interface SessionDetail {
  session: {
    id: string;
    sessionNo: string;
    orderType: string;
    status: string;
    tableName: string | null;
    openedAt: string;
  };
  rounds: Round[];
  acceptedTotal: string;
}

export function SessionScreen() {
  const { sessionId = '' } = useParams();
  const client = useQueryClient();
  const writes = useWritesAllowed();
  const permissions = permissionSet(useSignedIn());
  const canBill = permissions.has('payments.collect') || permissions.has('invoices.lock');
  const detail = useQuery({
    queryKey: ['session', sessionId],
    queryFn: ({ signal }) => api<SessionDetail>(`/sessions/${sessionId}`, { signal }),
    meta: { topics: [`session:${sessionId}`] },
  });
  const orderType = detail.data?.session.orderType ?? 'dine_in';
  const menu = useQuery({
    queryKey: ['menu', 'staff', orderType],
    queryFn: ({ signal }) =>
      api<{ categories: MenuCategory[] }>(`/menu?orderType=${orderType}`, { signal }),
    enabled: detail.isSuccess,
    meta: { topics: ['menu'] },
  });

  const [cart, setCart] = useState<CartLine[]>([]);
  const [flagged, setFlagged] = useState<number[]>([]);
  const key = useRef<string | null>(null);
  const send = useMutation({
    mutationFn: () => {
      key.current ??= crypto.randomUUID();
      return api<{ roundRef: string }>(`/sessions/${sessionId}/rounds`, {
        method: 'POST',
        body: roundBody(cart),
        idempotencyKey: key.current,
      });
    },
    onSuccess: () => {
      key.current = null;
      setCart([]);
      setFlagged([]);
    },
    onError: (error) => {
      // A definitive answer ends the intent; a lost connection keeps the key for the retry.
      if (error instanceof ApiError && error.status > 0) key.current = null;
      if (error instanceof ApiError && error.code === 'INSUFFICIENT_STOCK') {
        const shortages = (error.body['shortages'] ?? []) as { lineNos?: number[] }[];
        setFlagged(shortages.flatMap((s) => s.lineNos ?? []));
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['session', sessionId] }),
  });
  const changeCart = (lines: CartLine[]) => {
    key.current = null; // a different order is a different intent
    setFlagged([]);
    setCart(lines);
  };

  const s = detail.data?.session;
  return (
    <>
      <p className="row">
        <Link to="/floor">← Floor</Link>
        {canBill ? <Link to={`/counter?session=${sessionId}`}>Bill and payment →</Link> : null}
      </p>
      <h1>{s ? `${s.tableName ?? 'Takeaway'} · ${s.sessionNo}` : 'Table'}</h1>
      {detail.isError ? (
        <div role="alert" className="banner banner-danger">
          {messageOf(detail.error)}
        </div>
      ) : null}
      {s && !['open', 'checkout_requested'].includes(s.status) ? (
        <div role="status" className="banner banner-info">
          This visit is {s.status.replace('_', ' ')}: no new orders.
        </div>
      ) : null}
      {menu.data && s && ['open', 'checkout_requested'].includes(s.status) ? (
        <Composer
          categories={menu.data.categories}
          cart={cart}
          onCartChange={changeCart}
          onSend={() => {
            send.mutate();
          }}
          sending={send.isPending}
          sendLabel="Send to kitchen"
          disabled={!writes}
          flagged={flagged}
          error={send.isError ? messageOf(send.error) : null}
        />
      ) : null}
      <section className="stack" aria-labelledby="rounds-heading">
        <div className="section-head">
          <h2 id="rounds-heading">Orders</h2>
          {detail.data ? (
            <strong>Accepted so far {rupees(detail.data.acceptedTotal)}</strong>
          ) : null}
        </div>
        <RoundList
          rounds={detail.data?.rounds ?? []}
          lineActions={(l) => <LineActions line={l} sessionId={sessionId} />}
        />
      </section>
    </>
  );
}
