/**
 * Secrets stored in the database, sealed with a key that is not in it (P6-4; SECURITY.md §2):
 * AES-256-GCM with a 32-byte key in MAIL_KEY_FILE, a file in the ACL-protected config
 * folder (the installer creates it; development makes one in .local). The database and
 * its backups hold only `v1:<iv>.<tag>.<ciphertext>`; without the key file they are useless.
 * Each secret is bound to its purpose, so one sealed value cannot be swapped for another.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const KEY_BYTES = 32;

export class SecretKeyError extends Error {
  override name = 'SecretKeyError';
}

/** The key in `file` (base64), made with owner-only rights when there is none yet. */
export function loadSecretKey(file: string): Buffer {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${randomBytes(KEY_BYTES).toString('base64')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== KEY_BYTES) throw new SecretKeyError(`${file} does not hold a 32-byte key`);
  return key;
}

export function seal(key: Buffer, purpose: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}.${tag.toString('base64')}.${body.toString('base64')}`;
}

export function unseal(key: Buffer, purpose: string, sealed: string): string {
  const match = /^v1:([^.]+)\.([^.]+)\.([^.]*)$/.exec(sealed);
  if (!match) throw new SecretKeyError('not a sealed value');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1] ?? '', 'base64'));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(match[2] ?? '', 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(match[3] ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SecretKeyError('the sealed value does not open with this key');
  }
}
