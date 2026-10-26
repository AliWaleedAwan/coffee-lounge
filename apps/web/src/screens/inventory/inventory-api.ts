/**
 * Inventory data for the staff app (API.md §5.9). Queries refetch on the `inventory`
 * live topic; writes send `expectedVersion`, and every inventory query is refreshed after
 * a write, success or not, so a stale edit shows what is really there.
 */
import type { BaseUnit } from '@cl/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RequestOptions } from '../../api/client.ts';

export interface ItemSummary {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  baseUom: BaseUnit;
  trackLots: boolean;
  trackExpiry: boolean;
  lowThreshold: string | null;
  overstockThreshold: string | null;
  nearExpiryDays: number | null;
  stockControlActive: boolean;
  archived: boolean;
  version: number;
  onHand: string;
  reserved: string;
  packCount: number;
  barcodeCount: number;
}

export interface PackSize {
  id: string;
  name: string;
  qtyBase: string;
  isActive: boolean;
  version: number;
}

export interface Barcode {
  id: string;
  code: string;
  packSizeId: string | null;
  packName: string | null;
  version: number;
}

export type ItemDetail = ItemSummary & { packs: PackSize[]; barcodes: Barcode[] };

export interface ScanResult {
  code: string;
  match: {
    itemId: string;
    sku: string;
    name: string;
    baseUom: BaseUnit;
    pack: { id: string; name: string; qtyBase: string } | null;
  } | null;
}

const TOPICS = { topics: ['inventory'] } as const;

export interface ItemFilter {
  q: string;
  category: string;
  includeArchived: boolean;
}

export function useItems(filter: ItemFilter) {
  const params = new URLSearchParams();
  if (filter.q.trim()) params.set('q', filter.q.trim());
  if (filter.category) params.set('category', filter.category);
  if (filter.includeArchived) params.set('includeArchived', 'true');
  const query = params.toString();
  return useQuery({
    queryKey: ['inventory', 'items', query],
    queryFn: ({ signal }) =>
      api<{ items: ItemSummary[]; categories: string[] }>(
        `/inventory/items${query ? `?${query}` : ''}`,
        { signal },
      ),
    meta: TOPICS,
    placeholderData: (previous) => previous,
  });
}

export function useItem(id: string | null) {
  return useQuery({
    queryKey: ['inventory', 'item', id],
    queryFn: ({ signal }) => api<ItemDetail>(`/inventory/items/${id ?? ''}`, { signal }),
    meta: TOPICS,
    enabled: id !== null,
  });
}

/** What a scanned or typed code names; null for an unknown code. */
export function scanCode(code: string): Promise<ScanResult> {
  return api<ScanResult>(`/inventory/scan?code=${encodeURIComponent(code)}`);
}

export interface InventoryWrite {
  path: string;
  method?: RequestOptions['method'];
  body?: unknown;
}

export function useInventoryWrite<T = unknown>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (write: InventoryWrite) =>
      api<T>(write.path, { method: write.method ?? 'POST', body: write.body ?? {} }),
    onSuccess: (result) => {
      onDone?.(result);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/**
 * A quantity in its base unit as people read it (RECIPE_INVENTORY.md §1): g and ml as
 * whole numbers unless below 10, pieces as they are; thousands separated.
 */
export function formatQty(value: string, uom: BaseUnit): string {
  const n = Number(value);
  const places = uom !== 'pcs' && Math.abs(n) >= 10 ? 0 : 4;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: places })} ${uom}`;
}

/**
 * Whether what was entered in the search box reads as a barcode rather than a name: what
 * a scanner types (P4-4), at least six characters with no spaces, and at least one digit.
 */
export function looksLikeBarcode(text: string): boolean {
  return /^[!-~]{6,64}$/.test(text) && /\d/.test(text);
}
