# Coffee Lounge — Backup & Recovery Runbook (Phase 1, package 1C)

> Design specification for review R3. Because the server is a 15-year-old PC with one 128 GB SSD and **no UPS** (D-02, D-35), backups are the main protection for the shop's records. Targets are proposals to be proven by the restore drill (AC-REC-2). Provisional default D-23 applies.

## 1. What is backed up

| Layer | Method | Frequency | Destination | Encrypted |
|---|---|---|---|---|
| Continuous changes | PostgreSQL WAL archiving via `cl-admin wal-archive` (compress → encrypt → write, never overwrite) | Every completed WAL segment, forced at least every **5 min** while there is activity (`archive_timeout = 300`) | `B:\CoffeeLounge\wal\` | Yes |
| Physical base backup | `pg_basebackup` (compressed, then encrypted) | **Weekly** (Monday 04:50) and automatically when a different backup drive is plugged in | `B:\CoffeeLounge\base\<date>\` | Yes |
| Logical dump | `pg_dump -Fc` (portable to newer PostgreSQL versions) | **Nightly** at 04:35 (after the 04:00 cutoff, the ledger check at 04:15 and the day-end at 04:25, so the dump holds the finished day-end) | `B:\CoffeeLounge\dumps\` | Yes |
| Files | Logo, expense attachments, config (without secrets) | Nightly with the dump | `B:\CoffeeLounge\files\` | Yes |
| Off-site copy | Latest nightly dump | Daily when internet is up (queued otherwise) **and/or** weekly drive rotation (§3) | Owner's cloud folder and/or second drive taken home | Yes |

**Encryption:** the installer creates a backup key pair (`age`). The **public key** stays on the server so it can encrypt. The **private key** never stays on the server: it goes on the owner's separate USB key, plus a printed copy in the owner's safe. **Without the private key, the backups can't be restored.** Losing it means losing the backups.

**Compression:** archived WAL segments are 16 MB each but mostly empty on a quiet day; compression reduces them to a small fraction before encryption. Expected total backup growth (to verify in the drill): a few GB per month.

## 2. Retention

| Item | Keep |
|---|---|
| Nightly dumps | 14 daily + 8 weekly (Monday) + 12 monthly (1st) |
| Base backups | Latest 2 per drive |
| WAL | Everything newer than the oldest kept base backup on that drive |
| Pre-upgrade dumps | Last 3 upgrades |

The worker prunes old files only **after** the newer backup has been verified.

## 3. Backup drives

- One external USB drive labelled **CL-BACKUP**, fixed letter `B:`, 1 TB recommended (any size ≥ 256 GB works).
- **Recommended (provisional, D-23):** two drives, **A** and **B**, swapped every Monday. The drive not in use goes home with the owner, which protects against theft, fire or flood at the shop. When a drive is plugged in, the system recognises it, takes a fresh base backup and continues WAL archiving on it.
- During the swap (a few seconds), WAL archiving pauses and catches up automatically.
- If **no drive** is plugged in, WAL files accumulate on the 128 GB SSD. The health page and all staff devices then show **"Backup drive missing"** within 15 minutes, and disk-space alerts follow (SECURITY.md SR-9).

## 4. Automatic verification

| Check | When | Pass condition | On failure |
|---|---|---|---|
| WAL archiver status (`pg_stat_archiver`) | Every 5 min | No failures since last success | Red banner "Backups failing" |
| Dump readable (`pg_restore --list`) | After each dump | Lists all tables | Alert; retry dump |
| **Test restore** of latest dump into scratch database `cl_restore_test` | Weekly (Sunday 05:00) | Restore succeeds and all integrity checks below pass | Alert to owner; keep previous verified dumps |
| Off-site copy | Daily | Uploaded file size + checksum match | "Off-site copy pending" (not an error while offline) |

**Integrity checks** (run after every test restore, and on demand after a real restore):
1. Per item: `on_hand` = Σ `stock_movements.qty_delta`; `reserved` = Σ open reservation remainders; `inventory_value` = Σ `value_delta`.
2. Per settled invoice: `total` = Σ line `net` − bill-level discounts + rounding; `paid_total` = Σ payments = `total`.
3. Per closed cash shift: `expected_cash` recomputes from payments, refunds and cash movements.
4. Ledger: every sale/refund/purchase payment has exactly one ledger entry (`source_key` coverage).
5. Counters: `document_counters.next_value` > highest issued number per kind.
6. No orphaned references (FK validation pass).

## 5. Recovery procedures

> **Restores are for disasters, never for fixing business mistakes.** A wrong discount, void or stock entry is corrected with a reversing entry. Restoring an older backup would silently erase everything recorded since.

### 5.1 Server PC died, backup drive OK (most likely case)

| Step | Action |
|---|---|
| 1 | Switch to the paper order pad (SR-11). |
| 2 | Take any Windows 10/11 PC (64-bit, ≥ 8 GB RAM). Apply the host checklist (WINDOWS_DEPLOYMENT.md §3), at minimum static IP **192.168.100.250**, so QR codes keep working. |
| 3 | Run the same installer version in **Restore mode**; plug in the backup drive and the owner's key USB. |
| 4 | Choose **Point-in-time (latest)**: restores the newest base backup and replays WAL to the last archived segment. RPO ≤ ~5 minutes. |
| 5 | Integrity checks (§4) run automatically; the result is printed. |
| 6 | The installer **re-issues the server certificate** from the shop root key on the owner's key USB (backups never contain secrets). Staff devices already trust that root, so they reconnect with no reinstall (same IP). Re-register the counter app. Printer: install driver, test print. |
| 7 | Back-enter paper-pad orders as "manual back-entry" with original times (flagged in reports). |

**Target RTO: ≤ 2 hours** with a replacement PC available (to be proven in the drill).

### 5.2 Server and current backup drive both lost (fire/theft)
Restore from the **off-site** copy (cloud or the drive at home) using §5.1 with the latest nightly dump. **RPO = time since that copy**: ≤ 24 h with daily cloud copy, ≤ 1 week with drive rotation only.

### 5.3 Database damaged, PC fine
Stop services → `cl-admin restore --point-in-time latest` (same as 5.1 step 4) into a new data directory → integrity checks → switch services to it. The damaged data directory is kept for analysis, not deleted.

### 5.4 Restore to a specific time (e.g., just before corruption)
Owner-only (`backup.restore` 🔒): choose a timestamp; everything after it is lost and must be re-entered. Requires the owner's password and a typed confirmation.

## 6. Recovery objectives (proposed, D-23)

| Scenario | RPO (data loss) | RTO (downtime) |
|---|---|---|
| Power cut, PC restarts | 0 committed transactions (if the write-safety setting holds, WINDOWS_DEPLOYMENT.md H-8) | ≤ 3 min after boot |
| PC failure, drive OK | ≤ 5 min | ≤ 2 h with replacement PC |
| PC + drive lost | ≤ 24 h (daily cloud copy) / ≤ 7 days (rotation only) | ≤ 4 h |

## 7. Drills and evidence

| Drill | When | Evidence |
|---|---|---|
| Full restore onto a **different** Windows PC (§5.1) | Before go-live (Phase 7), then quarterly | Timed checklist, integrity report, screenshots (AT-22, AC-REC-2) |
| Power-cut test: pull the plug during order entry and payment | Before go-live | AT-56 log: no lost or duplicated records |
| Drive swap test | Before go-live | Base backup created on the new drive; archiver green |
| Key check: owner opens a dump with the private key | Before go-live and yearly | Signed checklist |

## 8. Health page items

Last successful dump · last verified test restore · WAL archiver status and last archived time · backup drive present and free space · off-site copy status · SSD free space · next scheduled backup.

## 9. As built (Phase 7 step 7.1)

- **Key pair:** `admin backup-keygen --out <owner USB>`, run by the installer at the first install with `-CaExportDir`: `coffee-lounge-backup-key.txt` (the private key, age X25519) goes only to the owner's USB key; `config\backup.pub` stays on the PC (P7-1). Any `age` tool opens a backup: `age -d -i coffee-lounge-backup-key.txt file.age > file`.
- **WAL:** `archive_mode = on`, `archive_timeout = 300`, `archive_command` = `wal-archive.js` (in the program folder), run by PostgreSQL's own account: gzip, encrypt, write `B:\CoffeeLounge\wal\<segment>.gz.age` under a temporary name, flush, rename; a checksum file beside it; never overwrites (the same segment again is accepted, a different one refused). While the drive is missing it fails and PostgreSQL keeps the segment and retries (AT-80).
- **Nightly dump:** the worker's `backup:dump` at 04:35, as the service login: `pg_dump -Fc` of the `cl` and `cl_meta` schemas, checked with `pg_restore --list`, encrypted in memory (no plain copy on any disk), written to `B:\CoffeeLounge\dumps\cl-<UTC time>.dump.age`, read back against its checksum; the attached bills copied once each, encrypted, to `B:\CoffeeLounge\files\`. `admin backup-now` makes one on request. Each run is a row in `cl.backup_runs`.
- **Watching:** the health page shows the drive (and its free space), the last dump and its error, and WAL archiving; every signed-in device shows a red banner when the drive has been missing for 5 minutes, archiving fails, the last dump failed or none succeeded for 26 hours.
- **Drive rights:** PostgreSQL's account (NETWORK SERVICE) and the worker must be able to write to `B:\`. An NTFS-formatted drive allows it by default (Authenticated Users: Modify); the visit checks it (step 7.7).

## 10. As built (Phase 7 step 7.2)

- **Backup login:** `cl_backup` (LOGIN REPLICATION), made by the installer with its password DPAPI-sealed in `config\backup-login.secret`; it owns the scratch database `coffee_lounge_restore_test` (with `pg_trgm`) and reaches PostgreSQL for replication from this PC only (`pg_hba.conf`).
- **Base backups:** `pg_basebackup -Ft -X fetch` as `cl_backup`, compressed and encrypted to `B:\CoffeeLounge\base\<UTC time>\base.tar.gz.age`, every Monday at 04:50 (`backup:base`), and within 5 minutes of a drive with no base backup being plugged in (`backup:watch`). `admin backup-base` makes one on request.
- **The drives:** each carries `CoffeeLounge\drive.json` with its id and letter (A, B … in the order first seen); every run records the drive.
- **Test restore:** with Sunday's dump (`backup:dump` on Sundays, shop clock; `admin backup-now --test-restore` on request): the dump is restored into the scratch database with `pg_restore --single-transaction --exit-on-error` and the six checks of §4 run there; the result is its own run. **Change from §4:** the private key is never on the PC, so the check restores the dump as it is made, just before it is encrypted; that the encrypted file opens is proven by the owner's key check (DRILL-4) and the restore drill. A failed check shows on every device ("The weekly test restore found a problem") and on the health page with what failed.
- **Retention (§2):** after each watch, on the drive plugged in only and only if its newest dump is verified: dumps kept 14 daily + 8 Mondays + 12 firsts of the month (shop dates), base backups the latest 2, WAL newer than the oldest kept base backup (less an hour). Pruned runs keep their row with `pruned_at`.
- **Off-site copy (P7-2):** every 15 minutes (`backup:offsite`) the newest dump, if not copied yet, is PUT to the owner's bucket (AWS Signature V4, path style, HTTPS only, checked against AWS's published example). While it cannot be reached it waits, shown as "Waiting for internet" on the health page, not as an alarm. The bucket key is typed by the owner (Settings → Off-site copy) and sealed with the mailbox key.

## 11. As built (Phase 7 step 7.3): restoring

Every restore needs the owner's USB key (its `coffee-lounge-backup-key.txt`); nothing on the PC opens a backup alone.

- **Replacement PC (§5.1, §5.2):** run the installer with `-CaExportDir <owner USB> -RestoreFrom latest` (or a dump file, e.g. from the off-site copy), the backup drive plugged in at `B:`. It installs as on a first visit but reuses the **shop root** from the USB key (staff devices keep trusting the new server certificate) and the **backup key** (old and new backups open with the same key), then restores the newest dump (`admin restore-dump`) and runs the integrity checks. Refused if the database already holds trading. Then: static IP 192.168.100.250 (so the printed QR codes keep working), re-register the counter app, test print.
- **Point in time on this PC (§5.3, §5.4):** `setup\restore.ps1 -KeyFile <USB>\coffee-lounge-backup-key.txt [-PointInTime "2026-11-02 14:30"]`, as Administrator, after typing RESTORE. It stops the services, renames the database folder to `pgdata-before-restore-<time>` (never deleted), unpacks the newest base backup before the time (`admin restore-prepare`), lets PostgreSQL replay the archived WAL to the time (`wal-fetch.js` as restore_command, with a copy of the key readable by PostgreSQL's account only for the replay, deleted after), runs the integrity checks (`admin integrity-check`) and starts the services. **Change from §5.4:** owner-only is enforced by needing the owner's USB key and the typed confirmation on the PC itself, not the owner's password, which lives in the database being replaced.
- **One WAL folder per database cluster:** `B:\\CoffeeLounge\\wal\\<system id>` (`BACKUP_WAL_DIR`). A replacement PC's new cluster starts its WAL names again; in a shared folder they would meet the old PC's files and archiving would stop (found by the drill). A point-in-time restore keeps its cluster's id and folder.
- **Rehearsed in Windows CI on every build:** marker A before the chosen time and marker B after: A comes back, B does not, the old folder is kept, the API is ready; then everything removed and a Restore-mode install from the dump: users, records, shop root and backup key all back, integrity checks pass (DRILL-1, AT-22). The timed drill on a real spare PC (AC-REC-2, ≤ 2 h) is part of the visit (step 7.7).
