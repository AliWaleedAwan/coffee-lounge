/**
 * The backup key pair (BACKUP_RECOVERY.md §1; P7-1). Backups are encrypted to the public key
 * kept on the server, in the age format (X25519, readable by any age tool). The private key
 * is made once by the installer and written only to the owner's USB key (and printed); it is
 * never kept on the server, so nothing here can open a backup without it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';

export const PRIVATE_KEY_FILE = 'coffee-lounge-backup-key.txt';

/**
 * Makes the pair: the private key to `privateDir` (the owner's USB key), the public one to
 * `publicFile`. If the USB key already holds the shop's key (a replacement PC), it is kept.
 */
export async function makeBackupKeys(privateDir: string, publicFile: string): Promise<string> {
  if (existsSync(publicFile))
    throw new Error(`${publicFile} exists: the shop already has a backup key`);
  // A replacement PC (restore): the owner's existing key is kept, so old backups still open.
  const existing = join(privateDir, PRIVATE_KEY_FILE);
  if (existsSync(existing)) {
    const line = readFileSync(existing, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('AGE-SECRET-KEY-'));
    if (!line) throw new Error(`${existing} is not a Coffee Lounge backup key`);
    const kept = await identityToRecipient(line.trim());
    writeFileSync(publicFile, `${kept}\n`, { flag: 'wx' });
    return kept;
  }
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(
    join(privateDir, PRIVATE_KEY_FILE),
    [
      '# Coffee Lounge backup key. Keep this file and a printed copy safe and away from the shop PC.',
      '# Without it no backup can be opened. Open a backup with:  age -d -i this-file backup.age',
      `# public key: ${recipient}`,
      identity,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  writeFileSync(publicFile, `${recipient}\n`, { flag: 'wx' });
  return recipient;
}

export function readRecipient(publicFile: string): string {
  const key = readFileSync(publicFile, 'utf8').trim();
  if (!/^age1[0-9a-z]{58}$/.test(key))
    throw new Error(`${publicFile} does not hold an age public key`);
  return key;
}

export async function encrypt(recipient: string, data: Uint8Array): Promise<Uint8Array> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(data);
}

/** For restores and tests: the identity line from the owner's key file. */
export async function decrypt(keyFileText: string, data: Uint8Array): Promise<Uint8Array> {
  const identity = keyFileText.split('\n').find((l) => l.startsWith('AGE-SECRET-KEY-'));
  if (!identity) throw new Error('not a Coffee Lounge backup key file');
  const d = new Decrypter();
  d.addIdentity(identity.trim());
  return d.decrypt(data);
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
