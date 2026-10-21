/** Bills, payments and the till shift for the counter (API.md §5.5). */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';

export interface OpenBill {
  sessionId: string;
  sessionNo: string;
  sessionStatus: string;
  orderType: string;
  tableName: string | null;
  invoiceId: string;
  invoiceStatus: 'open' | 'locked' | 'settled';
  lockVersion: number;
  total: string;
  due: string;
  items: number;
  pendingRounds: number;
  billRequested: boolean;
}

export interface BillLine {
  orderLineId: string;
  description: string;
  billableQty: number;
  unitPrice: string;
  modifiersUnitTotal: string;
  gross: string;
  promotionDiscount: string;
  manualDiscount: string;
  discountAlloc: string;
  net: string;
  isComp: boolean;
  modifiers: string[];
}

export interface Bill {
  invoice: {
    id: string;
    status: 'open' | 'locked' | 'settled';
    lockVersion: number;
    invoiceNo: string | null;
    businessDate: string | null;
    settledAt: string | null;
    subtotal: string;
    discountTotal: string;
    taxTotal: string;
    roundingAdjustment: string;
    total: string;
    paidTotal: string;
    due: string;
  };
  session: {
    id: string;
    sessionNo: string;
    status: string;
    orderType: string;
    tableId: string | null;
    tableName: string | null;
  };
  lines: BillLine[];
  discounts: {
    id: string;
    orderLineId: string | null;
    kind: 'percent' | 'fixed' | 'comp';
    value: string;
    amount: string;
    reason: string;
    appliedBy: string;
    approvedBy: string | null;
  }[];
  payments: {
    id: string;
    method: 'cash' | 'card_manual' | 'transfer';
    provider: string | null;
    amount: string;
    tendered: string | null;
    change: string | null;
    reference: string | null;
    receivedBy: string;
  }[];
  pendingRounds: number;
  unpickedUnits: number;
}

export interface PaymentResult {
  paymentId: string;
  paidTotal: string;
  due: string;
  change: string | null;
  settled: boolean;
  invoiceNo: string | null;
  receiptQueued: boolean;
}

export interface Shift {
  id: string;
  till: string;
  cashier: string;
  openedAt: string;
  openingFloat: string;
  cashSales: string;
  cashPayments: number;
}

export const billKey = (sessionId: string) => ['bill', sessionId] as const;

export function useOpenBills() {
  return useQuery({
    queryKey: ['bills'],
    queryFn: ({ signal }) => api<{ items: OpenBill[] }>('/bills', { signal }),
    meta: { topics: ['cashier', 'floor'] },
  });
}

export function useBill(sessionId: string | null) {
  return useQuery({
    queryKey: billKey(sessionId ?? ''),
    queryFn: ({ signal }) => api<Bill>(`/sessions/${sessionId ?? ''}/bill`, { signal }),
    enabled: sessionId !== null,
    meta: { topics: sessionId ? [`session:${sessionId}`, 'cashier'] : [] },
  });
}

export function useShift(enabled: boolean) {
  return useQuery({
    queryKey: ['shift'],
    queryFn: ({ signal }) => api<{ shift: Shift | null }>('/cash-shifts/current', { signal }),
    meta: { topics: ['cashier'] },
    enabled,
  });
}
