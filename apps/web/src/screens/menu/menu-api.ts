/**
 * Menu data for the staff app (API.md §5.7). Queries refetch on the `menu` live topic;
 * writes send `expectedVersion`, and a STALE_STATE answer reloads the catalogue so the
 * next attempt starts from what is really there (CT-10).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type RequestOptions } from '../../api/client.ts';

export interface MenuOption {
  id: string;
  name: string;
  priceDelta: string;
  available?: boolean;
  sort?: number;
  isActive?: boolean;
  version?: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  isActive?: boolean;
  version?: number;
  options: MenuOption[];
}

export interface MenuVariant {
  id: string;
  name: string;
  price: string;
  promotionPrice: string | null;
  promotionId: string | null;
  isDefault: boolean;
  available: boolean;
  unavailableReason: 'marked_unavailable' | 'out_of_stock' | null;
  unavailableNote: string | null;
  sort?: number;
  isActive?: boolean;
  version?: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  /** Relative to the API base (`menu-photos/…`); null when the item has none. */
  imageUrl: string | null;
  dietaryTags: string[];
  allowDineIn: boolean;
  allowTakeaway: boolean;
  allowDelivery: boolean;
  categoryId?: string;
  sort?: number;
  isActive?: boolean;
  version?: number;
  variants: MenuVariant[];
  modifierGroups: ModifierGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  sort?: number;
  isActive?: boolean;
  version?: number;
  items: MenuItem[];
}

export interface Menu {
  categories: MenuCategory[];
  /** Management view only: every modifier group, linked or not. */
  modifierGroups?: ModifierGroup[];
}

export interface Promotion {
  id: string;
  name: string;
  kind: 'percent' | 'fixed';
  value: string;
  startsOn: string;
  endsOn: string | null;
  daysOfWeek: number[] | null;
  timeFrom: string | null;
  timeTo: string | null;
  isActive: boolean;
  version: number;
  itemIds: string[];
  categoryIds: string[];
}

const TOPICS = { topics: ['menu'] } as const;
export const CATALOG_KEY = ['menu', 'catalog'] as const;
export const STAFF_MENU_KEY = ['menu', 'staff'] as const;
export const PROMOTIONS_KEY = ['menu', 'promotions'] as const;

/** Management view (inactive rows too, with versions) or the orderable menu. */
export function useMenu(management: boolean) {
  return useQuery({
    queryKey: management ? CATALOG_KEY : STAFF_MENU_KEY,
    queryFn: ({ signal }) => api<Menu>(management ? '/menu/catalog' : '/menu', { signal }),
    meta: TOPICS,
  });
}

export function usePromotions(enabled: boolean) {
  return useQuery({
    queryKey: PROMOTIONS_KEY,
    queryFn: ({ signal }) => api<{ items: Promotion[] }>('/promotions', { signal }),
    meta: TOPICS,
    enabled,
  });
}

export interface MenuWrite {
  path: string;
  method?: RequestOptions['method'];
  body?: unknown;
}

/** One write to the menu; every menu query is refreshed afterwards, success or not. */
export function useMenuWrite<T = unknown>(onDone?: (result: T) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (write: MenuWrite) =>
      api<T>(write.path, { method: write.method ?? 'POST', body: write.body ?? {} }),
    onSuccess: (result) => {
      onDone?.(result);
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['menu'] }),
  });
}

/** Message for a failed menu write; a stale edit says what happened and what to do. */
export function writeMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'STALE_STATE') {
    return 'Someone else changed this first. The latest version is now shown: check it and try again.';
  }
  if (error instanceof ApiError && error.fields.length > 0) {
    return `${error.message}: ${error.fields.map((f) => `${f.path} ${f.message}`).join('; ')}`;
  }
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

/** "450.00" → "Rs 450"; paisa shown only when there are some. */
export function rupees(amount: string): string {
  const [whole = amount, paisa = '00'] = amount.split('.');
  return paisa === '00' ? `Rs ${whole}` : `Rs ${whole}.${paisa}`;
}

/**
 * Dietary tags, one per line, kept exactly as typed (MENU-008, AT-126): only lines that
 * are blank are dropped. Nothing is trimmed, re-cased or inferred.
 */
export function parseTags(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0);
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Plain-language schedule of a promotion, e.g. "Mon–Fri · 15:00–18:00 · from 2026-10-01". */
export function describeSchedule(p: Promotion): string {
  const days =
    p.daysOfWeek === null || p.daysOfWeek.length === 7
      ? 'Every day'
      : [...p.daysOfWeek]
          .sort((a, b) => a - b)
          .map((d) => WEEKDAYS[d - 1] ?? '?')
          .join(', ');
  const hours =
    p.timeFrom && p.timeTo ? `${p.timeFrom.slice(0, 5)}–${p.timeTo.slice(0, 5)}` : 'all day';
  const dates = p.endsOn ? `${p.startsOn} to ${p.endsOn}` : `from ${p.startsOn}`;
  return `${days} · ${hours} · ${dates}`;
}
