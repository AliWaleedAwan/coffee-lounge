/**
 * The signed-in frame: top bar (shop, user, Switch user, Log out), connection banner,
 * navigation built from permissions, and the live-update stream.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, use, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api, ApiError } from '../api/client.ts';
import { permissionSet, recentUsers, roleLabel, useMe, type Me } from '../auth/session.ts';
import { savedBranding, useBranding } from '../branding/brand.ts';
import { BackupBanner } from '../connection/BackupBanner.tsx';
import { ConnectionBanner } from '../connection/ConnectionBanner.tsx';
import { LiveUpdates } from '../live/LiveUpdates.tsx';
import { PrinterBanner } from './printing/PrinterBanner.tsx';
import { visibleAreas, type Area } from '../nav/areas.ts';

const MeContext = createContext<Me | null>(null);

/** The signed-in user; only valid inside the shell. */
export function useSignedIn(): Me {
  const me = use(MeContext);
  if (!me) throw new Error('useSignedIn outside the signed-in shell');
  return me;
}

function FullScreenMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="center-screen">
      <div className="center-card card" role="status">
        <span className="brand-mark">{savedBranding().shopName}</span>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Loads `/auth/me` and sends the device to registration, PIN or login when needed. */
export function RequireSession() {
  const me = useMe();
  const location = useLocation();
  const error = me.error;
  if (error instanceof ApiError) {
    if (error.code === 'DEVICE_NOT_REGISTERED') return <Navigate to="/register" replace />;
    if (error.code === 'UNAUTHENTICATED') {
      return (
        <Navigate
          to={recentUsers().length > 0 ? '/pin' : '/login'}
          replace
          state={{ from: location.pathname }}
        />
      );
    }
  }
  if (me.data) {
    if (me.data.mustChangePassword && location.pathname !== '/account') {
      return <Navigate to="/account" replace />;
    }
    return (
      <MeContext value={me.data}>
        <Shell me={me.data} />
      </MeContext>
    );
  }
  if (me.isError) {
    return (
      <FullScreenMessage title="Cannot reach the server">
        <ConnectionBanner />
        <button type="button" className="btn btn-primary btn-lg" onClick={() => void me.refetch()}>
          Try again
        </button>
      </FullScreenMessage>
    );
  }
  return <FullScreenMessage title="Loading…" />;
}

/** Demo only (a loaded demo, docs/phase-8/DEMO.md): become another role with one click. */
function DemoSwitch({ me }: { me: Me }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const demo = useQuery({
    queryKey: ['demo'],
    queryFn: ({ signal }) =>
      api<{ active: boolean; people: { username: string; name: string; role: string }[] }>(
        '/demo',
        { signal },
      ),
  });
  const swap = useMutation({
    mutationFn: (username: string) =>
      api<undefined>('/demo/switch', { method: 'POST', body: { username } }),
    onSuccess: () => {
      client.clear();
      void navigate('/', { replace: true });
    },
  });
  if (!demo.data?.active) return null;
  const known = demo.data.people.some((p) => p.username === me.user.username);
  return (
    <label className="demo-switch">
      <span className="chip chip-warning">Demo</span>
      <span className="visually-hidden">Switch to role</span>
      <select
        value={known ? me.user.username : ''}
        disabled={swap.isPending}
        onChange={(e) => {
          swap.mutate(e.target.value);
        }}
      >
        {known ? null : <option value="">{me.user.name}</option>}
        {demo.data.people.map((p) => (
          <option key={p.username} value={p.username}>
            {p.role}: {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Shell({ me }: { me: Me }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const permissions = permissionSet(me);
  const areas = visibleAreas(permissions);
  const branding = useBranding();
  const logout = useMutation({
    mutationFn: () => api<undefined>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      client.clear();
      void navigate('/login', { replace: true });
    },
  });

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand-mark">{branding.shopName}</span>
        <span className="chip chip-info">{me.device.name}</span>
        <span className="topbar-spacer" />
        <DemoSwitch me={me} />
        <span className="topbar-user">
          {me.user.name} · {roleLabel(me)}
        </span>
        <NavLink className="btn btn-ghost" to="/account">
          My account
        </NavLink>
        <NavLink className="btn btn-secondary" to="/pin">
          Switch user
        </NavLink>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={logout.isPending}
          onClick={() => {
            logout.mutate();
          }}
        >
          Log out
        </button>
      </header>
      <div className="status-banners">
        <ConnectionBanner />
        <BackupBanner canSeeHealth={permissions.has('system.health')} />
        <PrinterBanner
          canSee={permissions.has('kitchen.read')}
          canFix={permissions.has('kitchen.reprint')}
          canSetUp={permissions.has('printers.manage')}
        />
      </div>
      <div className="shell-body">
        <nav className="nav" aria-label="Main">
          {areas.map((area) => (
            <NavLink key={area.id} to={area.path}>
              {area.label}
            </NavLink>
          ))}
        </nav>
        <main className="main" id="main">
          <Outlet />
        </main>
      </div>
      <LiveUpdates />
    </div>
  );
}

/** Shown for areas built in later phases, and for areas the user cannot open. */
export function AreaPage({ area, children }: { area: Area; children?: ReactNode }) {
  const me = useSignedIn();
  const allowed = area.anyOf.some((p) => permissionSet(me).has(p));
  if (!allowed) {
    return (
      <>
        <h1>{area.label}</h1>
        <div role="alert" className="banner banner-danger">
          Your role does not include this area. Ask a manager if you need it.
        </div>
      </>
    );
  }
  if (children) return <>{children}</>;
  return (
    <>
      <h1>{area.label}</h1>
      <div className="card stack">
        <p>This area is not built yet. It arrives in a later phase of the build.</p>
        <p className="muted">
          You can see it because your role includes {area.anyOf.join(' or ')}.
        </p>
      </div>
    </>
  );
}
