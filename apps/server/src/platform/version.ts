/** This server build's version (apps/server/package.json), shown on the health page. */
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version?: unknown };

export const SERVER_VERSION = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
