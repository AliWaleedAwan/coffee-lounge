/**
 * PostgreSQL's restore_command during a point-in-time restore (step 7.3): the archived WAL
 * segment `%f`, opened with the owner's key and unzipped, written to `%p`. A segment that is
 * not there exits 1, which tells PostgreSQL it has reached the end of the archive.
 *
 * `--live` is the PC's continuous local copy (LIVE_WAL_DIR): plain files, for what the drive
 * does not have yet, including the segment being written when the copy stopped.
 *
 *   node wal-fetch.js --dir B:\CoffeeLounge\wal --key E:\coffee-lounge-backup-key.txt [--live <folder>] "%f" "%p"
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { decrypt } from '../modules/backup/keys.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string' }, key: { type: 'string' }, live: { type: 'string' } },
});
const [name, target] = positionals;
if (!values.dir || !values.key || !name || !target) {
  console.error('usage: wal-fetch --dir <wal folder> --key <backup key file> <%f> <%p>');
  process.exit(2);
}
const file = join(values.dir, `${name}.gz.age`);
if (!existsSync(file)) {
  for (const copy of values.live ? [name, `${name}.partial`] : []) {
    const local = join(values.live ?? '', copy);
    if (existsSync(local)) {
      copyFileSync(local, target);
      process.exit(0);
    }
  }
  process.exit(1);
}
try {
  writeFileSync(
    target,
    gunzipSync(await decrypt(readFileSync(values.key, 'utf8'), readFileSync(file))),
  );
} catch (error) {
  console.error(`wal-fetch: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
