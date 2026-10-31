/** Public interface of the backup module (other modules import only from here). */
export { BackupWatch, type BackupHealth, type BackupProblem } from './status.ts';
export { backupRoot, runDump, type BackupConfig, type DumpResult } from './dump.ts';
export { decrypt, encrypt, makeBackupKeys, PRIVATE_KEY_FILE, readRecipient } from './keys.ts';
export { archiveWal } from './wal.ts';
