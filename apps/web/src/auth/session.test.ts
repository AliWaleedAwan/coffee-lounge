import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ME_KEY, recentUsers, rememberUser, startSession, type Me } from './session.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
}

const me = (username: string, roles: string[]): Me => ({
  user: { id: '1', name: username.toUpperCase(), username },
  roles,
  permissions: [],
  discountLimitPercent: null,
  device: { id: '9', name: 'Tablet', kind: 'waiter', ownership: 'shop', status: 'active' },
  mustChangePassword: false,
});

describe('recent users on this device', () => {
  it('keeps the most recent first, without duplicates, at most 8', () => {
    const storage = memoryStorage();
    for (let i = 1; i <= 10; i++)
      rememberUser({ username: `u${String(i)}`, name: `U${String(i)}` }, storage);
    rememberUser({ username: 'u5', name: 'U5' }, storage);
    const users = recentUsers(storage).map((u) => u.username);
    expect(users).toEqual(['u5', 'u10', 'u9', 'u8', 'u7', 'u6', 'u4', 'u3']);
  });

  it('stores names only, and survives corrupt or blocked storage', () => {
    const storage = memoryStorage({ 'cl.recentUsers': '{not json' });
    expect(recentUsers(storage)).toEqual([]);
    rememberUser({ username: 'sara', name: 'Sara' }, storage);
    expect(JSON.parse(storage.data.get('cl.recentUsers') ?? '')).toEqual([
      { username: 'sara', name: 'Sara' },
    ]);
    expect(recentUsers(memoryStorage({ 'cl.recentUsers': '[{"username":1},"x"]' }))).toEqual([]);
    expect(recentUsers(null)).toEqual([]);
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() => {
      rememberUser({ username: 'a', name: 'A' }, blocked);
    }).not.toThrow();
  });

  it('starts a session from a clean cache and offers only non-owners for PIN switching', () => {
    localStorage.clear();
    const client = new QueryClient();
    client.setQueryData(['devices'], { items: ['old user data'] });
    startSession(client, me('sara', ['waiter']));
    expect(client.getQueryData(['devices'])).toBeUndefined();
    expect(client.getQueryData(ME_KEY)).toMatchObject({ user: { username: 'sara' } });
    startSession(client, me('boss', ['owner']));
    expect(recentUsers().map((u) => u.username)).toEqual(['sara']);
  });
});
