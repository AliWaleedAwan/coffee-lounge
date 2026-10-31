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
- Still to come in step 7.2: base backups, drive rotation, retention, the weekly test restore and the off-site copy.
