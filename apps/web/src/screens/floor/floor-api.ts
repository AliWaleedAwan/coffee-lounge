/** Floor data for the staff app (API.md §5.3). Refetches on the `floor` live topic. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type RequestOptions } from '../../api/client.ts';

export type TableState =
  'available' | 'occupied' | 'checkout_requested' | 'checkout_locked' | 'blocked' | 'maintenance';

export interface FloorTable {
  id: string;
  code: string;
  name: string;
  area: string | null;
  seats: number | null;
  availability: 'active' | 'blocked' | 'maintenance';
  state: TableState;
  waiter: { id: string; name: string } | null;
  session: {
    id: string;
    sessionNo: string;
    status: string;
    guestCount: number | null;
    openedAt: string;
    guestPhones: number;
    stale: boolean;
  } | null;
}

export interface ManagedTable {
  id: string;
  code: string;
  name: string;
  area: string | null;
  seats: number | null;
  availability: 'active' | 'blocked' | 'maintenance';
  sort: number;
  version: number;
  qrPrintedAt: string | null;
}

export interface PrintedCode {
  entryPointId: string;
  kind: 'table' | 'counter_takeaway';
  label: string;
  tableCode: string | null;
  url: string | null;
}

export const FLOOR_KEY = ['floor'] as const;
export const TABLES_KEY = ['floor', 'tables'] as const;
const TOPICS = { topics: ['floor'] } as const;

export function useFloor() {
  return useQuery({
    queryKey: FLOOR_KEY,
    queryFn: ({ signal }) => api<{ tables: FloorTable[] }>('/floor', { signal }),
    meta: TOPICS,
  });
}

export function useManagedTables() {
  return useQuery({
    queryKey: TABLES_KEY,
    queryFn: ({ signal }) => api<{ items: ManagedTable[] }>('/tables', { signal }),
    meta: TOPICS,
  });
}

export function useWaiters(enabled: boolean) {
  return useQuery({
    queryKey: ['floor', 'waiters'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; name: string }[] }>('/assignable-staff', { signal }),
    enabled,
  });
}

export interface FloorWrite {
  path: string;
  method?: RequestOptions['method'];
  body?: unknown;
  /** Commands marked [I]: a fresh key per user intent. */
  idempotent?: boolean;
}

/** One write on the floor; the floor and table queries refresh afterwards. */
export function useFloorWrite<T = unknown>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (write: FloorWrite) =>
      api<T>(write.path, {
        method: write.method ?? 'POST',
        body: write.body ?? {},
        ...(write.idempotent ? { idempotencyKey: crypto.randomUUID() } : {}),
      }),
    onSuccess: (result) => {
      onDone?.(result);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['floor'] }),
  });
}

export function floorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'TABLE_OCCUPIED') return `${error.message}. Choose a free table.`;
    if (error.code === 'STALE_STATE')
      return 'Someone else changed this first. The floor now shows the latest state.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export const STATE_LABEL: Record<TableState, { text: string; chip: string }> = {
  available: { text: 'Available', chip: 'chip chip-ok' },
  occupied: { text: 'Occupied', chip: 'chip chip-info' },
  checkout_requested: { text: 'Bill requested', chip: 'chip chip-warning' },
  checkout_locked: { text: 'Bill being prepared', chip: 'chip chip-warning' },
  blocked: { text: 'Blocked', chip: 'chip chip-danger' },
  maintenance: { text: 'Maintenance', chip: 'chip chip-danger' },
};

/** "45 min", "2 h 05 min". */
export function sinceText(openedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(openedAt).getTime()) / 60_000));
  if (minutes < 60) return `${String(minutes)} min`;
  return `${String(Math.floor(minutes / 60))} h ${String(minutes % 60).padStart(2, '0')} min`;
}
