import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes, createQueryClient } from '../../app/App.tsx';
import { connection } from '../../connection/store.ts';
import { formatQty, looksLikeBarcode, type ItemDetail } from './inventory-api.ts';

describe('inventory helpers', () => {
  it('shows g and ml whole from 10 up, small amounts and pieces as they are', () => {
    expect(formatQty('6000.0000', 'ml')).toBe('6,000 ml');
    expect(formatQty('12.6000', 'g')).toBe('13 g');
    expect(formatQty('2.5000', 'g')).toBe('2.5 g');
    expect(formatQty('0.1250', 'ml')).toBe('0.125 ml');
    expect(formatQty('50.0000', 'pcs')).toBe('50 pcs');
    expect(formatQty('0.0000', 'pcs')).toBe('0 pcs');
  });

  it('reads scanner input as a barcode, and names as names (P4-4)', () => {
    expect(looksLikeBarcode('8960000000017')).toBe(true);
    expect(looksLikeBarcode('ABC-12345')).toBe(true);
    expect(looksLikeBarcode('milk')).toBe(false);
    expect(looksLikeBarcode('whole milk 1')).toBe(false);
    expect(looksLikeBarcode('12345')).toBe(false);
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
    user: { id: '1', name: 'Faisal', username: 'faisal' },
    roles: [role],
    permissions: keys.map((key) => ({ key, scopes: 'all', sources: [`role:${role}`] })),
    discountLimitPercent: null,
    device: { id: '1', name: 'Counter', kind: 'reception', ownership: 'shop', status: 'active' },
    mustChangePassword: false,
  };
}

const milk: ItemDetail = {
  id: '7',
  sku: 'MILK-WHOLE',
  name: 'Whole milk',
  category: 'Dairy',
  baseUom: 'ml',
  trackLots: true,
  trackExpiry: true,
  lowThreshold: '5000.0000',
  overstockThreshold: null,
  nearExpiryDays: 2,
  stockControlActive: true,
  archived: false,
  version: 3,
  onHand: '2400.0000',
  reserved: '300.0000',
  packCount: 1,
  barcodeCount: 1,
  packs: [{ id: '70', name: '1 L carton', qtyBase: '1000.0000', isActive: true, version: 1 }],
  barcodes: [
    { id: '700', code: '8960000000017', packSizeId: '70', packName: '1 L carton', version: 1 },
  ],
};
const cups = {
  ...milk,
  id: '8',
  sku: 'CUP-12',
  name: 'Cup 12 oz',
  category: 'Packaging',
  baseUom: 'pcs' as const,
  trackLots: false,
  trackExpiry: false,
  stockControlActive: false,
  packs: [],
  barcodes: [],
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function serve(me: object, writes: (call: Call) => Response = () => json(201, { id: '1' })) {
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
      if (url.includes('/inventory/scan?code=8960000000017')) {
        return Promise.resolve(
          json(200, {
            code: '8960000000017',
            match: {
              itemId: '7',
              sku: 'MILK-WHOLE',
              name: 'Whole milk',
              baseUom: 'ml',
              pack: { id: '70', name: '1 L carton', qtyBase: '1000.0000' },
            },
          }),
        );
      }
      if (url.includes('/inventory/scan?code=')) {
        const code = decodeURIComponent(url.split('code=')[1] ?? '');
        return Promise.resolve(json(200, { code, match: null }));
      }
      if (url.includes('/suppliers')) {
        return Promise.resolve(json(200, { items: [{ id: '3', name: 'Haleeb Foods' }] }));
      }
      if (url.endsWith('/inventory/items/7')) return Promise.resolve(json(200, milk));
      if (url.endsWith('/inventory/items/8')) return Promise.resolve(json(200, cups));
      if (url.includes('/inventory/items')) {
        return Promise.resolve(
          json(200, { items: [milk, cups], categories: ['Dairy', 'Packaging'] }),
        );
      }
      return Promise.resolve(json(404, { code: 'NOT_FOUND', detail: 'x' }));
    }),
  );
  return calls;
}

function renderInventory() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/inventory']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CLERK = ['inventory.read', 'inventory.items_manage'];

async function scan(code: string) {
  const box = await screen.findByLabelText('Scan or type barcode / name');
  fireEvent.change(box, { target: { value: code } });
  fireEvent.submit(box.closest('form') as HTMLFormElement);
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

describe('inventory screen', () => {
  it('lists items with stock and tracking; a scan opens the exact item (AT-14)', async () => {
    serve(meWith('inventory_clerk', CLERK));
    renderInventory();
    const row = await screen.findByRole('row', { name: /Whole milk/ });
    expect(within(row).getByText('2,400 ml')).toBeTruthy();
    expect(within(row).getByText('Lots')).toBeTruthy();
    expect(
      within(screen.getByRole('row', { name: /Cup 12 oz/ })).getByText('Not counted yet'),
    ).toBeTruthy();

    await scan('8960000000017');
    expect(await screen.findByRole('heading', { name: 'Whole milk' })).toBeTruthy();
    const packs = screen.getByRole('region', { name: 'Pack sizes' });
    expect(within(packs).getByRole('row', { name: /1 L carton 1,000 ml/ })).toBeTruthy();
    // Units offered are the item's own dimension only (AT-32).
    const unit = within(packs).getByLabelText('Unit');
    expect([...(unit as HTMLSelectElement).options].map((o) => o.value)).toEqual(['ml', 'l']);
    fireEvent.change(within(packs).getByLabelText('Holds'), { target: { value: '0.5' } });
    expect(within(packs).getByText('= 500 ml')).toBeTruthy();
  });

  it('offers to link an unknown code, and shows who owns a duplicate (AT-14)', async () => {
    const calls = serve(meWith('inventory_clerk', CLERK), (call) =>
      call.url.endsWith('/barcodes')
        ? json(409, {
            code: 'BARCODE_IN_USE',
            title: 'This barcode already belongs to another item',
            detail: 'Barcode 4006381333931 already belongs to Whole milk (MILK-WHOLE), 1 L carton',
          })
        : json(200, {}),
    );
    renderInventory();
    await scan('4006381333931');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Barcode 4006381333931 isn’t linked to any item yet/,
    );
    fireEvent.click(screen.getByRole('button', { name: /Link here\s*Cup 12 oz/ }));
    expect(await screen.findByRole('heading', { name: 'Cup 12 oz' })).toBeTruthy();
    const barcodes = screen.getByRole('region', { name: 'Barcodes' });
    const field = within(barcodes).getByLabelText<HTMLInputElement>('Scan or type a barcode');
    expect(field.value).toBe('4006381333931');
    fireEvent.click(within(barcodes).getByRole('button', { name: 'Link barcode' }));
    expect((await within(barcodes).findByRole('alert')).textContent).toBe(
      'Barcode 4006381333931 already belongs to Whole milk (MILK-WHOLE), 1 L carton',
    );
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/staff/v1/inventory/items/8/barcodes',
      body: { code: '4006381333931' },
    });
  });

  it('a typed SKU opens its item; a name only filters', async () => {
    const calls = serve(meWith('inventory_clerk', CLERK));
    renderInventory();
    await scan('cup-12');
    expect(await screen.findByRole('heading', { name: 'Cup 12 oz' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to inventory' }));
    await scan('milk');
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/inventory/items?q=milk'))).toBe(true);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives a manager the items to read, with nothing to change', async () => {
    serve(meWith('manager', ['inventory.read']));
    renderInventory();
    await screen.findByRole('row', { name: /Whole milk/ });
    expect(screen.queryByRole('button', { name: 'New item' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Open\s*Whole milk/ }));
    expect(await screen.findByRole('heading', { name: 'Whole milk' })).toBeTruthy();
    expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add pack' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Link barcode' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive/ })).toBeNull();
    expect(screen.getByText('300 ml')).toBeTruthy(); // reserved
  });

  it('creates an item and sends its settings', async () => {
    const calls = serve(meWith('inventory_clerk', CLERK), () => json(201, { id: '8' }));
    renderInventory();
    fireEvent.click(await screen.findByRole('button', { name: 'New item' }));
    fireEvent.change(screen.getByLabelText('SKU'), { target: { value: 'cup-12' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Cup 12 oz' } });
    fireEvent.change(screen.getByLabelText('Base unit'), { target: { value: 'pcs' } });
    fireEvent.change(screen.getByLabelText('Low stock at (pcs)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Overstock at (pcs)'), { target: { value: '50' } });
    expect(screen.getByText('Above the low level, e.g. 20000')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add item' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Overstock at (pcs)'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('heading', { name: 'Cup 12 oz' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      sku: 'cup-12',
      name: 'Cup 12 oz',
      category: null,
      baseUom: 'pcs',
      trackLots: false,
      trackExpiry: false,
      lowThreshold: '100',
      overstockThreshold: '2000',
      nearExpiryDays: null,
    });
  });
});

describe('receive stock', () => {
  const RECEIVER = [...CLERK, 'inventory.receive', 'inventory.stock_control_activate'];

  it('turns scans into lines with base quantities, unit cost and expiry, then posts (AT-31)', async () => {
    const posted = {
      receiptId: '9',
      receiptNo: 'GRN-2026-00042',
      totalCost: '550.00',
      lines: [
        {
          lineId: '90',
          itemId: '7',
          name: 'Whole milk',
          baseUom: 'ml',
          packName: '1 L carton',
          packQty: '2.000',
          qtyBase: '2000.0000',
          lineCost: '550.00',
          unitCost: '0.27500000',
          onHandAfter: '4400.0000',
        },
      ],
    };
    const calls = serve(meWith('inventory_clerk', RECEIVER), () => json(201, posted));
    renderInventory();
    fireEvent.click(await screen.findByRole('tab', { name: 'Receive stock' }));
    await scan('8960000000017');
    const line = await screen.findByRole('group', { name: 'Line: Whole milk' });
    await scan('8960000000017');
    await waitFor(() => {
      expect(within(line).getByText('2 × 1 L carton = 2,000 ml')).toBeTruthy();
    });
    expect(screen.getAllByRole('group', { name: /^Line:/ })).toHaveLength(1);
    fireEvent.change(within(line).getByLabelText('Line cost for Whole milk (Rs)'), {
      target: { value: '550' },
    });
    expect(within(line).getByText('Unit cost: Rs 0.2750 / ml')).toBeTruthy();
    const post = screen.getByRole<HTMLButtonElement>('button', { name: 'Post receipt' });
    expect(post.disabled).toBe(true); // expiry still missing
    fireEvent.change(within(line).getByLabelText('Expiry date for Whole milk'), {
      target: { value: '2099-11-02' },
    });
    fireEvent.change(within(line).getByLabelText('Lot for Whole milk (optional)'), {
      target: { value: 'L7' },
    });
    fireEvent.change(screen.getByLabelText('Supplier (optional)'), { target: { value: '3' } });
    expect(screen.getByText('Receipt total: Rs 550')).toBeTruthy();
    fireEvent.click(post);
    expect(await screen.findByRole('heading', { name: 'Posted · GRN-2026-00042' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /Whole milk 2,000 ml 4,400 ml/ })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/staff/v1/purchase-receipts',
      body: {
        supplierId: '3',
        paidNow: false,
        startStockControl: [],
        lines: [
          {
            itemId: '7',
            packSizeId: '70',
            packQty: '2',
            lineCost: '550',
            lotCode: 'L7',
            expiryDate: '2099-11-02',
          },
        ],
      },
    });
  });

  it('asks to confirm an empty shelf before receiving an item not yet counted (D-29)', async () => {
    const calls = serve(meWith('inventory_clerk', RECEIVER), () =>
      json(201, { receiptId: '1', receiptNo: 'GRN-2026-00043', totalCost: '7000.00', lines: [] }),
    );
    renderInventory();
    fireEvent.click(await screen.findByRole('tab', { name: 'Receive stock' }));
    await scan('cup');
    fireEvent.click(await screen.findByRole('button', { name: /Add Cup 12 oz/ }));
    const line = await screen.findByRole('group', { name: 'Line: Cup 12 oz' });
    fireEvent.change(within(line).getByLabelText('Quantity of Cup 12 oz'), {
      target: { value: '200' },
    });
    fireEvent.change(within(line).getByLabelText('Line cost for Cup 12 oz (Rs)'), {
      target: { value: '7000' },
    });
    expect(within(line).getByText('Not counted yet: confirm the shelf was empty')).toBeTruthy();
    const post = screen.getByRole<HTMLButtonElement>('button', { name: 'Post receipt' });
    expect(post.disabled).toBe(true);
    fireEvent.click(
      within(line).getByLabelText(
        'The shelf had no Cup 12 oz: start counting it from this receipt',
      ),
    );
    fireEvent.click(post);
    await waitFor(() => {
      expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
        startStockControl: ['8'],
        lines: [{ itemId: '8', qty: '200', uom: 'pcs', lineCost: '7000' }],
      });
    });
  });

  it('offers no Receive stock tab without inventory.receive', async () => {
    serve(meWith('manager', ['inventory.read']));
    renderInventory();
    await screen.findByRole('row', { name: /Whole milk/ });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Items',
      'Receipts',
      'Suppliers',
    ]);
  });
});
