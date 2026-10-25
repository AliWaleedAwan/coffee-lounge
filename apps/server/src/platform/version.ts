/** This server build's version (apps/server/package.json), shown on the health page. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_ROOT } from './paths.ts';

const manifest = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8')) as {
  version?: unknown;
};

export const SERVER_VERSION = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
