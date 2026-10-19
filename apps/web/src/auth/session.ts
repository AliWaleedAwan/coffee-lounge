/**
 * The signed-in user (`GET /auth/me`) and the device's recent users for PIN switching.
 * Only usernames and display names are remembered on the device: never passwords or PINs.
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';

export interface Permission {
  key: string;
  scopes: 'all' | string[];
  sources: string[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  kind: 'waiter' | 'reception' | 'manager' | 'inventory' | 'kitchen';
  ownership: 'shop' | 'personal';
  status: 'active' | 'revoked';
}

export interface Me {
  user: { id: string; name: string; username: string };
  roles: string[];
  permissions: Permission[];
  discountLimitPercent: string | null;
  device: DeviceInfo;
  mustChangePassword: boolean;
}

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => api<Me>('/auth/me', { signal }),
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403].includes(error.status)) && count < 2,
    // Permissions can change while signed in (an owner edits a role): re-read regularly.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function permissionSet(me: Me): Set<string> {
  return new Set(me.permissions.map((p) => p.key));
}

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  waiter: 'Waiter',
  cashier: 'Cashier',
  inventory_clerk: 'Inventory clerk',
  kitchen: 'Kitchen',
};

export function roleLabel(me: Me): string {
  return me.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || 'No role';
}

/** After login or PIN switch: the new user replaces everything cached for the old one. */
export function startSession(client: QueryClient, me: Me): void {
  client.clear();
  client.setQueryData(ME_KEY, me);
  // Owners always log in with a password (D-24), so they are not offered for PIN switching.
  if (!me.roles.includes('owner')) rememberUser({ username: me.user.username, name: me.user.name });
}

// ---------------------------------------------------------------- recent users

export interface RecentUser {
  username: string;
  name: string;
}

const RECENT_KEY = 'cl.recentUsers';
const RECENT_LIMIT = 8;

export function recentUsers(
  storage: Pick<Storage, 'getItem'> | null = safeStorage(),
): RecentUser[] {
  try {
    const raw = storage?.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (u): u is RecentUser =>
          typeof u === 'object' &&
          u !== null &&
          typeof (u as RecentUser).username === 'string' &&
          typeof (u as RecentUser).name === 'string',
      )
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function rememberUser(
  user: RecentUser,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
): void {
  const next = [user, ...recentUsers(storage).filter((u) => u.username !== user.username)].slice(
    0,
    RECENT_LIMIT,
  );
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage full or blocked: PIN switch then asks for the username
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
