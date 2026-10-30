# Coffee Lounge — Security Baseline & Risk Register (Phase 1, package 1C)

> Design specification for review R3. Consolidates security design for the decided environment: one counter PC as server on Windows 10 without updates (D-34), no UPS (D-35), one Wi-Fi shared by guests and staff (D-11), staff personal phones (D-03, D-39). Permissions: [RBAC.md](RBAC.md). Network: [LOCAL_LAN_HOSTING.md](LOCAL_LAN_HOSTING.md).

## 1. What we protect, and from whom

| Asset | Threats that matter here |
|---|---|
| Money records (payments, refunds, cash shifts) | Staff misuse (unauthorised discounts/refunds/voids), duplicate postings, tampering after the fact |
| Stock and cost records | Unrecorded waste/theft hidden by edits; accidental double consumption |
| Owner reports and costs | Staff or guests viewing profit/cost data |
| Staff accounts and devices | Shared PINs, lost personal phones, guests on the same Wi-Fi |
| The server PC | Unpatched Windows, physical access at the counter, malware from browsing/USB |
| Customer data (delivery name/phone/address) | Over-collection, exposure in lists/logs |
| Availability | Power cuts, PC failure, router resets |

Out of scope: nation-state attackers, internet-facing exposure (the system is never published to the internet, D-32).

## 2. Controls by layer

### 2.1 Network
- No port is exposed to the internet. Server firewall allows only 8080 (guest) and 8443 (staff) from the local subnet. PostgreSQL listens on `127.0.0.1` only.
- Guest and staff routes live on **separate listeners**; staff routes don't exist on 8080.
- Staff traffic is HTTPS with the shop certificate (D-39). Guest traffic is HTTP (residual risk SR-3).
- Router hardening checklist: LOCAL_LAN_HOSTING.md §3 (admin password changed, WPS off).

### 2.2 Identity & sessions
- Staff APIs require **registered device + user session**. Being on the Wi-Fi grants nothing.
- Passwords and PINs hashed with argon2id; lockouts on repeated failures; PINs work only on registered devices.
- Owner functions re-ask the owner's password. Owner recovery: printed one-time recovery code + `cl-admin recover-owner` run by a Windows administrator on the server PC. Both uses are audited.
- Lost or departed staff phone → manager revokes the device in the app (sessions end immediately) and the user's PIN is reset.

### 2.3 Authorisation & financial controls
- Every endpoint declares its permission; scope re-checked inside the database transaction (acceptance scope, own tables, discount limits).
- Step-up approval (approver PIN on the same device, approver ≠ requester) for discounts over limit, refunds, method corrections, reopen with payments, shift variance, count variance, voids after pickup by staff without that right.
- Append-only money, stock and audit tables; corrections are visible reversing entries. Settled invoices can't change.
- Retry-safe operations (idempotency keys + unique source keys) prevent duplicate payments or stock postings.

### 2.4 Application
- Server-side prices, totals and table resolution; input validated against strict schemas; parameterised SQL only.
- XSS: React escaping, strict Content-Security-Policy, user text rendered as text; printer output strips control characters.
- CSRF: `SameSite=Strict` cookies + required header + Origin check.
- Card data: no card-number fields; references that look like card numbers are refused.
- Kitchen tickets and kitchen views never include prices (structural + tested).
- Rate limits on guest endpoints and logins.

### 2.5 Server PC
- Standard (non-admin) `Counter` Windows account for daily use; owner keeps the administrator password.
- Services under dedicated low-privilege virtual accounts; config folder ACL-restricted; secrets (database passwords) encrypted with Windows DPAPI; the mailbox app password sealed in the database with AES-256-GCM under a key file in the protected config folder (P6-4, step 6.6), so database backups hold it only encrypted.
- No browsing, e-mail, file sharing or extra software on the server PC (D-34 makes this essential).
- Microsoft Defender on; USB autorun off.
- No full-disk encryption (no TPM; would block unattended restart). **Backups are always encrypted** with a key the PC can't decrypt.

### 2.6 Data protection & privacy
- Delivery customer fields optional (D-05) and masked in lists (`03xx-xxx-1234`).
- Delivery PII redacted after `privacy.delivery_pii_retention_months` (12, D-25) by the nightly worker (04:20, step 5.6); transactional records kept (AT-105).
- Logs contain IDs and correlation IDs, never passwords, PINs, tokens or customer phone numbers.
- Exports are permission-checked and audited.

### 2.7 Supply chain & updates
- Dependencies pinned (lockfile); `pnpm audit` in CI; Node, Electron and PostgreSQL versions pinned per release.
- Installer built reproducibly in CI. No runtime downloads, no auto-update.
- Electron: context isolation, sandbox, no Node in the renderer, navigation locked to the server address, certificate pinned to the shop root.

## 3. Audit trail

Audited actions (actor, device, time, before/after, reason, approver): logins and lockouts; user/role/permission/device changes; price, menu, recipe, promotion changes; round accept/reject; voids, comps, discounts; bill lock/reopen; payments, refunds, corrections; cash shifts; stock receipts, waste, counts, adjustments; ledger, expenses, assets; settings; exports and schedules; backups and restores; reprints; table assignments. The audit table is append-only (trigger + database privileges). The owner can browse it by user, entity and date.

## 4. Risk register

| ID | Risk | Likelihood | Impact | Treatment | Owner decision |
|---|---|---|---|---|---|
| SR-1 | **Unpatched Windows 10** on the server, reachable from guest Wi-Fi | Medium | High | Firewall allow-list (2 ports), no browsing/e-mail, standard user account, Defender, no RDP/sharing; plan replacement PC | **Accepted (D-34)** |
| SR-2 | **Power cuts without UPS**: full outage; possible loss of last writes if the SSD caches them | High | High | Safe `wal_sync_method`/write-cache setting tested with `pg_test_fsync`; WAL archive to USB every 5 min; auto-restart; clock check; paper fallback pad | **Accepted (D-35)** |
| SR-3 | Guests on plain HTTP: another guest on the same Wi-Fi could capture a guest cookie | Low | Low | Cookie bound to one visit; customer API can only view that visit and submit orders that **still need staff approval**; staff can reset guests | Accept (proposed) |
| SR-4 | Shared Wi-Fi password known to guests | High (by design) | Medium | Staff access needs registered device + login + HTTPS; router admin password changed | Accepted (D-11) |
| SR-5 | Physical access to the counter PC (no disk encryption) | Medium | High | `Counter` standard account; owner admin password; PC physically at the staffed counter; encrypted backups | Accept (proposed) |
| SR-6 | Lost personal phone with staff app | Medium | Medium | PIN auto-lock after 5 min idle; device revocation; 12 h device session | Accept (proposed) |
| SR-7 | Staff collusion on discounts/voids/refunds | Medium | Medium | Limits, step-up approvals, segregation of duties, audit + exception reports | Mitigated |
| SR-8 | Clock reset after power cut breaks business dates | Medium | Medium | Startup clock check; running clock-jump alert | Mitigated |
| SR-9 | USB backup drive removed or full → WAL piles up on the 128 GB SSD | Medium | High | Archive failure alert on health page + banner; disk-space alerts; nightly check | Mitigated |
| SR-10 | ISP resets the router → isolation turned on / settings lost | Medium | Medium | Server IP set on the PC; re-apply checklist; troubleshooting guide | Mitigated |
| SR-11 | Old iMac hardware failure | Medium | High | Tested restore onto another Windows PC before go-live; installer + latest backup on USB | Mitigated |

## 5. Incident playbooks (short)

| Incident | Immediate steps |
|---|---|
| Staff phone lost | Manager: Devices → revoke. Reset that user's PIN. Review audit for the last 24 h. |
| Suspected misuse (discounts/refunds) | Owner: audit log filter by user + exception report; revoke permissions; keep records (never delete). |
| Server PC won't boot | Follow BACKUP_RECOVERY.md §5 (restore to another PC). Use paper pad meanwhile. |
| Malware suspected on server PC | Disconnect Ethernet; switch to paper pad; restore onto a clean PC from the last good encrypted backup. |
| Backup drive lost | Data is encrypted. Rotate the backup key at the next maintenance visit; replace the drive. |
