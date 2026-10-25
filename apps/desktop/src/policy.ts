/**
 * Navigation, network and content rules for the counter app (02-architecture §2.11,
 * SECURITY.md §2.7). Pure functions, so they can be tested without Electron.
 */

/** Same policy the server sends with the web app (apps/server web-app.ts). */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Pages may only ever show the shop server's own pages. */
export function isServerPage(url: string, serverOrigin: string): boolean {
  return originOf(url) === serverOrigin;
}

/**
 * Network requests: the server origin, the app's own local pages (`file:` inside the
 * packaged static folder) and inline images. Everything else is cancelled before it
 * leaves the PC.
 */
export function isAllowedRequest(url: string, serverOrigin: string, staticDirUrl: string): boolean {
  if (isServerPage(url, serverOrigin)) return true;
  if (url.startsWith('data:image/')) return true;
  if (url.startsWith('devtools://')) return true;
  if (url.startsWith('file://')) {
    try {
      const path = new URL(url).pathname;
      return path.startsWith(new URL(staticDirUrl).pathname) && !path.includes('..');
    } catch {
      return false;
    }
  }
  return false;
}

/** Adds the CSP to a server document response that arrived without one. */
export function withCsp(headers: Record<string, string[]>): {
  headers: Record<string, string[]>;
  added: boolean;
} {
  const has = Object.keys(headers).some((h) => h.toLowerCase() === 'content-security-policy');
  if (has) return { headers, added: false };
  return { headers: { ...headers, 'Content-Security-Policy': [WEB_CSP] }, added: true };
}

export type FailureKind = 'unreachable' | 'certificate' | 'other';

/**
 * Chromium net error codes (net/base/net_error_list.h) for a page that failed to load.
 * `null` means "not a failure to show" (e.g. -3 ABORTED when we navigate away ourselves).
 */
export function classifyLoadFailure(code: number): FailureKind | null {
  if (code === -3) return null;
  if (code <= -200 && code > -300) return 'certificate';
  if (code <= -100 && code > -200) return 'unreachable'; // connection errors
  if (code === -7 || code === -21) return 'unreachable'; // timed out, network changed
  return 'other';
}
