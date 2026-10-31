/**
 * WAL archiving (BACKUP_RECOVERY.md §1; step 7.1). PostgreSQL calls this for every finished
 * WAL segment (`archive_command`): the segment is compressed, encrypted to the backup public
 * key and written to the backup drive under a temporary name, flushed, then renamed, so a
 * half-written file never carries the final name. An existing file is never overwritten: the
 * same segment again (PostgreSQL retrying after a crash) is accepted if its checksum matches,
 * anything else fails. A failure (drive unplugged, full) makes PostgreSQL keep the segment
 * and try again, so the archive catches up when the drive is back (AT-80).
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { encrypt, readRecipient, sha256 } from './keys.ts';

export interface WalArchiveInput {
  /** The backup drive's root (`B:\`): if it is not there, nothing is written. */
  driveRoot: string;
  /** Where segments go (`B:\CoffeeLounge\wal`). */
  dir: string;
  publicKeyFile: string;
  /** `%p` and `%f` of archive_command. */
  sourcePath: string;
  name: string;
}

function writeDurably(path: string, data: Uint8Array | string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export type WalOutcome = 'archived' | 'already_archived';

export async function archiveWal(input: WalArchiveInput): Promise<WalOutcome> {
  if (!/^[0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?$|^[0-9A-F]{8}\.history$/.test(input.name))
    throw new Error(`not a WAL file name: ${input.name}`);
  if (!existsSync(input.driveRoot))
    throw new Error(`backup drive ${input.driveRoot} is not plugged in`);
  mkdirSync(input.dir, { recursive: true });
  const data = readFileSync(input.sourcePath);
  const sum = sha256(data);
  const target = join(input.dir, `${input.name}.gz.age`);
  const sumFile = join(input.dir, `${input.name}.sha256`);
  if (existsSync(target)) {
    const kept = existsSync(sumFile) ? readFileSync(sumFile, 'utf8').trim() : '';
    if (kept === sum) return 'already_archived';
    throw new Error(`${target} exists with different content; refusing to overwrite`);
  }
  // The checksum first: a crash before the rename leaves no final file, so the retry writes it.
  writeDurably(sumFile, `${sum}\n`);
  writeDurably(target, await encrypt(readRecipient(input.publicKeyFile), gzipSync(data)));
  return 'archived';
}
