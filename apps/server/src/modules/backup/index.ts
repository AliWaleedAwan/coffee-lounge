/** Public interface of the backup module (other modules import only from here). */
export { BackupWatch, type BackupHealth, type BackupProblem } from './status.ts';
export { backupRoot, runDump, type BackupConfig, type DumpResult } from './dump.ts';
export { decrypt, encrypt, makeBackupKeys, PRIVATE_KEY_FILE, readRecipient } from './keys.ts';
export { archiveWal } from './wal.ts';
export { baseBackupDue, runBaseBackup } from './base.ts';
export { identifyDrive } from './drive.ts';
export { pruneBackups } from './retention.ts';
export { integrityChecks, testRestore, type IntegrityReport } from './verify.ts';
export {
  copyOffsite,
  readOffsite,
  saveOffsite,
  testOffsite,
  type OffsiteDeps,
  type OffsiteInput,
} from './offsite.ts';
export { backupRoutes } from './routes.ts';
export {
  baseBackups,
  latestDump,
  prepareBaseRestore,
  readKeyFile,
  restoreDump,
  type PreparedRestore,
} from './restore.ts';
