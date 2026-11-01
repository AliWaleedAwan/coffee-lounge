/**
 * Guest app (P3-2: second entry of apps/web, served by the customer listener; UI_UX.md
 * Guest board, journey J1). A guest scans the QR code, sees the menu ("Unavailable right
 * now" items stay visible, greyed), builds the order in item sheets, reviews it, sends it
 * and follows it: waiting for staff → accepted → being prepared → served. More can be
 * ordered and, at a table, the bill requested. From the counter QR the order is paid at
 * the counter first; a paid order can be followed to pickup.
 *
 * Live updates (`GET /events`) refresh the screen when staff act; nothing is decided
 * from a hint. The Idempotency-Key of a send is kept with the cart in sessionStorage
 * until the shop answers, so a retry after a dropped connection cannot order twice (AT-24).
 */
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useNavigate, useParams } from 'react-router';
import { applyBranding } from '../branding/brand.ts';
import { invalidateAll, invalidateForHint } from '../live/invalidate.ts';
import { LiveClient } from '../live/live-client.ts';
import { cartTotal, roundBody, rupees, type CartLine, type MenuCategory } from '../order/cart.ts';
import { CartPanel, MenuPicker } from '../order/Composer.tsx';
import { RoundList, type Round } from '../order/RoundList.tsx';
import { GUEST_API, GuestError, guestApi, memo } from './api.ts';
import { progressOf } from './progress.ts';

interface Entry {
  branding?: { shopName: string; primary: string };
  /** Guests order by QR within the shop's hours (AT-130). */
  hours?: { open: boolean; opens: string; closes: string };
  entry: {
    kind: 'table' | 'counter_takeaway';
    label: string;
    table: { code: string; name: string } | null;
  };
  orderingOpen: boolean;
  session: { sessionNo: string } | null;
}

interface Visit {
  session: {
    sessionNo: string;
    orderType: string;
    status: string;
    billRequested: boolean;
    payBy: string | null;
    invoiceNo: string | null;
    readOnly: boolean;
  };
  rounds: Round[];
  acceptedTotal: string;
}

type View = 'menu' | 'cart' | 'status';

const CART = 'cl.guest.cart';
const PENDING_KEY = 'cl.guest.sendKey';
const BILL_KEY = 'cl.guest.billKey';
const PLACE = 'cl.guest.place';
const NAME = 'cl.guest.name';

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

/** The shop's name as the owner set it (Settings → Branding). */
function shopName(): string {
  return memo.get<Entry | null>(PLACE, null)?.branding?.shopName ?? 'Coffee Lounge';
}

/** Why ordering from this phone is closed: outside the shop's hours, or the table is off. */
function closedMessage(place: Entry): string {
  if (place.hours && !place.hours.open) {
    return `We are closed for orders from your phone now. Orders open again at ${place.hours.opens}; please ask a member of staff.`;
  }
  return 'This table is not taking orders right now. Please ask a member of staff.';
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="guest">
      <header className="topbar">
        <span className="brand-mark">{shopName()}</span>
        <span className="topbar-spacer" />
        <span>{title}</span>
      </header>
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Shell title="">
      <div className="card stack" role="status">
        <h1>{title}</h1>
        {children}
      </div>
    </Shell>
  );
}

/** Demo only: where a demo is loaded, a table can be picked instead of scanning its code. */
function DemoTables() {
  const tables = useQuery({
    queryKey: ['demo-tables'],
    queryFn: () => guestApi<{ tables: { label: string; token: string }[] }>('/demo/tables'),
  });
  if (!tables.data?.tables.length) return null;
  return (
    <>
      <h2>Demo: pick a table</h2>
      <div className="row">
        {tables.data.tables.map((t) => (
          <a key={t.token} className="btn btn-secondary" href={`/t/${t.token}`}>
            {t.label}
          </a>
        ))}
      </div>
    </>
  );
}

function VisitEnded() {
  return (
    <Message title="Scan the QR code on your table">
      <p>
        Your visit has ended, or this phone has not scanned a code yet. Scan the code on your table,
        or at the counter, to see the menu and order.
      </p>
      <DemoTables />
    </Message>
  );
}

/** UI_UX.md state "Not on shop Wi-Fi": the phone cannot reach the shop's server. */
function OffWifi({ onRetry }: { onRetry: () => void }) {
  return (
    <Message title="Not on the shop Wi-Fi?">
      <p>
        Ordering works on the shop’s Wi-Fi only. Join it (ask a member of staff for the name), then
        try again.
      </p>
      <div>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </Message>
  );
}

const offline = (e: unknown) => e instanceof GuestError && e.code === 'NETWORK_ERROR';
const ended = (e: unknown) => e instanceof GuestError && e.code === 'VISIT_ENDED';

/** /t/<token>: the printed QR link. Checks it, then welcomes the guest. */
function Landing() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [place, setPlace] = useState<Entry | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    guestApi<Entry>(`/entry/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then((entry) => {
        memo.set(PLACE, entry);
        if (entry.branding) applyBranding(entry.branding);
        if (entry.session) void navigate('/order', { replace: true });
        else setPlace(entry);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(error);
      });
    return () => {
      controller.abort();
    };
  }, [token, navigate, attempt]);
  if (offline(problem)) {
    return (
      <OffWifi
        onRetry={() => {
          setProblem(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (problem) {
    return (
      <Message title="This code does not work">
        <p>{problem instanceof GuestError ? problem.message : 'Something went wrong.'}</p>
      </Message>
    );
  }
  if (!place) return <Message title="Opening the menu…">{null}</Message>;
  const counter = place.entry.kind === 'counter_takeaway';
  return (
    <Shell title="">
      <div className="card stack guest-welcome">
        <p className="brand-mark">{shopName()}</p>
        <h1>{place.entry.table?.name ?? place.entry.label}</h1>
        <p>
          {counter
            ? 'Order from your phone, then pay at the counter. Your order goes to the kitchen once it is paid.'
            : 'Order from your phone. A staff member confirms your order before it’s prepared.'}
        </p>
        {place.orderingOpen ? null : (
          <p className="banner banner-warning">{closedMessage(place)}</p>
        )}
        <button
          type="button"
          className="btn btn-primary btn-lg btn-block"
          onClick={() => {
            void navigate('/order');
          }}
        >
          View menu
        </button>
      </div>
    </Shell>
  );
}

/** Live hints for this phone's visit; reconnects when the visit changes (first order). */
function useGuestLive(visitKey: string) {
  const client = useQueryClient();
  useEffect(() => {
    const live = new LiveClient({
      url: `${GUEST_API}/events`,
      onHint: (hint) => void invalidateForHint(client, hint.topics),
      onResync: () => void invalidateAll(client),
      onOpen: () => undefined,
      onLost: () => undefined,
      // The visit ended (paid, closed, or staff reset the phones): show it.
      onRefused: () => void client.invalidateQueries({ queryKey: ['guest', 'visit'] }),
    });
    live.start();
    return () => {
      live.stop();
    };
  }, [client, visitKey]);
}

function OrderPage() {
  const client = useQueryClient();
  const place = memo.get<Entry | null>(PLACE, null);
  const [cart, setCartState] = useState<CartLine[]>(() => memo.get<CartLine[]>(CART, []));
  const [name, setName] = useState(() => memo.get<string>(NAME, ''));
  const setCart = (lines: CartLine[]) => {
    memo.set(CART, lines);
    memo.set(PENDING_KEY, null); // a different order is a different intent
    setCartState(lines);
  };
  const menu = useQuery({
    queryKey: ['guest', 'menu'],
    queryFn: ({ signal }) => guestApi<{ categories: MenuCategory[] }>('/menu', { signal }),
    meta: { topics: ['menu'] },
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
    meta: { topics: ['session'] },
    // Live hints refresh it; this is the fallback if the stream is down.
    refetchInterval: 30_000,
  });
  useGuestLive(visit.data?.session.sessionNo ?? 'none');
  const [view, setView] = useState<View | null>(null);
  const shown: View = view ?? ((visit.data?.rounds.length ?? 0) > 0 ? 'status' : 'menu');

  const counter = place?.entry.kind === 'counter_takeaway';
  // A paid counter order is followed read-only; ordering again starts a new visit.
  const newVisit = !visit.data || visit.data.session.readOnly;
  const send = useMutation({
    mutationFn: () => {
      const key = memo.get<string | null>(PENDING_KEY, null) ?? crypto.randomUUID();
      memo.set(PENDING_KEY, key);
      return guestApi('/rounds', {
        method: 'POST',
        body: {
          ...roundBody(cart),
          ...(counter && newVisit && name.trim() ? { customerName: name.trim() } : {}),
        },
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      memo.set(PENDING_KEY, null);
      memo.set(CART, null);
      setCartState([]);
      setView('status');
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
  const bill = useMutation({
    mutationFn: () => {
      const key = memo.get<string | null>(BILL_KEY, null) ?? crypto.randomUUID();
      memo.set(BILL_KEY, key);
      return guestApi('/session/bill-request', { method: 'POST', body: {}, idempotencyKey: key });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['guest', 'visit'] }),
  });

  if ([menu.error, visit.error, send.error].some(offline)) {
    return (
      <OffWifi
        onRetry={() => {
          send.reset();
          void client.invalidateQueries({ queryKey: ['guest'] });
        }}
      />
    );
  }
  if ([menu.error, visit.error, send.error].some(ended) || !place) return <VisitEnded />;

  const where = place.entry.table?.name ?? place.entry.label;
  const count = cart.reduce((n, l) => n + l.qty, 0);
  return (
    <Shell title={where}>
      <h1 className="visually-hidden">Order at {where}</h1>
      {!place.orderingOpen ? (
        <div role="status" className="banner banner-warning">
          {closedMessage(place)}
        </div>
      ) : null}
      {shown === 'menu' ? (
        <>
          {visit.data && visit.data.rounds.length > 0 ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setView('status');
              }}
            >
              ← My orders
            </button>
          ) : null}
          {menu.data ? (
            <MenuPicker
              categories={menu.data.categories}
              photoBase={GUEST_API}
              disabled={!place.orderingOpen}
              onAdd={(line) => {
                setCart([...cart, line]);
              }}
            />
          ) : (
            <p className="muted">{menu.isError ? menu.error.message : 'Loading the menu…'}</p>
          )}
          {count > 0 ? (
            <div className="cart-bar">
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={() => {
                  setView('cart');
                }}
              >
                <span>View order · {count === 1 ? '1 item' : `${String(count)} items`}</span>
                <span>{rupees(cartTotal(cart))}</span>
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {shown === 'cart' ? (
        <div className="stack">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setView('menu');
            }}
          >
            ← Menu
          </button>
          {counter && newVisit ? (
            <label className="field">
              <span>Your name, to call you when it’s ready (optional)</span>
              <input
                maxLength={40}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  memo.set(NAME, e.target.value);
                }}
              />
            </label>
          ) : null}
          <CartPanel
            title="Your order"
            cart={cart}
            onCartChange={setCart}
            onSend={() => {
              send.mutate();
            }}
            sending={send.isPending}
            sendLabel={counter ? 'Send, then pay at the counter' : 'Send order'}
            disabled={!place.orderingOpen}
            error={send.isError ? send.error.message : null}
            note={
              <p className="muted">
                {counter
                  ? 'Pay at the counter: your order goes to the kitchen once it is paid.'
                  : 'A staff member confirms your order before it’s made. If an item has just run out, they’ll tell you here.'}
              </p>
            }
          />
        </div>
      ) : null}
      {shown === 'status' && visit.data ? (
        <Status
          visit={visit.data}
          counter={counter}
          where={where}
          onMore={() => {
            setView('menu');
          }}
          onWithdraw={(round) => {
            withdraw.mutate(round);
          }}
          onBill={() => {
            bill.mutate();
          }}
          billing={bill.isPending}
          billError={bill.isError ? bill.error.message : null}
        />
      ) : null}
    </Shell>
  );
}

const countdown = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
};

function Status({
  visit,
  counter,
  where,
  onMore,
  onWithdraw,
  onBill,
  billing,
  billError,
}: {
  visit: Visit;
  counter: boolean;
  where: string;
  onMore: () => void;
  onWithdraw: (round: Round) => void;
  onBill: () => void;
  billing: boolean;
  billError: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const s = visit.session;
  const latest = [...visit.rounds].reverse().find((r) => r.mine) ?? visit.rounds.at(-1);
  const takeaway = s.orderType === 'takeaway';
  const progress = latest ? progressOf(latest, takeaway) : null;
  const tableOpen = !takeaway && (s.status === 'open' || s.status === 'checkout_requested');
  const hasAccepted = visit.rounds.some((r) => r.status === 'accepted');
  return (
    <div className="stack">
      {counter && s.payBy && latest?.status === 'pending_approval' ? (
        <div className="card stack guest-pay" role="status">
          <h2>Pay at the counter</h2>
          <p>
            Show this at the counter: <strong>order {latest.roundRef}</strong> ·{' '}
            {rupees(latest.quotedTotal)}
          </p>
          <p className="muted">
            Your order goes to the kitchen once it is paid. Pay within{' '}
            {countdown(Date.parse(s.payBy) - now)}, or it is cancelled.
          </p>
        </div>
      ) : null}
      {s.invoiceNo ? (
        <div role="status" className="banner banner-success">
          Paid · {s.invoiceNo}
        </div>
      ) : null}
      {latest && progress ? (
        <section className="card stack" aria-labelledby="progress">
          <p className="muted">
            {where} · {latest.roundRef}
          </p>
          <h2 id="progress">{progress.headline}</h2>
          {s.billRequested && tableOpen ? (
            <p className="banner banner-info">Bill requested. A staff member is on the way.</p>
          ) : null}
          {progress.step >= 0 ? (
            <ol className="timeline">
              {progress.steps.map((t, i) => (
                <li
                  key={t.label}
                  className={
                    i < progress.step ? 'done' : i === progress.step ? 'done current' : undefined
                  }
                  aria-current={i === progress.step ? 'step' : undefined}
                >
                  <span className="timeline-label">{t.label}</span>
                  {i <= progress.step ? <span className="muted">{t.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
      <section className="stack" aria-label="My orders">
        <RoundList rounds={visit.rounds} onWithdraw={onWithdraw} />
        {hasAccepted ? (
          <p>
            <strong>Total so far {rupees(visit.acceptedTotal)}</strong>
          </p>
        ) : null}
      </section>
      {billError ? (
        <div role="alert" className="banner banner-danger">
          {billError}
        </div>
      ) : null}
      <div className="stack">
        {tableOpen || s.readOnly || counter ? (
          <button type="button" className="btn btn-secondary btn-lg btn-block" onClick={onMore}>
            {s.readOnly ? 'Order again' : 'Order more'}
          </button>
        ) : null}
        {tableOpen && hasAccepted && !s.billRequested ? (
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block"
            disabled={billing}
            onClick={onBill}
          >
            Request bill
          </button>
        ) : null}
      </div>
    </div>
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
            <DemoTables />
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
