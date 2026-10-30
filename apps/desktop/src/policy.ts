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

/**
 * Downloads (P6-7, closes F-10): only the app's own report exports and the bill files
 * attached to expenses, from the server itself. Every address the download passed through
 * must be one of them; anything else is refused.
 */
const DOWNLOADS = [
  /^\/api\/staff\/v1\/reports\/[a-z-]+\/export$/,
  /^\/api\/staff\/v1\/expenses\/\d+\/attachment$/,
];
export function isAllowedDownload(urls: readonly string[], serverOrigin: string): boolean {
  if (urls.length === 0) return false;
  return urls.every((url) => {
    if (!isServerPage(url, serverOrigin)) return false;
    try {
      const { pathname } = new URL(url);
      return DOWNLOADS.some((pattern) => pattern.test(pathname));
    } catch {
      return false;
    }
  });
}

/**
 * A file name safe on Windows: no folders, no reserved characters or names, no leading
 * dots, at most 120 characters, keeping its extension.
 */
export function safeFileName(name: string): string {
  const base = Array.from(name.split(/[\\/]/).pop() ?? '', (ch) =>
    ch < ' ' || '<>:"|?*'.includes(ch) ? '_' : ch,
  )
    .join('')
    .replace(/^[.\s]+|[.\s]+$/g, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot).slice(0, 10) : '';
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem);
  const safeStem = (reserved ? `_${stem}` : stem).slice(0, 120 - ext.length) || 'download';
  return `${safeStem}${ext}`;
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
