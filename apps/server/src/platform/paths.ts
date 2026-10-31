/**
 * Where the server's own files are, whether it runs from source (src/…) or from the
 * installed bundle (dist/…): the nearest folder above this module with the server's
 * package.json. Migrations and the version live there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findServerRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown };
      if (name === '@cl/server') return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Cannot find the @cl/server package folder');
    dir = parent;
  }
}

export const SERVER_ROOT = findServerRoot();
export const MIGRATIONS_DIR = join(SERVER_ROOT, 'migrations');
/** The built staff web app in a development checkout (installed: WEB_DIST_DIR). */
export const DEV_WEB_DIST = join(SERVER_ROOT, '..', 'web', 'dist');
/** Attached files in a development checkout (installed: FILES_DIR). */
export const DEV_FILES_DIR = join(SERVER_ROOT, '..', '..', '.local', 'files');
/** The mailbox key in a development checkout (installed: MAIL_KEY_FILE). */
export const DEV_MAIL_KEY_FILE = join(SERVER_ROOT, '..', '..', '.local', 'mail.key');
