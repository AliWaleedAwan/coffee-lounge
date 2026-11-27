# Coffee Lounge — Windows Deployment & Host Setup (Phase 1, package 1C)

> Design specification for review R3. Target host (D-02): Apple iMac 27" Mid 2011, Windows 10 Pro N 22H2 via Boot Camp, i5-2500S, 16 GB RAM, 128 GB SSD, no macOS, no UPS. Owner-accepted risks D-34 (no Windows security updates) and D-35 (no UPS) apply throughout.

## 1. What gets installed

Everything ships inside **one offline installer** (`CoffeeLounge-Setup-x.y.z.exe`, NSIS). Nothing is downloaded during installation.

| Component | Location | Runs as |
|---|---|---|
| PostgreSQL 17 (x64, Windows build) | `C:\Program Files\PostgreSQL\17` · data: `C:\ProgramData\CoffeeLounge\pgdata` | Windows service `postgresql-x64-17` |
| Node.js runtime (pinned LTS, bundled, not system-wide) | `C:\Program Files\CoffeeLounge\runtime` | — |
| API + worker application | `C:\Program Files\CoffeeLounge\app` | Services `coffeelounge-api`, `coffeelounge-worker` (WinSW wrappers) |
| Electron counter app | `C:\Program Files\CoffeeLounge\desktop` · settings: `C:\ProgramData\CoffeeLounge\desktop` (§10) | The logged-in Windows user |
| Helpers: `cl-rawprint.exe` (RAW printing), `age.exe` (backup encryption), `cl-admin.exe` (recovery/maintenance CLI) | `C:\Program Files\CoffeeLounge\tools` | Called by services / owner |
| Config & secrets | `C:\ProgramData\CoffeeLounge\config` (ACL: service account + Administrators only), including `backup-login.secret` (the backup login's password, DPAPI, step 7.2), `backup.pub` (`BACKUP_PUBLIC_KEY_FILE`, the backup public key; the private key is only on the owner's USB key, step 7.1) and `mail.key` (`MAIL_KEY_FILE`, the key that seals the mailbox password; made once by the installer, kept on reinstall) | — |
| Logs | `C:\ProgramData\CoffeeLounge\logs` (rotated daily, 30 days, size-capped) | — |
| Attachments (expense receipts, logo) | `C:\ProgramData\CoffeeLounge\files` (`FILES_DIR` in the server config) | — |

Program files are read-only for the service account. The service account can write only to `pgdata`, `logs`, `files` and the backup drive folder.

**Setup wizard (Phase 8 step 8.4):** `CoffeeLounge-Setup.exe` with no options opens a wizard; on a first install it asks for the shop address, the USB key folder, the key passphrase and the owner's password. The owner's recovery code is written to the USB key as `coffee-lounge-owner-recovery-code.txt`. With any option it runs as before.

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
2. Run installer as `Owner` → prerequisites check (Windows version, free disk ≥ 10 GB (owner, Nov 2026), drive `B:` present, port 8080/8443 free).
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
| Updates | Nothing updates by itself. The updater (`update-agent.mjs`, SYSTEM, every minute, in the administrators-only `update-agent` folder) reports a new version, and installs it when the owner presses Update now on System health. Same setup script, so same refusal with open bills and same rollback. Small updates (1.0.10): a release also publishes each part (app, web, desktop, runtime, pgsql, winsw, setup, meta) as a .tar.gz, with fingerprints signed separately in latest.json; the updater downloads only the parts whose fingerprint differs from `InstallDirparts.json`, rebuilds a full bundle from them and the installed parts, checks every part against its signed fingerprint, and runs the setup script from it, so every program file is still replaced. No parts record, a bad signature, a changed local file or any other surprise uses the full installer. Release: push tag `vX.Y.Z` |

### 7.1 As built (step 7.4)

- The installer upgrades when it finds the shop installed: it **refuses while bills or a cash shift are open** (`-Force` when the owner decides otherwise), puts down `maintenance.flag`, takes a pre-upgrade dump of the whole database (`C:\ProgramData\CoffeeLounge\pre-upgrade\`, protected folder, last three kept, checked with `pg_restore --list`; not encrypted, as it never leaves this PC's data folder) and keeps the current program in `previous-version\` (the plan said `tools\previous\`).
- If anything then fails (copying, migrations, starting, the health checks), it **rolls back by itself**: the previous program files, the database recreated from the pre-upgrade dump, the old version started and its health checked, and the log says `ROLLED BACK`.
- Rehearsed in Windows CI on every build: an upgrade with one more migration; the refusal with a shift open; a failing migration rolled back to the version and data from before.

## 8. Uninstall

Removes services and program files. **Keeps** `C:\ProgramData\CoffeeLounge` (database, logs, files) and the backup drive unless the owner explicitly chooses "remove data" and types the shop name to confirm.

## 9. Operating rules for staff (training sheet)

- Never switch off or restart the counter PC during trading. If it must restart, tell all staff first.
- Don't unplug the cable labelled SERVER or the USB backup drive.
- After a power cut: if the PC doesn't start by itself, press its power button. Wait for "System back online".
- Don't browse the web, read e-mail or install software on the counter PC.
- Keep spare receipt rolls; keep the emergency paper order pad at the counter.

## 10. Counter app (step 2.8, as built and tested on macOS)

**Settings file** `C:\ProgramData\CoffeeLounge\desktop\desktop.json` (readable by the `Counter` user, writable by Administrators only; written by the installer):

```json
{ "serverUrl": "https://127.0.0.1:8443", "caCertFile": "coffee-lounge-root.pem", "fullscreen": true }
```

`caCertFile` is the **public** shop root certificate, next to the settings file. The app trusts that root, and only that root, for the server; it never consults the Windows certificate store for it. The counter app uses the loopback address because it runs on the server PC itself, so it keeps working when the Ethernet cable is out. **The server certificate must therefore list `127.0.0.1` as well as `192.168.100.250`** (step 2.9 certificate tool). Plain `http` is accepted only for a loopback address, for development.

| Behaviour | As built |
|---|---|
| Renderer | Sandboxed, context-isolated, no Node, no webviews, no new windows, no permissions (camera, notifications, …), no downloads (exports get a reviewed path in their phase), DevTools only in unpackaged builds |
| Origin lock | Pages may only be the server origin. Every network request to anything else is cancelled before it leaves the PC; navigation and redirects elsewhere are refused |
| Certificate pinning | The chain must lead to the shop root, match the server address, be in date and use no weak signature (SHA-1, MD5). Chromium's own checks still apply; pinning overrides only its "unknown root" verdict |
| CSP | The server's policy; the app adds the same policy if a server page ever arrives without one. Its own pages carry a stricter one |
| Server unavailable | Branded screen with what to check and "Try again now"; probes `/health/live` every 3 s and opens the app as soon as it answers. A certificate problem shows "Server not trusted" (do not enter passwords) and is never bypassed. Missing or invalid settings show "Counter app not set up" |
| Start-up screen (step 8.5) | Installed app on the server PC: at launch and on every probe it reads the Database, Server and Background jobs services with `sc query` and starts a stopped one with `sc start` (database first; 3 tries 15 s apart; never while `maintenance.flag` exists). The installer gives the `Counter` account query and start rights on those three services only, not stop or configure. It opens once Database and Server run; Background jobs are shown but do not hold it back. The Printer row reports only the Windows print service, which the app never starts; the printer itself is on the Health page |
| Preload API | `window.coffeeLounge = { version, retryNow() }`, plus `onServices` on the app's own local screen only. First-run address entry (`setHostAddress` in 02-architecture §2.11) was dropped: the installer writes the settings, so staff cannot point the app elsewhere |
| On Windows (step 2.9b, §11) | Packaged with an asar archive and Electron fuses; installed with a logon task for `Counter`, a Start menu shortcut and an Add/Remove Programs entry; checked in CI on Windows |

## 11. Windows install (step 2.9, as built; proven in CI on Windows Server 2022)

**Build** (`deploy/windows/build-bundle.ps1`, on Windows): the web app, the server bundled with esbuild (`apps/server/dist`) plus production `node_modules` from `pnpm deploy`, and three pinned downloads checked by SHA-256 (`deploy/windows/components.json`): Node 24.22.0 (hash from nodejs.org), PostgreSQL 17.11 binaries and WinSW 2.12.0. EDB and WinSW publish no checksums, so those two hashes were taken from the first CI download on 20 Oct 2026 and must be re-checked when the versions change. Nothing is downloaded at install time.

**Install** (`setup\install.ps1`, Windows PowerShell 5.1, as Administrator; re-running it is the upgrade path and keeps the data):

| Step | As built |
|---|---|
| PostgreSQL | Binaries copied to `C:\Program Files\PostgreSQL\17`; cluster created with `initdb` (UTF8, scram-sha-256) instead of the EDB installer; listens on `localhost` only; `pg_hba` allows password logins from this PC only; `wal_sync_method = fsync` (H-8: `fsync_writethrough` is rejected by this build; the power-cut drill measures the choice); logs in `pgdata\log`; service `postgresql-x64-17` as NetworkService with recovery 10 s / 30 s / 60 s |
| Secrets | Superuser, `cl_migrator` and `cl_service` passwords are random, sealed with DPAPI (machine scope) in `config\*.secret`; never on a command line or in a log |
| Logins | `cl_migrator` (owns the database, runs migrations) and `cl_service` (member of `cl_app` only; the API and worker log in as it). DATABASE.md §15 |
| Certificates | Shop root CA (10 years, P-256, encrypted key) and server certificate for the shop address and `127.0.0.1`; the CA key and certificate go to `-CaExportDir` (the owner's USB key) and the CA key is deleted from the PC. The passphrase is typed, or passed to unattended runs in an environment variable (PowerShell 5.1 garbles piped stdin) |
| Services | WinSW wrappers `coffeelounge-api` / `-worker`: automatic (delayed), depend on PostgreSQL, own virtual accounts (`NT SERVICE\…`), recovery 5 s / 10 s / 30 s with reset after 1 day, stop with Ctrl+C (Node shuts down cleanly), daily log files |
| Permissions | `config` (secrets, TLS key) readable by SYSTEM, Administrators and the two service accounts only; `logs` and `files` writable by the services; `desktop` settings readable by Users |
| Firewall | 8080 and 8443 inbound from the local subnet, private profile only |
| Host settings | H-4, H-5, H-12, H-15 and the Defender exclusion (H-13), skippable with `-SkipHostSettings` (test machines) |
| Counter app settings | `desktop\desktop.json` and the public root certificate (§10) |
| Health | Waits for `/health/ready` on 8443 (trusting only the shop root) and 8080; on a first interactive install, creates the owner account |

**Counter app and installer (step 2.9b):** `apps/desktop/scripts/package.mjs` packages the app (asar with only `dist/`, `static/`, `package.json`) and sets the fuses (`scripts/fuses.mjs`: no RunAsNode, no `NODE_OPTIONS`, no `--inspect`, asar only with integrity validation, cookie encryption, no extra `file://` privileges). The installer stops a running copy before upgrading, installs it to `desktop\`, creates the scheduled task *Coffee Lounge counter app* (at the logon of `-CounterUser`, default `Counter`, standard rights; if that account does not exist yet it says so and a re-run adds the task), a Start menu shortcut and an Add/Remove Programs entry. The installed app ignores `CL_DESKTOP_CONFIG`/`CL_USER_DATA_DIR` (development only) and logs to `%APPDATA%\Coffee Lounge\desktop.log`. `CoffeeLounge-Setup-<version>.exe` (NSIS, `installer.nsi`, about 170 MB) unpacks the bundle to a temporary folder and runs `install.ps1` in the **64-bit** PowerShell with its own command-line options; `CL_CA_PASSPHRASE` may carry the CA passphrase for unattended runs.

**Uninstall** (`setup\uninstall.ps1`) removes the services, firewall rules and program files and keeps `C:\ProgramData\CoffeeLounge`; removing the data also needs `-RemoveData -ConfirmShopName "Coffee Lounge"`.

**Evidence (AT-47, `deploy/windows/tests/smoke.ps1`, every push; installed through `CoffeeLounge-Setup.exe`):** the counter app's eight fuses read back from the installed executable; the app installed with its logon task (Counter, standard rights), shortcut, uninstall entry and full-screen setting; `ELECTRON_RUN_AS_NODE` refused by the installed app; the installed app opening the staff app over the pinned HTTPS connection; services running with the right start type, accounts, dependencies and recovery actions; PostgreSQL listening on this PC only; staff HTTPS trusted only through the shop root, customer HTTP ready, staff app served with its CSP; worker heartbeat fresh; `cl_service` cannot change the schema; secrets not readable by ordinary users; CA key not on the PC; a killed API restarted by Windows; a killed database process recovered by PostgreSQL with the API carrying on (AT-17 on Windows); uninstall keeps the database and a reinstall serves the same owner account.

**Open points**

| # | Point | Proposal |
|---|---|---|
| W-1 | If the PostgreSQL **postmaster itself** dies, `pg_ctl`'s service wrapper reports a clean stop, so Windows does not apply the recovery actions; the database stays down until a restart or reboot (the health page shows it). A crashed database *process* is handled by PostgreSQL itself (tested) | Decide at the iMac dry run: either accept (very rare event), or run `postgres.exe` under WinSW like the API so Windows restarts it **Done (step 7.4, P7-5):** the database watchdog (a scheduled task, SYSTEM, every minute) starts PostgreSQL again and writes `logs\pg-watchdog.log`, shown on the health page; it stands aside while `maintenance.flag` is down (upgrades, restores) |
| W-2 | The CI machine is Windows Server 2022, not Windows 10, has no Boot Camp and cannot reboot or lose power | The iMac dry run covers Windows 10, auto-login, power cuts and the clock |
| W-3 | WinSW rolls logs daily but does not delete old ones | **Done (step 3.6):** the worker deletes files in `LOG_DIR` older than 30 days, daily at 03:30 |
| W-4 | Not automated: static IP and network profile (H-1, H-2), setup sheet. The test print exists (step 3.6): Settings → Printers → Test print, or `admin printer-add` and `admin test-print` on the PC | Phase 7 (site setup) |
| W-5 | `CoffeeLounge-Setup.exe` and `CoffeeLounge.exe` are not code-signed: Windows SmartScreen will warn when the technician runs the installer | Accept for a single shop (the technician confirms the warning), or buy a code-signing certificate before go-live |
| W-6 | CI starts the counter app as the CI administrator; nobody logs in as `Counter` there, so the logon task itself has not fired yet | The iMac dry run: log in as `Counter` and confirm the app opens full screen |
