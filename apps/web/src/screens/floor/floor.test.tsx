import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import jsQR from 'jsqr';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes, createQueryClient } from '../../app/App.tsx';
import { connection } from '../../connection/store.ts';
import { qrMatrix } from './qr.tsx';
import { QrSheet } from './TablesTab.tsx';

/** Paints the module matrix as RGBA pixels (4 px a module, 4-module quiet zone) and decodes it. */
function decode(text: string): string | null {
  const m = qrMatrix(text);
  const scale = 4;
  const size = (m.length + 8) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  m.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + 4) * scale + y) * size + (c + 4) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    });
  });
  return jsQR(data, size, size)?.data ?? null;
}

describe('QR codes for the table cards', () => {
  it('decode back to exactly the printed link', () => {
    for (const url of [
      'http://192.168.100.250:8080/t/AbCdEfGhIjKlMnOpQrStUv',
      'http://192.168.100.250:8080/t/-_09azAZ-_09azAZ-_09az',
      'http://10.0.0.5:8080/t/0000000000000000000000',
    ]) {
      expect(decode(url)).toBe(url);
    }
  });

  it('print sheet: one card per code, and no printing without a shop address', () => {
    const codes = [
      {
        entryPointId: '1',
        kind: 'table' as const,
        label: 'Table 1',
        tableCode: 'T01',
        url: 'http://10.0.0.5:8080/t/AbCdEfGhIjKlMnOpQrStUv',
      },
      {
        entryPointId: '2',
        kind: 'counter_takeaway' as const,
        label: 'Counter takeaway',
        tableCode: null,
        url: 'http://10.0.0.5:8080/t/0000000000000000000000',
      },
    ];
    render(<QrSheet baseUrl="http://10.0.0.5:8080" codes={codes} onClose={() => undefined} />);
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('aria-label'))).toEqual([
      'QR code for Table 1',
      'QR code for Counter takeaway',
    ]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Print' }).disabled).toBe(false);
    cleanup();
    render(
      <QrSheet
        baseUrl={null}
        codes={codes.map((c) => ({ ...c, url: null }))}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Print' }).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/GUEST_BASE_URL/);
  });
});

// ---------------------------------------------------------------- floor screen

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

function meWith(role: string, keys: string[]) {
  return {
    user: { id: '7', name: 'Sara', username: 'sara' },
    roles: [role],
    permissions: keys.map((key) => ({ key, scopes: 'all', sources: [`role:${role}`] })),
    discountLimitPercent: null,
    device: { id: '1', name: 'Tablet', kind: 'waiter', ownership: 'shop', status: 'active' },
    mustChangePassword: false,
  };
}

const floor = {
  tables: [
    {
      id: '1',
      code: 'T01',
      name: 'Table 1',
      area: null,
      seats: 4,
      availability: 'active',
      state: 'available',
      waiter: null,
      session: null,
    },
    {
      id: '2',
      code: 'T02',
      name: 'Table 2',
      area: null,
      seats: 2,
      availability: 'active',
      state: 'occupied',
      waiter: { id: '7', name: 'Sara' },
      session: {
        id: '40',
        sessionNo: 'S-20261021-0003',
        status: 'open',
        guestCount: 2,
        openedAt: new Date().toISOString(),
        guestPhones: 1,
        stale: false,
      },
    },
    {
      id: '3',
      code: 'T03',
      name: 'Table 3',
      area: null,
      seats: 2,
      availability: 'blocked',
      state: 'blocked',
      waiter: null,
      session: null,
    },
    {
      id: '4',
      code: 'T04',
      name: 'Table 4',
      area: null,
      seats: 6,
      availability: 'active',
      state: 'available',
      waiter: null,
      session: null,
    },
  ],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  key: string | null;
}

function serve(me: object, writes: (call: Call) => Response = () => json(204, null)) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const call = {
        method,
        url,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        key: headers.get('idempotency-key'),
      };
      calls.push(call);
      if (url.endsWith('/auth/me')) return Promise.resolve(json(200, me));
      if (url.endsWith('/events')) return new Promise<Response>(() => undefined);
      if (method !== 'GET') return Promise.resolve(writes(call));
      if (url.endsWith('/floor')) return Promise.resolve(json(200, floor));
      if (url.endsWith('/assignable-staff'))
        return Promise.resolve(json(200, { items: [{ id: '7', name: 'Sara' }] }));
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
  return calls;
}

function renderFloor() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/floor']}>
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

describe('floor screen', () => {
  it('shows each table with its state, waiter and session', async () => {
    serve(meWith('waiter', ['tables.read', 'orders.create']));
    renderFloor();
    const t2 = await screen.findByRole('region', { name: 'Table 2' });
    expect(within(t2).getByText('Occupied')).toBeTruthy();
    expect(within(t2).getByText('S-20261021-0003')).toBeTruthy();
    expect(within(t2).getByText('Sara')).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Table 3' })).getByText('Blocked'),
    ).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull(); // waiters do not manage tables
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull(); // no sessions.transfer
  });

  it('opens a table with a fresh Idempotency-Key per intent', async () => {
    const calls = serve(meWith('waiter', ['tables.read', 'orders.create']), () =>
      json(201, { id: '41' }),
    );
    renderFloor();
    fireEvent.click(await screen.findByRole('button', { name: 'Open table Table 1' }));
    fireEvent.change(screen.getByLabelText('Guests (optional)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open table' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: '/api/staff/v1/tables/1/sessions',
        body: { guestCount: 3 },
      });
    });
    expect(calls.find((c) => c.method === 'POST')?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('moves a session only to a free table and explains an occupied one', async () => {
    const calls = serve(meWith('manager', ['tables.read', 'sessions.transfer']), () =>
      json(409, {
        code: 'TABLE_OCCUPIED',
        detail: 'That table already has session S-20261021-0004',
      }),
    );
    renderFloor();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Table 2' }));
    const select = screen.getByLabelText('Move to');
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Choose a free table',
      'Table 1',
      'Table 4',
    ]);
    fireEvent.change(select, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move session' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /already has session .*Choose a free table/,
    );
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/staff/v1/sessions/40/transfer',
      body: { toTableId: '4' },
    });
  });
});
