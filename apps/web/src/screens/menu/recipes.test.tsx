import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes, createQueryClient } from '../../app/App.tsx';
import { connection } from '../../connection/store.ts';
import { wastePercent } from './recipe-api.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

function meWith(role: string, keys: string[]) {
  return {
    user: { id: '1', name: 'Faisal', username: 'faisal' },
    roles: [role],
    permissions: keys.map((key) => ({ key, scopes: 'all', sources: [`role:${role}`] })),
    discountLimitPercent: null,
    device: { id: '1', name: 'Counter', kind: 'reception', ownership: 'shop', status: 'active' },
    mustChangePassword: false,
  };
}

const overview = {
  items: [
    {
      menuItemId: '21',
      name: 'Latte',
      category: 'Coffee',
      variants: [
        { id: '31', name: 'Regular', stockMode: 'untracked', activeVersion: null, draftVersion: 1 },
      ],
    },
  ],
};
const variant = {
  variantId: '31',
  variantName: 'Regular',
  menuItemId: '21',
  menuItemName: 'Latte',
  stockMode: 'untracked',
  versions: [
    {
      id: '501',
      versionNo: 1,
      status: 'draft',
      prepInstructions: null,
      activatedAt: null,
      activatedBy: null,
      retiredAt: null,
      version: 2,
      components: [
        {
          itemId: '7',
          name: 'Whole milk',
          baseUom: 'ml',
          qtyBase: '150.0000',
          wasteFactor: '0.0500',
          forDineIn: true,
          forTakeaway: true,
          forDelivery: true,
          stockControlActive: false,
        },
      ],
    },
  ],
  rules: [],
  options: [],
};
const items = {
  items: [
    { id: '7', sku: 'MILK', name: 'Whole milk', baseUom: 'ml', stockControlActive: false },
    { id: '8', sku: 'BEANS', name: 'Beans', baseUom: 'g', stockControlActive: true },
  ],
  categories: [],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(me: object, writes: (call: Call) => Response = () => json(200, {})) {
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
      if (url.endsWith('/recipes')) return Promise.resolve(json(200, overview));
      if (url.endsWith('/recipes/variants/31')) return Promise.resolve(json(200, variant));
      if (url.includes('/inventory/items')) return Promise.resolve(json(200, items));
      if (url.endsWith('/menu') || url.endsWith('/menu/catalog')) {
        return Promise.resolve(json(200, { categories: [], modifierGroups: [] }));
      }
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
  return calls;
}

async function openRecipe() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/menu']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('tab', { name: 'Recipes' }));
  expect(await screen.findByText('0 of 1 sizes track stock.', { exact: false })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Open\s*Latte Regular/ }));
  await screen.findByRole('heading', { name: 'Latte · Regular' });
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

describe('recipe helpers', () => {
  it('shows a waste factor as the percentage entered', () => {
    expect(wastePercent('0.0500')).toBe('5');
    expect(wastePercent('0.1250')).toBe('12.5');
    expect(wastePercent('0.0000')).toBe('0');
  });
});

describe('the recipe editor (step 4.8)', () => {
  const CLERK = ['menu.read', 'recipes.read', 'recipes.manage', 'inventory.read'];

  it('edits a draft in any unit and saves the whole list', async () => {
    const calls = serve(meWith('inventory_clerk', CLERK), () =>
      json(200, { id: '501', version: 3 }),
    );
    await openRecipe();
    const draft = screen.getByRole('region', { name: 'Draft · v1' });
    const milk = await within(draft).findByRole('group', { name: 'Ingredient Whole milk' });
    expect(within(milk).getByLabelText<HTMLInputElement>('Waste %').value).toBe('5');
    fireEvent.change(within(milk).getByLabelText('Quantity'), { target: { value: '0.2' } });
    fireEvent.change(within(milk).getByLabelText('Unit'), { target: { value: 'l' } });
    fireEvent.click(within(milk).getByLabelText('Dine-in'));
    expect(within(draft).getByText('Save the draft before activating it.')).toBeTruthy();
    fireEvent.click(within(draft).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
        url: '/api/staff/v1/recipes/versions/501',
        body: {
          expectedVersion: 2,
          prepInstructions: null,
          components: [
            {
              itemId: '7',
              qty: '0.2',
              uom: 'l',
              wastePercent: '5',
              forDineIn: false,
              forTakeaway: true,
              forDelivery: true,
            },
          ],
        },
      });
    });
  });

  it('says which ingredients must be counted before the draft can go live', async () => {
    const calls = serve(meWith('inventory_clerk', CLERK), () =>
      json(400, { code: 'VALIDATION_FAILED', detail: 'Count these ingredients first: Whole milk' }),
    );
    await openRecipe();
    const draft = screen.getByRole('region', { name: 'Draft · v1' });
    expect(within(draft).getByText('Count these first, then activate: Whole milk.')).toBeTruthy();
    fireEvent.click(within(draft).getByRole('button', { name: 'Activate v1' }));
    expect((await within(draft).findByRole('alert')).textContent).toBe(
      'Count these ingredients first: Whole milk',
    );
    expect(calls.find((c) => c.method === 'POST')?.url).toBe(
      '/api/staff/v1/recipes/versions/501/activate',
    );
    // Without an active recipe the size cannot track stock yet.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Track stock with this recipe' })
        .disabled,
    ).toBe(true);
  });

  it('shows recipes read-only without recipes.manage', async () => {
    serve(meWith('kitchen', ['menu.read', 'recipes.read']));
    await openRecipe();
    expect(screen.queryByRole('region', { name: 'Draft · v1' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Track stock with this recipe' })).toBeNull();
  });
});
