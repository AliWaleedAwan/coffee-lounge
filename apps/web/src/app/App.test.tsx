import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connection } from '../connection/store.ts';
import { AppRoutes, createQueryClient } from './App.tsx';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

const WAITER_ME = {
  user: { id: '2', name: 'Sara', username: 'sara' },
  roles: ['waiter'],
  permissions: ['tables.read', 'orders.accept', 'kitchen.pickup', 'menu.read'].map((key) => ({
    key,
    scopes: 'all',
    sources: ['role:waiter'],
  })),
  discountLimitPercent: null,
  device: { id: '1', name: 'Tablet 2', kind: 'waiter', ownership: 'shop', status: 'active' },
  mustChangePassword: false,
};

function serve(me: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/auth/me')) return Promise.resolve(me());
      if (url.endsWith('/events')) return new Promise<Response>(() => undefined); // stream stays open
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  connection.report({ type: 'api_ok' });
  connection.report({ type: 'stream_stopped' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('session gate and navigation', () => {
  it('sends an unregistered device to registration', async () => {
    serve(() => json(403, { code: 'DEVICE_NOT_REGISTERED', detail: 'Not registered' }));
    renderAt('/devices');
    expect(await screen.findByRole('heading', { name: 'Register this device' })).toBeTruthy();
  });

  it('asks for a login, or a PIN when the device has recent users', async () => {
    serve(() => json(401, { code: 'UNAUTHENTICATED', detail: 'Please log in' }));
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeTruthy();
    cleanup();
    localStorage.setItem('cl.recentUsers', JSON.stringify([{ username: 'sara', name: 'Sara' }]));
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Who is using this device?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sara' })).toBeTruthy();
  });

  it('builds the waiter navigation and lands on the first area', async () => {
    serve(() => json(200, WAITER_ME));
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Floor' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Floor',
      'Approvals',
      'Pickup',
    ]);
    expect(screen.getByText('Sara · Waiter')).toBeTruthy();
  });

  it('refuses an area outside the role even when typed into the address bar', async () => {
    serve(() => json(200, WAITER_ME));
    renderAt('/devices');
    expect(await screen.findByText(/Your role does not include this area/)).toBeTruthy();
  });

  it('forces a password change first when the account requires it', async () => {
    serve(() => json(200, { ...WAITER_ME, mustChangePassword: true }));
    renderAt('/floor');
    expect(await screen.findByRole('heading', { name: 'My account' })).toBeTruthy();
    expect(screen.getByText(/Your password was reset/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'PIN for switching users' })).toBeNull();
  });

  it('shows the server-starting state when the API is not ready', async () => {
    serve(() => json(503, { code: 'SERVER_STARTING', detail: 'Checking the database.' }));
    renderAt('/');
    expect(
      await screen.findByRole('heading', { name: 'Cannot reach the server' }, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(screen.getByText(/Server starting/)).toBeTruthy();
  });
});
