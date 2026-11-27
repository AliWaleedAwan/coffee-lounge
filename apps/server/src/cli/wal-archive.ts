/**
 * PostgreSQL's archive_command (step 7.1): needs no database and no secrets, only the
 * public key. Exit 0 = archived (PostgreSQL may recycle the segment); anything else = try again.
 *
 *   node wal-archive.js --drive B:\ --dir B:\CoffeeLounge\wal --key <config>\backup.pub \
 *     [--gap-file <data>\wal-gap\gap.log --keep-mb 1024] "%p" "%f"
 */
import { parseArgs } from 'node:util';
import { archiveWal } from '../modules/backup/wal.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    drive: { type: 'string' },
    dir: { type: 'string' },
    key: { type: 'string' },
    'gap-file': { type: 'string' },
    'keep-mb': { type: 'string' },
  },
});
const [sourcePath, name] = positionals;
if (!values.drive || !values.dir || !values.key || !sourcePath || !name) {
  console.error('usage: wal-archive --drive <root> --dir <folder> --key <backup.pub> <%p> <%f>');
  process.exit(2);
}
try {
  await archiveWal({
    driveRoot: values.drive,
    dir: values.dir,
    publicKeyFile: values.key,
    sourcePath,
    name,
    gapFile: values['gap-file'],
    keepBytes: values['keep-mb'] ? Number(values['keep-mb']) * 1024 * 1024 : undefined,
  });
} catch (error) {
  console.error(`wal-archive: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
