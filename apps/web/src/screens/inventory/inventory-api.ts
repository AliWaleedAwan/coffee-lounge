/**
 * Inventory data for the staff app (API.md §5.9). Queries refetch on the `inventory`
 * live topic; writes send `expectedVersion`, and every inventory query is refreshed after
 * a write, success or not, so a stale edit shows what is really there.
 */
import type { BaseUnit } from '@cl/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api, ApiError, type RequestOptions } from '../../api/client.ts';

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

export interface Lot {
  id: string;
  lotCode: string | null;
  receivedAt: string;
  expiryDate: string | null;
  qtyReceived: string;
  qtyRemaining: string;
  origin: 'receipt' | 'opening' | 'found' | 'count';
  status: 'active' | 'quarantined';
  receiptNo: string | null;
  expired: boolean;
  nearExpiry: boolean;
}

export type ItemDetail = ItemSummary & { packs: PackSize[]; barcodes: Barcode[]; lots: Lot[] };

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

// ---------------------------------------------------------------- receiving (step 4.2)

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  version: number;
}

export function useSuppliers(includeInactive = false) {
  return useQuery({
    queryKey: ['inventory', 'suppliers', includeInactive],
    queryFn: ({ signal }) =>
      api<{ items: Supplier[] }>(`/suppliers${includeInactive ? '?includeInactive=true' : ''}`, {
        signal,
      }),
    meta: TOPICS,
  });
}

export type PaymentChannel = 'cash' | 'card' | 'transfer';

export interface ReceiptSummary {
  id: string;
  receiptNo: string;
  status: 'posted' | 'reversed';
  businessDate: string;
  postedAt: string;
  supplierName: string | null;
  supplierInvoiceRef: string | null;
  /** Null for readers without cost rights. */
  totalCost: string | null;
  lineCount: number;
  paidNow: boolean;
  paymentChannel: PaymentChannel | null;
  postedBy: string;
}

export interface ReceiptLine {
  lineId: string;
  itemId: string;
  name: string;
  baseUom: BaseUnit;
  packName: string | null;
  packQty: string | null;
  qtyBase: string;
  lineCost: string | null;
  unitCost: string | null;
  lotCode: string | null;
  expiryDate: string | null;
  /** How much of the line went back to the supplier. */
  returnedQty: string;
}

export type ReceiptDetail = ReceiptSummary & {
  returns: SupplierReturn[];
  paymentReference: string | null;
  note: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  lines: ReceiptLine[];
};

export interface PostedReceipt {
  receiptId: string;
  receiptNo: string;
  totalCost: string;
  lines: (Omit<ReceiptLine, 'lotCode' | 'expiryDate' | 'returnedQty'> & { onHandAfter: string })[];
}

export function useReceipts() {
  return useQuery({
    queryKey: ['inventory', 'receipts'],
    queryFn: ({ signal }) => api<{ items: ReceiptSummary[] }>('/purchase-receipts', { signal }),
    meta: TOPICS,
  });
}

export function useReceipt(id: string | null) {
  return useQuery({
    queryKey: ['inventory', 'receipt', id],
    queryFn: ({ signal }) => api<ReceiptDetail>(`/purchase-receipts/${id ?? ''}`, { signal }),
    meta: TOPICS,
    enabled: id !== null,
  });
}

export function fetchItem(id: string): Promise<ItemDetail> {
  return api<ItemDetail>(`/inventory/items/${id}`);
}

/**
 * A command that moves stock ([I], API.md §3). The Idempotency-Key lives as long as the
 * intent: a retry after a lost connection resends the same key and body, so a receipt is
 * never posted twice; a different body is a different intent.
 */
export function useInventoryCommand<T>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  const intent = useRef<{ key: string; body: string } | null>(null);
  return useMutation({
    mutationFn: (c: { path: string; body?: unknown }) => {
      const body = JSON.stringify([c.path, c.body ?? {}]);
      if (intent.current?.body !== body) intent.current = { key: crypto.randomUUID(), body };
      return api<T>(c.path, {
        method: 'POST',
        body: c.body ?? {},
        idempotencyKey: intent.current.key,
      });
    },
    onSuccess: (result) => {
      intent.current = null;
      onDone?.(result);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status > 0) intent.current = null;
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** "1650.50" → "Rs 1,650.50"; whole rupees without paisa. */
export function rupees(amount: string): string {
  const n = Number(amount);
  return `Rs ${n.toLocaleString('en-US', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// ---------------------------------------------------------------- waste and returns (step 4.4)

/** RECIPE_INVENTORY.md §8 reason codes for ingredient waste. */
export const WASTE_REASONS = [
  { value: 'spilled', label: 'Spilled' },
  { value: 'expired', label: 'Expired' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'quality', label: 'Quality' },
  { value: 'remade', label: 'Remade' },
  { value: 'other', label: 'Other (say what)' },
] as const;

export interface WasteRecord {
  id: string;
  kind: 'ingredient' | 'expired_lot' | 'prepared_item' | 'failed_delivery';
  itemId: string | null;
  name: string;
  baseUom: BaseUnit | null;
  qty: string;
  reasonCode: string;
  note: string | null;
  lotCode: string | null;
  value: string | null;
  recordedBy: string;
  recordedAt: string;
}

export function useWaste() {
  return useQuery({
    queryKey: ['inventory', 'waste'],
    queryFn: ({ signal }) =>
      api<{ date: string; items: WasteRecord[] }>('/inventory/waste', { signal }),
    meta: TOPICS,
  });
}

export interface SupplierReturn {
  id: string;
  lineId: string;
  name: string;
  baseUom: BaseUnit;
  qtyBase: string;
  value: string | null;
  reason: string;
  refundAmount: string | null;
  refundChannel: PaymentChannel | null;
  refundReference: string | null;
  returnedBy: string;
  businessDate: string;
}
