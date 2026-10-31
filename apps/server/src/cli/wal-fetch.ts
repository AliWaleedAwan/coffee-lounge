/**
 * PostgreSQL's restore_command during a point-in-time restore (step 7.3): the archived WAL
 * segment `%f`, opened with the owner's key and unzipped, written to `%p`. A segment that is
 * not there exits 1, which tells PostgreSQL it has reached the end of the archive.
 *
 *   node wal-fetch.js --dir B:\CoffeeLounge\wal --key E:\coffee-lounge-backup-key.txt "%f" "%p"
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { decrypt } from '../modules/backup/keys.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dir: { type: 'string' }, key: { type: 'string' } },
});
const [name, target] = positionals;
if (!values.dir || !values.key || !name || !target) {
  console.error('usage: wal-fetch --dir <wal folder> --key <backup key file> <%f> <%p>');
  process.exit(2);
}
const file = join(values.dir, `${name}.gz.age`);
if (!existsSync(file)) process.exit(1);
try {
  writeFileSync(
    target,
    gunzipSync(await decrypt(readFileSync(values.key, 'utf8'), readFileSync(file))),
  );
} catch (error) {
  console.error(`wal-fetch: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
