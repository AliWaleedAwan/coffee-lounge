import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes, createQueryClient } from '../../app/App.tsx';
import { HOLD_MS } from '../../components/HeldAction.tsx';
import { connection } from '../../connection/store.ts';
import { lineStatus } from '../../order/RoundList.tsx';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = {
  user: { id: '7', name: 'Sara', username: 'sara' },
  roles: ['waiter'],
  permissions: ['tables.read', 'kitchen.pickup', 'kitchen.read'].map((key) => ({
    key,
    scopes: 'all',
    sources: ['role:waiter'],
  })),
  discountLimitPercent: null,
  device: { id: '1', name: 'Tablet', kind: 'waiter', ownership: 'shop', status: 'active' },
  mustChangePassword: false,
};

const QUEUE = {
  tickets: [
    {
      id: '5',
      ticketNo: 'K-1022-005',
      where: 'Patio',
      acceptedAt: new Date().toISOString(),
      uncollected: false,
      lines: [
        {
          orderLineId: '31',
          qty: 2,
          open: 2,
          item: 'Cappuccino',
          variant: 'Regular',
          modifiers: ['Oat'],
          notes: null,
        },
      ],
    },
  ],
};

let posts: string[] = [];
function serve() {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST') {
        posts.push(url);
        return Promise.resolve(json(200, { lines: [] }));
      }
      if (url.endsWith('/auth/me')) return Promise.resolve(json(200, ME));
      if (url.endsWith('/events')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/pickup')) return Promise.resolve(json(200, QUEUE));
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
}

async function renderPickup() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/pickup']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.findByRole('button', { name: /^Picked up Cappuccino/ });
}

beforeEach(() => {
  localStorage.clear();
  connection.report({ type: 'api_ok' });
  connection.report({ type: 'stream_stopped' });
  serve();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Picked up with a 5-second Undo (AT-92)', () => {
  it('sends nothing during the 5 seconds, and nothing at all after Undo', async () => {
    const button = await renderPickup();
    vi.useFakeTimers();
    fireEvent.click(button);
    expect(screen.getByRole('status').textContent).toMatch(/Picked up 2 × Cappuccino for Patio/);
    await act(() => vi.advanceTimersByTimeAsync(HOLD_MS - 100));
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await act(() => vi.advanceTimersByTimeAsync(HOLD_MS * 2));
    expect(posts).toEqual([]);
  });

  it('sends exactly once when the toast closes', async () => {
    const button = await renderPickup();
    vi.useFakeTimers();
    fireEvent.click(button);
    await act(() => vi.advanceTimersByTimeAsync(HOLD_MS + 50));
    expect(posts).toEqual(['/api/staff/v1/lines/31/pickup']);
    await act(() => vi.advanceTimersByTimeAsync(HOLD_MS * 2));
    expect(posts).toHaveLength(1);
  });

  it('says "Not sent" when the device went offline, and sends nothing', async () => {
    const button = await renderPickup();
    vi.useFakeTimers();
    fireEvent.click(button);
    connection.report({ type: 'api_network_error' });
    await act(() => vi.advanceTimersByTimeAsync(HOLD_MS + 50));
    expect(posts).toEqual([]);
    expect(screen.getByText(/Not sent: Picked up 2 × Cappuccino/)).toBeTruthy();
  });
});

describe('line status', () => {
  it('reads like the floor does', () => {
    const base = { qty: 2, pickedUp: 0, served: 0, cancelled: 0, open: 2 };
    expect(lineStatus(base)).toBe('Being prepared');
    expect(lineStatus({ ...base, pickedUp: 1, served: 1, open: 1 })).toBe('Picked up 1, 1 to come');
    expect(lineStatus({ ...base, pickedUp: 2, served: 2, open: 0 })).toBe('Served');
    expect(lineStatus({ ...base, pickedUp: 2, served: 0, open: 0 })).toBe('Picked up');
    expect(lineStatus({ ...base, cancelled: 2, open: 0 })).toBe('Cancelled');
    expect(lineStatus({ ...base, cancelled: 1, open: 1 })).toBe('Being prepared · 1 cancelled');
  });
});
