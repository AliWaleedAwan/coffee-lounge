/**
 * Serves the built web app (apps/web/dist) on a listener, same origin as its API (API.md
 * §1), so cookies stay first-party and the CSP can be 'self' only. The staff listener's
 * shell is index.html; the customer listener's is guest.html (the guest app, P3-2).
 * Client-side routes (/login, /t/<token>, …) fall back to the shell; hashed assets are
 * cached for a year, everything else is never cached (a new version must load at once).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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

/** Whether a built app exists at `root` (it is optional in development). */
export function webAppAvailable(root: string, shell = 'index.html'): boolean {
  return existsSync(join(root, shell));
}

function isAppRoute(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return !path.startsWith('/api/') && !path.startsWith('/health/') && !path.includes('.');
}

/** Registers on the listener root so the not-found fallback can use `reply.sendFile`. */
export function registerWebApp(app: FastifyInstance, root: string, shell = 'index.html'): void {
  void app.register(fastifyStatic, {
    root,
    index: false,
    wildcard: true,
    serveDotFiles: false,
    cacheControl: false,
    etag: true,
    setHeaders: (res, filePath) => {
      void res.header(
        'cache-control',
        /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-store',
      );
    },
  });

  // The root is a directory to the static plugin; it is the app shell to the browser.
  app.get('/', (_request, reply) => reply.header('cache-control', 'no-store').sendFile(shell));

  app.addHook('onSend', async (_request, reply) => {
    const type = reply.getHeader('content-type');
    if (typeof type === 'string' && type.startsWith('text/html')) {
      void reply.header('content-security-policy', WEB_CSP);
      void reply.header('x-frame-options', 'DENY');
    }
  });
}

/** Not-found fallback: client-side routes get the app shell. */
export function appShellFallback(shell = 'index.html') {
  return (request: FastifyRequest, reply: FastifyReply): FastifyReply | undefined => {
    if ((request.method === 'GET' || request.method === 'HEAD') && isAppRoute(request.url)) {
      return reply.header('cache-control', 'no-store').sendFile(shell);
    }
    return undefined;
  };
}
