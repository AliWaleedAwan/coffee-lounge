# Coffee Lounge — Windows Deployment & Host Setup (Phase 1, package 1C)

> Design specification for review R3. Target host (D-02): Apple iMac 27" Mid 2011, Windows 10 Pro N 22H2 via Boot Camp, i5-2500S, 16 GB RAM, 128 GB SSD, no macOS, no UPS. Owner-accepted risks D-34 (no Windows security updates) and D-35 (no UPS) apply throughout.

## 1. What gets installed

Everything ships inside **one offline installer** (`CoffeeLounge-Setup-x.y.z.exe`, NSIS). Nothing is downloaded during installation.

| Component | Location | Runs as |
|---|---|---|
| PostgreSQL 17 (x64, Windows build) | `C:\Program Files\PostgreSQL\17` · data: `C:\ProgramData\CoffeeLounge\pgdata` | Windows service `postgresql-x64-17` |
| Node.js runtime (pinned LTS, bundled, not system-wide) | `C:\Program Files\CoffeeLounge\runtime` | — |
| API + worker application | `C:\Program Files\CoffeeLounge\app` | Services `coffeelounge-api`, `coffeelounge-worker` (WinSW wrappers) |
| Electron counter app | `C:\Program Files\CoffeeLounge\desktop` | The logged-in Windows user |
| Helpers: `cl-rawprint.exe` (RAW printing), `age.exe` (backup encryption), `cl-admin.exe` (recovery/maintenance CLI) | `C:\Program Files\CoffeeLounge\tools` | Called by services / owner |
| Config & secrets | `C:\ProgramData\CoffeeLounge\config` (ACL: service account + Administrators only) | — |
| Logs | `C:\ProgramData\CoffeeLounge\logs` (rotated daily, 30 days, size-capped) | — |
| Attachments (expense receipts, logo) | `C:\ProgramData\CoffeeLounge\files` | — |

Program files are read-only for the service account. The service account can write only to `pgdata`, `logs`, `files` and the backup drive folder.

## 2. Windows services

| Service | Start type | Depends on | Recovery on failure | Account |
|---|---|---|---|---|
| `postgresql-x64-17` | Automatic | — | Restart after 10 s, 30 s, 60 s | PostgreSQL's own service account |
| `coffeelounge-api` | Automatic (delayed start) | PostgreSQL | Restart after 5 s, 10 s, 30 s; reset count after 1 day | `NT SERVICE\coffeelounge-api` (virtual account) |
| `coffeelounge-worker` | Automatic (delayed start) | PostgreSQL | Same as API | `NT SERVICE\coffeelounge-worker` |

- Services run whether or not anyone logs into Windows. **The Startup folder is not used for anything that matters.**
- The API refuses traffic with `503 SERVER_STARTING` until the database is reachable, the schema version matches, and the **clock check** (§5) passes.
- The worker sends a heartbeat every 15 s. The health page shows "worker down" after 60 s without one.

## 3. Host preparation checklist (done once, by the installer where possible)

| # | Setting | Value | Done by |
|---|---|---|---|
| H-1 | Static IP on Ethernet | `192.168.100.250`/24, gateway and DNS `192.168.100.1` | Installer (prompted) |
| H-2 | Network profile | Private | Installer |
| H-3 | Firewall rules | LOCAL_LAN_HOSTING.md §4 | Installer |
| H-4 | Sleep / hibernate | Never / off (`powercfg /h off`) | Installer |
| H-5 | Fast Startup | **Off** (ensures a clean boot after power cuts) | Installer |
| H-6 | Restart after power failure | Enable *"Restart automatically after a power failure"* in the **Boot Camp Control Panel** if this iMac's Boot Camp version offers it (**VERIFY**). If not available, staff press the power button after each cut. | Technician |
| H-7 | Boot Camp startup disk | Windows (no macOS present, but confirm boot goes straight to Windows) | Technician |
| H-8 | Disk write safety | PostgreSQL `wal_sync_method` chosen with `pg_test_fsync` on this SSD. Per PostgreSQL's Windows guidance, use `fsync`/`fdatasync`, or disable the drive's write cache, so committed data survives power loss. **Required because there is no UPS.** | Installer + verified in drill |
| H-9 | Windows accounts | `Owner` (administrator, password known only to owner); `Counter` (**standard user**) for daily use | Technician |
| H-10 | Counter auto-login | `Counter` account logs in automatically after a power cut, so the Electron app reappears without a Windows password. The app itself still needs staff PIN/password. **PROVISIONAL**: the alternative is a Windows password at every boot, which slows recovery after cuts. | Technician |
| H-11 | Electron auto-start | At `Counter` login, full-screen | Installer |
| H-12 | Remote Desktop, file sharing, network discovery | Off | Installer |
| H-13 | Microsoft Defender | On; exclusion for `pgdata` (scanning live database files causes slowdowns and lock errors) | Installer |
| H-14 | Disk space alerts | Health page warns at 80 % and 90 % used | App |
| H-15 | Time zone & clock | Asia/Karachi; Windows time sync enabled for whenever internet is up | Installer |
| H-16 | Browsing / e-mail / other software on this PC | **Not allowed** (unpatched OS, D-34) | Policy + training |
| H-17 | USB backup drive | Fixed drive letter **`B:`**, volume label `CL-BACKUP` | Technician |
| H-18 | SSD health | Read SMART status; record in setup sheet | Technician |

## 4. Boot sequence after a power cut (no UPS)

```text
Power returns
  └─ iMac powers on (automatically if H-6 works, otherwise by hand)
      └─ Windows boots (Fast Startup off → full boot)
          ├─ postgresql-x64-17 starts → WAL crash recovery (seconds)
          ├─ coffeelounge-api (delayed) → checks DB, schema, clock → ready
          ├─ coffeelounge-worker (delayed) → resumes print/e-mail jobs
          └─ Counter auto-login → Electron app opens → staff PIN
Router powers on independently → staff devices reconnect → "System back online" banner → views refetch
```

**Target:** ready ≤ 3 min after Windows boot (AC-REC-1), to be measured on this iMac. Uncertain print jobs from before the cut are shown for confirmation (PRINTING_HARDWARE.md §5).

## 5. Clock safety (old hardware, no UPS)

A 15-year-old iMac may lose its clock setting after power cuts if its internal clock battery is weak. A wrong clock would put sales on the wrong business date and break receipts and reports. Guards:

1. At startup the API compares the system time with the **latest timestamp stored in the database**. If the clock is earlier, the API stays in `SERVER_STARTING` and the counter app shows **"PC clock is wrong. Set the date and time, then press Retry"** (owner/manager only).
2. A jump of more than 10 minutes while running raises an alert.
3. When internet is available, Windows time sync corrects drift.

## 6. Installation flow (first install)

1. Technician completes H-6, H-7, H-9, H-17, H-18; plugs in printer, scanner, backup drive.
2. Run installer as `Owner` → prerequisites check (Windows version, free disk ≥ 20 GB, drive `B:` present, port 8080/8443 free).
3. Installs PostgreSQL silently with a generated password (stored encrypted with Windows DPAPI, machine scope), creates `cl_migrator`/`cl_app`/`cl_readonly` roles, applies migrations and seeds.
4. Generates the shop root CA + server certificate; exports the **root private key** and the **backup decryption key** to the owner's separate USB key, then deletes the CA private key from the PC.
5. Creates the owner app account and prints a **one-time recovery code** for the owner's safe.
6. Applies H-1…H-5, H-11…H-15; registers and starts services; runs health check.
7. Test print on the SNC-101; scanner test; creates the counter device registration automatically.
8. Prints the setup sheet (versions, IP, checks passed) for the owner's file.

## 7. Upgrades and rollback

| Step | Detail |
|---|---|
| When | Outside trading hours. The installer refuses while sessions are open, unless the owner overrides. |
| Before | Stop API/worker → `pg_dump` to `B:\CoffeeLounge\pre-upgrade\` → verify dump |
| Apply | Replace program files → run forward-only migrations (each in a transaction where possible) → start services → health check |
| Rollback | If health fails: stop services → restore the pre-upgrade dump → reinstall the previous version (kept in `tools\previous\`) → health check → report |
| Compatibility | Migrations follow expand → migrate → contract across releases, so a rollback within one version is always possible |
| No auto-update | Electron and services never self-update; updates are delivered as a new installer |

## 8. Uninstall

Removes services and program files. **Keeps** `C:\ProgramData\CoffeeLounge` (database, logs, files) and the backup drive unless the owner explicitly chooses "remove data" and types the shop name to confirm.

## 9. Operating rules for staff (training sheet)

- Never switch off or restart the counter PC during trading. If it must restart, tell all staff first.
- Don't unplug the cable labelled SERVER or the USB backup drive.
- After a power cut: if the PC doesn't start by itself, press its power button. Wait for "System back online".
- Don't browse the web, read e-mail or install software on the counter PC.
- Keep spare receipt rolls; keep the emergency paper order pad at the counter.
