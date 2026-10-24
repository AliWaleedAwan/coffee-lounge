/**
 * The shop's branding (UI_UX.md "Branding", DEC-14): its name in the header and its brand
 * colour on buttons. The server refuses a colour that fails AA contrast (AT-130), so any
 * colour that arrives here reads well. Kept on the device for the screens shown before
 * sign-in.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api/client.ts';

export interface Branding {
  shopName: string;
  primary: string;
}

const KEY = 'cl.branding';
const DEFAULT: Branding = { shopName: 'Coffee Lounge', primary: '#6B4435' };

export function savedBranding(): Branding {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as Partial<Branding>) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Puts the brand colour into the page's design tokens and remembers it. */
export function applyBranding(b: Branding): void {
  document.documentElement.style.setProperty('--brand-primary', b.primary);
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    // not remembered; the next sign-in applies it again
  }
}

/** Staff app: the branding, refreshed when the owner changes it. */
export function useBranding(): Branding {
  const query = useQuery({
    queryKey: ['branding'],
    queryFn: ({ signal }) => api<Branding>('/branding', { signal }),
    meta: { topics: ['menu'] },
    staleTime: 60_000,
  });
  const data = query.data;
  const branding =
    typeof data?.shopName === 'string' && typeof data.primary === 'string' ? data : savedBranding();
  useEffect(() => {
    applyBranding(branding);
  }, [branding]);
  return branding;
}
