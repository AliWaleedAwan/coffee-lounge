/**
 * Guest app (P3-2: second entry of apps/web, served by the customer listener). Step 3.4
 * covers landing from the QR code, the menu and cart, sending an order and following its
 * status; step 3.11 finishes it (live updates, bill request, counter QR, more states).
 *
 * The Idempotency-Key of a send is kept with the cart in sessionStorage until the shop
 * answers, so a retry after a dropped connection or a reload cannot order twice (AT-24).
 */
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes, useNavigate, useParams } from 'react-router';
import { roundBody, type CartLine, type MenuCategory } from '../order/cart.ts';
import { Composer } from '../order/Composer.tsx';
import { RoundList, type Round } from '../order/RoundList.tsx';
import { GuestError, guestApi, memo } from './api.ts';

interface Entry {
  entry: {
    kind: 'table' | 'counter_takeaway';
    label: string;
    table: { code: string; name: string } | null;
  };
  orderingOpen: boolean;
  session: { sessionNo: string } | null;
}

interface Visit {
  session: { sessionNo: string; status: string };
  rounds: Round[];
  acceptedTotal: string;
}

const CART = 'cl.guest.cart';
const PENDING_KEY = 'cl.guest.sendKey';
const PLACE = 'cl.guest.place';

export function createGuestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (n, e) => !(e instanceof GuestError && e.status < 500) && n < 2,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="guest">
      <header className="topbar">
        <span className="brand-mark">Coffee Lounge</span>
        <span className="topbar-spacer" />
        <span>{title}</span>
      </header>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell title="">
      <div className="card stack" role="status">
        <h1>{title}</h1>
        {children}
      </div>
    </Shell>
  );
}

/** /t/<token>: the printed QR link. Checks it once, then moves to /order. */
function Landing() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    guestApi<Entry>(`/entry/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then((entry) => {
        memo.set(PLACE, entry);
        void navigate('/order', { replace: true });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setProblem(error instanceof GuestError ? error.message : 'Something went wrong.');
      });
    return () => {
      controller.abort();
    };
  }, [token, navigate]);
  if (problem) {
    return (
      <Message title="This code does not work">
        <p>{problem}</p>
      </Message>
    );
  }
  return <Message title="Opening the menu…">{null}</Message>;
}

function OrderPage() {
  const client = useQueryClient();
  const place = memo.get<Entry | null>(PLACE, null);
  const [tab, setTab] = useState<'menu' | 'orders'>('menu');
  const [cart, setCartState] = useState<CartLine[]>(() => memo.get<CartLine[]>(CART, []));
  const setCart = (lines: CartLine[]) => {
    memo.set(CART, lines);
    memo.set(PENDING_KEY, null); // a different order is a different intent
    setCartState(lines);
  };
  const menu = useQuery({
    queryKey: ['guest', 'menu'],
    queryFn: ({ signal }) => guestApi<{ categories: MenuCategory[] }>('/menu', { signal }),
  });
  const visit = useQuery({
    queryKey: ['guest', 'visit'],
    queryFn: async ({ signal }) => {
      try {
        return await guestApi<Visit>('/session', { signal });
      } catch (error) {
        if (error instanceof GuestError && error.status === 404) return null; // nothing ordered yet
        throw error;
      }
    },
    // Live updates join in step 3.11; until then the status refreshes every 10 seconds.
    refetchInterval: 10_000,
  });
  const send = useMutation({
    mutationFn: () => {
      const key = memo.get<string | null>(PENDING_KEY, null) ?? crypto.randomUUID();
      memo.set(PENDING_KEY, key);
      return guestApi('/rounds', { method: 'POST', body: roundBody(cart), idempotencyKey: key });
    },
    onSuccess: () => {
      memo.set(PENDING_KEY, null);
      memo.set(CART, null);
      setCartState([]);
      setTab('orders');
    },
    onError: (error) => {
      if (error instanceof GuestError && error.status > 0) memo.set(PENDING_KEY, null);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['guest', 'visit'] }),
  });
  const withdraw = useMutation({
    mutationFn: (round: Round) =>
      guestApi(`/rounds/${round.id}/withdraw`, {
        method: 'POST',
        body: {},
        idempotencyKey: crypto.randomUUID(),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: ['guest', 'visit'] }),
  });

  const ended = [menu.error, visit.error, send.error].some(
    (e) => e instanceof GuestError && e.code === 'VISIT_ENDED',
  );
  if (ended || !place) {
    return (
      <Message title="Scan the QR code on your table">
        <p>
          Your visit has ended, or this phone has not scanned a table yet. Scan the code to see the
          menu and order.
        </p>
      </Message>
    );
  }
  const where = place.entry.table?.name ?? place.entry.label;
  const pending = (visit.data?.rounds ?? []).filter((r) => r.status === 'pending_approval').length;
  return (
    <Shell title={where}>
      <h1 className="visually-hidden">Order at {where}</h1>
      {!place.orderingOpen ? (
        <div role="status" className="banner banner-warning">
          This table is not taking orders right now. Please ask a member of staff.
        </div>
      ) : null}
      <div className="tabs" role="tablist" aria-label="Order sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'menu'}
          onClick={() => {
            setTab('menu');
          }}
        >
          Menu
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'orders'}
          onClick={() => {
            setTab('orders');
          }}
        >
          My orders{pending > 0 ? ` (${String(pending)} waiting)` : ''}
        </button>
      </div>
      {tab === 'menu' ? (
        menu.data ? (
          <Composer
            categories={menu.data.categories}
            cart={cart}
            onCartChange={setCart}
            onSend={() => {
              send.mutate();
            }}
            sending={send.isPending}
            sendLabel="Send order"
            disabled={!place.orderingOpen}
            error={send.isError ? send.error.message : null}
          />
        ) : (
          <p className="muted">{menu.isError ? menu.error.message : 'Loading the menu…'}</p>
        )
      ) : (
        <section className="stack" aria-label="My orders">
          <p className="muted">Staff accept each order before it goes to the kitchen.</p>
          <RoundList
            rounds={visit.data?.rounds ?? []}
            onWithdraw={(round) => {
              withdraw.mutate(round);
            }}
          />
        </section>
      )}
    </Shell>
  );
}

export function GuestRoutes() {
  return (
    <Routes>
      <Route path="/t/:token" element={<Landing />} />
      <Route path="/order" element={<OrderPage />} />
      <Route
        path="*"
        element={
          <Message title="Scan the QR code on your table">
            <p>Every table has a code. Scan it with your phone camera to see the menu and order.</p>
          </Message>
        }
      />
    </Routes>
  );
}

export function GuestApp({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <GuestRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
