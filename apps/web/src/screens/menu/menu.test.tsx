import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes, createQueryClient } from '../../app/App.tsx';
import { connection } from '../../connection/store.ts';
import { describeSchedule, parseTags, rupees, type Menu, type Promotion } from './menu-api.ts';

describe('menu helpers', () => {
  it('keeps dietary tags exactly as typed, dropping only blank lines (AT-126)', () => {
    expect(parseTags('Contains NUTS\n\n  \negg-free \nHalal ✓')).toEqual([
      'Contains NUTS',
      'egg-free ',
      'Halal ✓',
    ]);
  });

  it('shows rupees without empty paisa', () => {
    expect(rupees('450.00')).toBe('Rs 450');
    expect(rupees('284.75')).toBe('Rs 284.75');
  });

  it('describes a promotion schedule in plain words', () => {
    const p: Promotion = {
      id: '1',
      name: 'Happy hour',
      kind: 'percent',
      value: '10',
      startsOn: '2026-10-01',
      endsOn: null,
      daysOfWeek: [5, 1, 2, 3, 4],
      timeFrom: '15:00:00',
      timeTo: '18:00:00',
      isActive: true,
      version: 1,
      itemIds: [],
      categoryIds: ['1'],
    };
    expect(describeSchedule(p)).toBe('Mon, Tue, Wed, Thu, Fri · 15:00–18:00 · from 2026-10-01');
    expect(
      describeSchedule({
        ...p,
        daysOfWeek: null,
        timeFrom: null,
        timeTo: null,
        endsOn: '2026-10-31',
      }),
    ).toBe('Every day · all day · 2026-10-01 to 2026-10-31');
  });
});

// ---------------------------------------------------------------- screen

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

function meWith(role: string, keys: string[]) {
  return {
    user: { id: '1', name: 'Asad', username: 'asad' },
    roles: [role],
    permissions: keys.map((key) => ({ key, scopes: 'all', sources: [`role:${role}`] })),
    discountLimitPercent: null,
    device: { id: '1', name: 'Counter', kind: 'reception', ownership: 'shop', status: 'active' },
    mustChangePassword: false,
  };
}

const variant = {
  id: '31',
  name: 'Regular',
  price: '450.00',
  promotionPrice: '400.00',
  promotionId: '5',
  isDefault: true,
  available: true,
  unavailableReason: null,
  unavailableNote: null,
};

function menuData(management: boolean): Menu {
  return {
    categories: [
      {
        id: '1',
        name: 'Coffee',
        ...(management ? { isActive: true, version: 1 } : {}),
        items: [
          {
            id: '21',
            name: 'Latte',
            description: null,
            dietaryTags: ['Contains MILK', 'nut-free '],
            allowDineIn: true,
            allowTakeaway: true,
            allowDelivery: false,
            ...(management ? { categoryId: '1', isActive: true, version: 3 } : {}),
            variants: [{ ...variant, ...(management ? { isActive: true, version: 2 } : {}) }],
            modifierGroups: [],
          },
        ],
      },
    ],
    ...(management ? { modifierGroups: [] } : {}),
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(
  me: object,
  writes: (call: Call) => Response = () => json(200, {}),
  staffMenu: () => Menu = () => menuData(false),
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.endsWith('/auth/me')) return Promise.resolve(json(200, me));
      if (url.endsWith('/events')) return new Promise<Response>(() => undefined);
      if (method !== 'GET') return Promise.resolve(writes({ method, url, body }));
      if (url.endsWith('/menu/catalog')) return Promise.resolve(json(200, menuData(true)));
      if (url.endsWith('/menu')) return Promise.resolve(json(200, staffMenu()));
      if (url.endsWith('/promotions')) return Promise.resolve(json(200, { items: [] }));
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
  return calls;
}

function renderMenu() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/menu']}>
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

describe('menu screen', () => {
  it('gives the owner items, choices and promotions, with tags exactly as entered', async () => {
    serve(
      meWith('owner', [
        'menu.read',
        'menu.manage',
        'menu.price_change',
        'menu.availability_toggle',
        'promotions.manage',
      ]),
    );
    renderMenu();
    expect(await screen.findByRole('heading', { name: 'Coffee' })).toBeTruthy();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Items',
      'Choices',
      'Promotions',
    ]);
    const row = screen.getByRole('row', { name: /Latte/ });
    expect(
      within(row).getByText('Contains MILK · nut-free ', { normalizer: (s) => s }),
    ).toBeTruthy();
    expect(within(row).getByText('Rs 450').className).toBe('strike');
    expect(within(row).getByText('Rs 400')).toBeTruthy();
  });

  it('lets a cashier mark a size unavailable with a reason, and nothing else', async () => {
    const calls = serve(meWith('cashier', ['menu.read', 'menu.availability_toggle']));
    renderMenu();
    expect(await screen.findByRole('heading', { name: 'Coffee' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Mark unavailable\s*\(Regular\)$/ }));
    fireEvent.change(screen.getByLabelText(/Why is Regular unavailable/), {
      target: { value: 'Machine broken' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark unavailable' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: '/api/staff/v1/menu/variants/31/availability',
        body: { available: false, reason: 'Machine broken' },
      });
    });
  });

  it('explains a stale edit and reloads the catalogue (CT-10)', async () => {
    const calls = serve(meWith('owner', ['menu.read', 'menu.manage']), () =>
      json(409, { code: 'STALE_STATE', detail: 'Category was changed by someone else.' }),
    );
    renderMenu();
    expect(await screen.findByRole('heading', { name: 'Coffee' })).toBeTruthy();
    const catalogReads = () =>
      calls.filter((c) => c.method === 'GET' && c.url.endsWith('/menu/catalog')).length;
    const before = catalogReads();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Someone else changed this first/,
    );
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      expectedVersion: 1,
      isActive: false,
    });
    await waitFor(() => {
      expect(catalogReads()).toBeGreaterThan(before);
    });
  });

  it('creates an item with whole-rupee sizes and the tags as typed', async () => {
    const calls = serve(meWith('owner', ['menu.read', 'menu.manage']), () =>
      json(201, { id: '22', variantIds: ['32'] }),
    );
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: 'Add item' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mocha' } });
    fireEvent.change(screen.getByLabelText('Dietary and allergen tags'), {
      target: { value: 'Contains MILK\n\nnut-free ' },
    });
    const create = screen.getByRole('button', { name: 'Create item' });
    fireEvent.change(screen.getByLabelText('Price of size 1'), { target: { value: '520.50' } });
    expect(screen.getByText('Whole rupees, e.g. 450')).toBeTruthy();
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Price of size 1'), { target: { value: '520' } });
    fireEvent.click(create);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')).toMatchObject({
        url: '/api/staff/v1/menu/items',
        body: {
          categoryId: '1',
          name: 'Mocha',
          dietaryTags: ['Contains MILK', 'nut-free '],
          variants: [{ name: 'Regular', price: '520' }],
        },
      });
    });
  });

  it('shows a size out of stock and still offers the manual switch, never "Mark available"', async () => {
    const outOfStock = (): Menu => {
      const m = menuData(false);
      const v = m.categories[0]?.items[0]?.variants[0];
      if (v) Object.assign(v, { available: false, unavailableReason: 'out_of_stock' });
      return m;
    };
    serve(meWith('cashier', ['menu.read', 'menu.availability_toggle']), undefined, outOfStock);
    renderMenu();
    const row = await screen.findByRole('row', { name: /Latte/ });
    expect(within(row).getByText('Out of stock')).toBeTruthy();
    expect(within(row).getByRole('button', { name: /^Mark unavailable/ })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /^Mark available/ })).toBeNull();
  });
});
