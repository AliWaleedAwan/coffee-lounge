# Phase 7 — Production Readiness & UAT Build Plan

> **Approved 31 Oct 2026** with P7-1…P7-9 as recommended. Builds on the approved design (G1) and on Phases 2–6, whose software is complete and merged into `main` (`docs/phase-3/ACCEPTANCE.md` … `docs/phase-6/ACCEPTANCE.md`). Where the Phase 0 roadmap and later decisions differ, the decisions win (§3).

| | |
|---|---|
| Goal | The shop can run on the system for real: its records are backed up continuously and can be restored onto another PC, upgrades can be applied and undone, it has been tried on the counter iMac with the real printer, scanner, router and staff, and you have signed off that it does what you need |
| Estimate | 3–4 weeks (roadmap §9: 3–4 weeks including on-site work), in 8 steps. Steps 7.1–7.6 are software, each ending with its tests, verify and Windows CI green and a commit. Steps 7.7–7.8 happen at the shop |
| Entry | Phase 6 merged (PR #4). Your earlier inputs that are still open (§5) don't block steps 7.1–7.6; the shop visit (7.7) and UAT (7.8) need most of them |
| Exit criteria | TEST_PLAN.md §4 (Phase 7 row): the site, hardware, drill, load and UAT suites passed on the shop's own equipment; no open Critical or High defects; known issues written down and reviewed by you |
| Go-live gate | TEST_PLAN.md §12: every suite in §5–§10 passed on target, zero open Critical/High defects, KNOWN_ISSUES.md reviewed by you, signed UAT sheets. **You decide go-live**; I never claim the shop is ready on the strength of tests that did not run on its own PC |

## 1. In and out of Phase 7

| In Phase 7 | Later or not at launch |
|---|---|
| Backups as designed in BACKUP_RECOVERY.md and approved in D-23: WAL archiving every ≤ 5 min, nightly encrypted dump, weekly base backup, two rotating USB drives, a daily off-site copy when online, the private key only with you | Backups of other PCs or tablets (they hold no data) |
| Automatic checks: archiver status, each dump readable, a **weekly test restore** with the integrity checks of BACKUP_RECOVERY.md §4, retention and pruning only after a newer backup is verified, the health items of §8 and banners on every device (AT-80, AT-81) | — |
| Restore: onto this PC or a replacement, latest or to a point in time (owner only, `backup.restore`), with the integrity report and the server certificate re-issued from the shop root, so QR codes and staff devices keep working (AT-22, AC-REC-2) | Restoring single records: mistakes are corrected with reversing entries, never by a restore (BACKUP_RECOVERY.md §5) |
| Upgrades: the installer refuses while bills are open, takes a pre-upgrade dump, migrates, checks health and rolls back by itself if health fails (AT-45) | Automatic updates (never: WINDOWS_DEPLOYMENT.md §7) |
| Load and fault tests: a load script for AC-PERF-1/2, run from a laptop on the shop Wi-Fi; power cut, restart, printer and network drills (AT-15, AT-16, AT-17, AT-56, AT-58) | Load beyond the SRS's peak (3 tablets, 6 phones, the counter PC, 30 guest phones, 120 lines an hour) |
| Guides: owner and administrator guide, one training sheet per role, runbooks (opening, closing, drive swap, printer, network, restore), printable checklists (HOST, SITE, HW, DRILL), UAT scripts and sign-off sheets, KNOWN_ISSUES.md | Translations (the screens are English; D-xx unchanged) |
| The shop visit: host preparation, install, network, printer and scanner checks, the drills and the measurements on the iMac, training | Hardware purchases: your decision (§5) |
| UAT: two scripted 90-minute service sessions with your staff, the second with the internet unplugged (TEST_PLAN.md §10) | — |

**Already in place** and reused: the Windows installer, services and uninstaller with the CI install check (Phase 2, AT-47), write-safe PostgreSQL settings (H-8), the shop certificate authority with its key exported to your USB key (D-39), the health page with the backup drive probe, the protected permissions `backup.manage` and `backup.restore` (seeded since Phase 2, no route uses them yet), the printer simulator and the restart tests (Phase 2–3), the synthetic year (Phase 6) for measuring on the iMac, and the day-end PDF kept in the database (P6-9).

## 2. Decisions this phase implements

D-02 the counter iMac (Windows 10, 16 GB, 128 GB SSD) is the server · D-03 one Sonic SNC-101 printer, the SNC-930D scanner, the Huawei HG8145V5 router · D-11 one shared Wi-Fi · D-23 WAL every 5 min, nightly encrypted dump to USB, two drives swapped weekly, daily cloud copy when online, you hold the key · D-34 Windows 10 without extended updates (accepted risk) · D-35 no UPS (accepted risk) · D-39 the shop certificate on staff devices.

## 3. Changes from the Phase 0 roadmap

| Roadmap item | In this plan | Why |
|---|---|---|
| "Load test on target host" | The load script runs from a laptop on the shop Wi-Fi against the iMac; nothing is installed on the iMac to load it (P7-6) | SECURITY.md: no extra software on the server PC; a load generator on the server would also measure itself |
| "Final installer / upgrader / uninstaller" | The installer and uninstaller exist (Phase 2); this phase adds Restore mode and the upgrade with automatic rollback, both rehearsed in Windows CI | Each is proven on a clean Windows machine before it is tried on the shop's PC |
| Tests AT-15, AT-16, AT-17, AT-22, AT-45…AT-47, AC-PERF-*, AC-REC-* | Adds AT-56, AT-58, AT-80, AT-81 and the Phase 3–6 items that needed the shop (§5) | TEST_PLAN.md assigns them to Phase 7 |
| Open points W-1, W-5, W-6 from Phase 2 | W-1 (PostgreSQL itself dying is not restarted) fixed in step 7.4 (P7-5); W-5 is your decision (P7-7); W-6 checked at the visit | They were left for the dry run |
| — | The cloud part of D-23 needs a place to put the copy; this plan proposes one (P7-2) | D-23 approved the copy but not where it goes |
| BACKUP_RECOVERY.md §1: nightly dump at 04:15, base backup Monday 04:30 | Dump at 04:35, base backup Monday 04:50 | The ledger check (04:15) and the day-end (04:25) now run first, so the dump holds the finished day-end; BACKUP_RECOVERY.md is updated in step 7.1 |

## 4. Build order

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 7.1 ✅ | **Continuous and nightly backups.** The installer makes the backup key pair (the private key goes to your USB key with the CA key, and a printed copy; P7-1), turns on WAL archiving (`archive_timeout = 300`) to the backup drive through `cl-admin wal-archive` (compress, encrypt, never overwrite); the nightly dump at 04:35 (after the day-end) with the attached bills; each run recorded with its size and checksum; the health page and every device show the last dump, the archiver, the drive and its free space, and **"Backup drive missing"** within 15 minutes | Archive and dump tests on a real PostgreSQL; a dump decrypts only with the private key; AT-80 (drive removed → banner ≤ 15 min, WAL catches up when back); Windows CI: archiving as the PostgreSQL service account to a test drive folder | — |
| 7.2 ✅ | **Base backups, rotation, verification, retention.** The weekly base backup (Monday 04:50) and a new one whenever a different drive is plugged in (the two drives are recognised by their label and ID); the weekly **test restore** (Sunday 05:00) into a scratch database with the six integrity checks of BACKUP_RECOVERY.md §4, alerting you on failure; retention of §2, pruning only after a newer backup is verified; the off-site copy of the latest dump, queued while offline (P7-2) | AT-81 (test restore and its checks; a corrupted dump is caught and you are alerted); the integrity checks each fail on a deliberately broken copy; drive swap: base backup on the new drive, archiver green; off-site queue while "offline" | 7.1 |
| 7.3 ✅ | **Restore.** `cl-admin restore` (latest = newest base backup + every archived WAL; or a nightly dump; or, owner only with `backup.restore` and a typed confirmation, a point in time) into a new data folder, the integrity report printed, the damaged folder kept; the installer's **Restore mode** on a new PC: same IP, backup drive and your key USB, server certificate re-issued from the shop root, the counter app re-registered | AT-22 in Windows CI: install, trade, back up, then restore on a clean runner and check integrity, QR links and staff certificate trust; a point-in-time restore lands on the chosen minute; restore without the private key refuses clearly | 7.2 |
| 7.4 | **Upgrades and the PostgreSQL watchdog.** The installer as upgrader: refuses while bills or shifts are open (you can override), pre-upgrade dump to `B:\CoffeeLounge\pre-upgrade\`, migrations, health check, automatic rollback to the previous version and its dump if health fails, the last three kept; W-1: PostgreSQL restarted if it stops on its own (P7-5) | AT-45 in Windows CI: install the release before, trade, upgrade, health green; a deliberately failing migration rolls back to the old version with the data intact; AT-17 again after an upgrade; W-1: the database process killed → back within 1 minute | 7.1 |
| 7.5 | **Load and fault drills as scripts.** The load script (P7-6): 3 tablets, 6 phones, the counter PC and 30 guest phones, a 120-lines-an-hour burst for 30 minutes, measuring API latency and live-update delay; fault scripts for the visit: printer unplugged mid-ticket, server and PostgreSQL restarted mid-payment, power cut simulated by killing everything at once during order entry and payment, router rebooted, internet unplugged | AC-PERF-1/2 measured on the development PC and Windows CI (the iMac at the visit); AT-56 simulated in CI (kill during payments: committed data intact, retries create no duplicates, WAL intact); AT-16, AT-17 re-run; AT-15 with the internet stubbed off (e-mail queued) | 7.1 |
| 7.6 | **Guides, checklists and UAT sheets.** Owner and administrator guide (users, roles, settings, mailbox, backups, restore, upgrades, the key USB); one training sheet per role (waiter, cashier, rider handover, clerk, manager, owner) built from the screens as they are; runbooks; printable HOST-H1…H18, SITE-N1…N9, HW-01…HW-10 and DRILL-1…4 checklists with places for photos and readings; UAT-01…08 scripts and sign-off sheets; KNOWN_ISSUES.md with every open item and its workaround | Each guide checked against the screens by an E2E walk-through of its steps; the training sheets reviewed by you before the visit (I-25) | 7.1–7.5 |
| 7.7 | **The shop visit (dry run on the iMac).** Done by you or your technician with the checklists, outside trading hours; I guide remotely and read the results (photos, readings, exported logs), and never handle router, Wi-Fi or mailbox passwords (P7-8). Host preparation, install, static IP, firewall; network SITE-N1…N9; printer HW-01…HW-09 and AT-85; scanner HW-10 and J7 timed; the iMac measurements AC-PERF-1…4 and AC-REC-1; drills DRILL-1…4 including the restore onto a second PC (AC-REC-2 ≤ 2 h); W-2 and W-6; your real menu, recipes and opening stock loaded | Every checklist filled in and signed; AT-15, AT-16, AT-22, AT-56, AT-58 on the real equipment; results recorded in `docs/phase-7/ACCEPTANCE.md` | 7.1–7.6 |
| 7.8 | **Training and UAT.** Training per role; the two scripted service sessions (UAT-01…08), the second with the internet unplugged; the day's reconciliation checks (AC-INV-1, AC-FIN-3) on that day's data; defects triaged by TEST_PLAN.md §12, fixed and re-tested; KNOWN_ISSUES.md reviewed with you; `docs/phase-7/ACCEPTANCE.md` and the go-live checklist | Signed UAT sheets; zero open Critical/High defects; AC-UX-1 (J1…J8 by at least 4 of 5 staff without help) | 7.7 |

## 5. What I need from you, and when

| # | Input | Needed by | Without it |
|---|---|---|---|
| I-21 | **Two USB backup drives** (any size ≥ 256 GB; 1 TB suggested), labelled A and B (D-23) | Step 7.7 (tests use folders until then) | No backups on the shop PC: go-live cannot be recommended |
| I-22 | Where the daily off-site copy goes (P7-2). If you choose a cloud bucket, you create it and **type its access key on the owner screen yourself**; I never see it | Step 7.2 | Off-site protection is the drive taken home only (RPO ≤ 7 days if the shop and its drive are lost) |
| I-23 | **A second Windows PC** (64-bit, ≥ 8 GB RAM) for the restore drill, for half a day | Step 7.7 | AT-22 and AC-REC-2 stay proven only in CI, not on a real spare |
| I-24 | **Dates for the visit** (one evening or morning outside trading hours, about 6 hours) and for the two UAT sessions with your staff | Steps 7.7, 7.8 | The schedule waits |
| I-25 | Review of the training sheets and the UAT scripts (do they match how your shop works?) | Before 7.7 | Training uses them as written |
| I-26 | A mid-range Android phone on the shop Wi-Fi for the guest menu timing (AC-PERF-3), and a laptop for the load script | Step 7.7 | Measured on whatever phone is there; load from the dev machine |
| I-27 | Whether to buy a code-signing certificate (P7-7) | Step 7.4 | The technician confirms the Windows SmartScreen warning when installing |

Still open from earlier phases and needed by the visit or UAT: the printer photos and self-test (I-1), the router screenshots with passwords blurred (I-2), the tablet and phone models (I-3), your menu (I-4), the golden ticket and receipt approval (I-5), the iMac dry run itself (I-6, this is step 7.7), your items, recipes and opening stock (I-7…I-9), suppliers (I-10), the scanner (I-11), expense categories, assets, refund approvers, opening balances and bill-photo space (I-12…I-16), your mailbox and schedules (I-17, I-18), the logo (I-19) and port 587 (I-20).

## 6. Proposals that need your approval

| # | Proposal | Recommendation |
|---|---|---|
| P7-1 | Encrypt backups with the **age** format through `age-encryption` (open source, BSD-3, plain JavaScript, no internet), instead of shipping `age.exe`: the private key is a single line on your USB key and on paper, and any copy of the free `age` tool opens a backup without the shop's software | Adds one dependency, pinned and audited in CI. Keeps the bundle smaller and leaves one program fewer on the server |
| P7-2 | Off-site copy (D-23): an **S3-compatible bucket** you create with a provider such as Backblaze B2 or Cloudflare R2 (a few GB, free or very cheap); the copy leaves already encrypted, over HTTPS, its key typed by you and stored sealed like the mailbox password. Alternative: drive rotation only | Bucket plus rotation: a fire or theft loses at most a day. A sync program such as Google Drive on the server PC is **not** recommended (SECURITY.md: no extra software on it) |
| P7-3 | The weekly test restore runs on the iMac itself, into a scratch database, Sunday 05:00 | The database is small (a year ≈ a few hundred MB); the SSD check refuses to start it if free space is below twice the database size |
| P7-4 | Upgrades and restores are rehearsed in Windows CI on every release (install the previous release, trade, upgrade, roll back; back up, restore on a clean runner) | Every installer that reaches the shop has been through both on a clean Windows machine |
| P7-5 | W-1: a Windows scheduled task (SYSTEM, every minute) that starts PostgreSQL again if it stopped without an administrator stopping it, and records each restart for the health page | Smallest fix that works with the EDB service; the alternative, wrapping PostgreSQL in WinSW, changes how it was installed |
| P7-6 | The load script is written in this project (Node, no new tool) and runs from a laptop on the shop Wi-Fi; k6, named in TEST_PLAN.md, is not needed | Nothing installed on the iMac; the script replays the real API flows (rounds, pickups, bills, payments, live updates) |
| P7-7 | No code signing for a single shop (W-5): the technician confirms SmartScreen once per install | A certificate costs a yearly fee and an identity check; recommended only if more shops follow |
| P7-8 | The visit is done by you or your technician with the printed checklists while I guide remotely; you send photos (router and Wi-Fi pages **blurred**), readings and the logs the app exports | I cannot be at the shop; everything needed is on paper and on the health page |
| P7-9 | Start steps 7.1–7.6 before your open inputs are in | They don't depend on your data; the visit is planned when the drives, the spare PC and the dates are ready |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Power cuts without a UPS (D-35, accepted) corrupt the database | Write-safe settings checked on the iMac (`pg_test_fsync`, H-8); WAL every 5 minutes; AT-56 on the iMac; restore drill timed |
| Windows 10 without updates on the shared Wi-Fi (D-34, accepted) | Firewall allows two ports only; nothing else installed; the off-site copy so a compromised PC can be replaced from backup |
| The backup drive is left unplugged | Banner on every device within 15 minutes; WAL catches up; the weekly swap is on the closing runbook |
| The private key is lost | Printed copy in your safe; the key check (DRILL-4) before go-live and yearly; without the key no backup can be opened, by design |
| On-site surprises (router isolation, printer driver, iMac speed) | Each has its checklist and a fallback written down before the visit (waiter ordering if guest phones cannot reach the PC; TCP or spooler printing; pre-computed report summaries, P6-6, if AC-PERF-4 fails on the iMac) |
| Training during trading hours | Training sheets per role, sessions outside service, UAT scripted to 90 minutes |
| A defect found in UAT | Severity rules of TEST_PLAN.md §12; Critical/High fixed and re-tested before go-live, others in KNOWN_ISSUES.md with a workaround |

## 8. Working rules (unchanged)

- Every software step ends with its tests passing, `corepack pnpm verify` green, Windows CI green and a commit pushed to `phase-7/readiness` (branched from `main`); nothing is reported as done without test output.
- Migrations are forward-only and follow DATABASE.md; any deviation is recorded in DATABASE.md §15 in the same commit.
- No business data beyond samples until you send yours; no secrets in the repository. The backup private key, the shop CA key, the mailbox and bucket passwords are made or typed on the shop's machines and stay with you; I never see them.
- Hardware, network and performance on the shop's own PC are never claimed until measured there, and recorded with the photo or reading that shows it.
