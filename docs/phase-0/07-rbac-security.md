# 07 — Permissions (RBAC) & Security

> Phase 0 · Proposed defaults. The owner can change role grants (except protected and structural limits). Every permission is enforced **server-side** in the route guard **and** re-checked in the service for sensitive operations. The frontend only hides what the user can't use.

## 7.1 Authorisation model

- **Effective permissions** = ∪(role grants) + user override grants − user override denies (**deny wins**).
- **Scopes:** some permissions carry a scope. `orders.void:own_tables` vs `orders.void:any`; `discounts.apply` with a max % / max amount per role.
- **Protected (🔒) permissions** can only be held by owners and can't be delegated: managing roles, owner accounts, restoring backups, changing financial settings (business-day cutoff, rounding, tax config, costing method).
- **Structural limits (✕):** the owner can't grant these because they'd break a design rule. Example: the Kitchen role can never be granted price/payment visibility on KDS views, because kitchen endpoints don't return prices at all.
- **Step-up approval:** an action above a user's limit opens a sheet where an authorised approver enters their PIN **on the same device**. The approval is recorded (`step_up_approvals`) and linked to the action. Approver ≠ requester is enforced.
- **Segregation of duties (defaults):** a cashier can't approve their own cash-shift variance; a refund requester can't approve their own refund; a stock count submitter can't approve their own variance above threshold.

## 7.2 Default permission matrix

Legend: **✔** granted by default · **○** grantable (off by default) · **✕** not grantable · **🔒** owner-only, protected · **S** scoped (see note)

| Permission | Owner | Manager | Waiter | Cashier | Kitchen | Inv. clerk | Customer |
|---|---|---|---|---|---|---|---|
| **Menu & recipes** | | | | | | | |
| `menu.read` (staff view incl. prices) | ✔ | ✔ | ✔ | ✔ | ✕ | ✔ | (public menu only) |
| `menu.manage` (items, variants, modifiers) | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| `menu.price_change` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `menu.availability_toggle` (86 an item) | ✔ | ✔ | ○ | ○ | ✔ | ✔ | ✕ |
| `recipes.read` | ✔ | ✔ | ✕ | ✕ | ✔ (prep details) | ✔ | ✕ |
| `recipes.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| `promotions.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| **Tables & orders** | | | | | | | |
| `tables.read` | ✔ | ✔ | ✔ | ✔ | ✕ | ✕ | own table |
| `tables.manage` (layout, QR regenerate) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `sessions.transfer` (move table) | ✔ | ✔ | ○ | ○ | ✕ | ✕ | ✕ |
| `sessions.reset_guests` | ✔ | ✔ | ✔ | ✔ | ✕ | ✕ | ✕ |
| `orders.create` | ✔ | ✔ | ✔ | ✔ | ✕ | ✕ | own session (pending only) |
| `orders.accept` / `orders.reject` (decided D-07) | ✔ any | ✔ any | ✔ S assigned tables only | ✔ S takeaway, delivery, unassigned tables (+ escalated, D-36) | ✕ | ✕ | ✕ |
| `orders.void` (before ready) | ✔ | ✔ | S own tables | ✔ | ✕ | ✕ | ✕ |
| `orders.void_prepared` (waste after ready) | ✔ | ✔ | ✕ | ○ | ○ | ✕ | ✕ |
| **Kitchen** | | | | | | | |
| `kitchen.read` (no prices, ever) | ✔ | ✔ | ✔ (status) | ○ | ✔ | ✕ | ✕ |
| `kitchen.update` (start/ready/bump) | ✔ | ✔ | ✕ | ✕ | ✔ | ✕ | ✕ |
| `kitchen.reprint` | ✔ | ✔ | ✕ | ○ | ✔ | ✕ | ✕ |
| `kitchen.templates.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| **Checkout & cash** | | | | | | | |
| `invoices.read` | ✔ | ✔ | S own tables | ✔ | ✕ | ✕ | own bill total |
| `invoices.lock` | ✔ | ✔ | ○ | ✔ | ✕ | ✕ | ✕ |
| `invoices.reopen` | ✔ | ✔ | ✕ | ○ | ✕ | ✕ | ✕ |
| `discounts.apply` (within limit) | ✔ | ✔ S ≤ 20 % | ✕ | ✔ S ≤ 10 % | ✕ | ✕ | ✕ |
| `discounts.comp` | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `payments.collect` | ✔ | ✔ | ○ | ✔ | ✕ | ✕ | ✕ |
| `payments.refund` (+ step-up) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `payments.correct` (method correction) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `receipts.reprint` | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ | ✕ |
| `cash_drawer.no_sale` (with reason) | ✔ | ✔ | ✕ | ○ | ✕ | ✕ | ✕ |
| `cash_shifts.operate` (open/close own) | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ | ✕ |
| `cash_shifts.approve_variance` | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| **Inventory & purchasing** | | | | | | | |
| `inventory.read` (quantities) | ✔ | ✔ | ✕ | ✕ | ○ | ✔ | ✕ |
| `inventory.cost_view` | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| `inventory.items_manage` (create/archive items, barcodes) | ✔ | ○ | ✕ | ✕ | ✕ | ✔ | ✕ |
| `inventory.receive` | ✔ | ○ | ✕ | ✕ | ✕ | ✔ | ✕ |
| `inventory.waste` | ✔ | ✔ | ✕ | ✕ | ○ | ✔ | ✕ |
| `inventory.count` (submit) | ✔ | ✔ | ✕ | ✕ | ✕ | ✔ | ✕ |
| `inventory.count_approve` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `inventory.opening_balance` | ✔ | ✕ | ✕ | ✕ | ✕ | ○ | ✕ |
| `purchases.manage`, `suppliers.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ✔ | ✕ |
| **Finance & assets** | | | | | | | |
| `ledger.read` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `ledger.manage` (entries & reversals, never edits) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `expenses.read` / `expenses.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| `assets.read` / `assets.manage` | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| **Reports** | | | | | | | |
| `reports.sales` | ✔ | ✔ | ✕ | ○ (shift only) | ✕ | ✕ | ✕ |
| `reports.profit` (COGS, margins) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `reports.inventory` (usage, waste, expiry) | ✔ | ✔ | ✕ | ✕ | ✕ | ✔ | ✕ |
| `reports.staff` (activity) | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `reports.export` (CSV/PDF), checked per report | ✔ | ○ | ✕ | ✕ | ✕ | ○ | ✕ |
| `reports.schedule` (email) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| **Administration** | | | | | | | |
| `users.manage` (non-owner users) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `roles.manage` | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `devices.manage` (register/revoke) | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `settings.manage` (operational) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `settings.financial` | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `printers.manage` | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `audit.read` | ✔ | ○ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `system.health` | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `backup.manage` (run, download) | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `backup.restore` | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ | ✕ |

Default discount limits (10 % / 20 %) are placeholders for D-14.

**Updates from the 19 Oct 2026 decisions:**
- **Order acceptance scopes (D-07)** are enforced in the acceptance transaction against the current `table_assignments`, not by the UI queue.
- **Table assignment** needs a new permission, `tables.assign` (default: owner ✔, manager ✔, cashier ✔, waiter ○ "claim unassigned table").
- **Delivery:** `delivery.dispatch` and `delivery.record_return` (owner, manager, cashier ✔); `delivery.resolve_failed` (owner, manager ✔).
- **Riders** are staff profiles with **no login by default** (D-41). If a rider login is later enabled, it gets only "view my assigned deliveries".
- **Kitchen role:** keep it in the catalog; it is only used if a kitchen device is added (D-33).
- **No cash drawer:** `cash_drawer.no_sale` stays in the catalog but is hidden while no drawer is configured.

## 7.3 Authentication

| Item | Proposal |
|---|---|
| Passwords | argon2id; minimum 10 characters; no forced periodic rotation; lockout after 5 failures for 5 min (exponential); owner can reset other users' passwords (audited) |
| PIN quick-switch | 4–6 digit PIN, **only valid on a registered device** and only for switching users or step-up approvals; lockout after 5 failures; PIN alone never works from an unregistered browser |
| Device registration | Manager/owner registers a device once (QR/one-time code); the device gets a long-lived device token (httpOnly cookie). Staff endpoints require **device token + user session**. Being on the Wi-Fi gives nothing. |
| Sessions | Opaque server-side tokens, httpOnly, `Secure` (staff HTTPS), `SameSite=Strict`. Idle timeout: waiter 12 h device / user auto-lock after 5 min idle → PIN; reception 30 min → PIN; owner 30 min → password; KDS device session with kitchen role and no user-level sensitive actions |
| Owner recovery | At install, a one-time **recovery code** is generated and printed for the owner's safe. A host-local CLI (`coffeelounge-admin recover-owner`) requires Windows administrator rights on the host + the recovery code. Both uses are audited. |
| Account lifecycle | Users are disabled, never deleted (audit integrity); disabling revokes sessions immediately |

## 7.4 QR & customer-session security

- Table QR = `http://<host>:8080/t/<128-bit token>`. Only the SHA-256 hash is stored. Tokens are non-sequential, so table numbers can't be guessed. Owner can **regenerate** a table's token (old printed QR stops working).
- First visit issues a **guest token** (httpOnly cookie) bound to the *current* dining session. All customer API calls are scoped server-side to that session ID. There are no endpoints that accept a session or table ID from the customer.
- On settlement/cancellation, all guest tokens for that session are revoked. The next scan starts a new session (AT-12). Old URLs/tokens return "This visit has ended".
- Customer API surface is minimal: menu, availability, submit round, own rounds status, request bill, own bill total (D-09 decides whether line detail is shown to all joined devices).
- Abuse controls: per-token and per-IP rate limits, max pending rounds per session, note length limits, server-side price computation, staff approval gate (no unapproved order ever reaches the kitchen).
- Residual risk (documented): someone within Wi-Fi range with a photo of a table QR could submit a pending order to that table. Staff approval and the "reset guests" action mitigate this. A join code (D-09 alternative) removes it at the cost of friction.

## 7.5 Network & host hardening

- Guest and staff Wi-Fi are **not** separated (decided D-11). Customer listener exposes customer routes only.
- PostgreSQL listens on `127.0.0.1` only; `pg_hba.conf` allows only local connections with SCRAM-SHA-256.
- Windows Firewall: inbound 8080/8443 from LAN subnets only; everything else closed.
- Host (**decided: counter iMac, Windows 10 Pro N, no TPM**): no BitLocker on the OS disk because it would block unattended restarts (documented risk; backups are always encrypted). Staff use a standard non-admin Windows account; the admin account is owner-only. Microsoft Defender on. No browsing, e-mail or file sharing on this PC. Windows Update (or paid extended updates, D-34) with active hours covering trading time. Physical security at the counter.
- **Shared guest/staff Wi-Fi (decided):** nothing is trusted because of network location. Staff access requires a registered device + user login (+ HTTPS, D-39). The customer listener exposes customer routes only.
- Services run under a dedicated least-privilege account. Program files are read-only for that account; data dirs (`C:\ProgramData\CoffeeLounge`) are ACL-restricted.
- Secrets (DB password, SMTP credentials, backup public key path) are stored in a config file protected by ACL, with the SMTP password encrypted using **Windows DPAPI** (machine scope). They are never in the repo or `.env.example`.
- TLS: shop-local CA (offline root key exported to the owner's backup USB, not left on the host); server cert for the host IP/name; 2-year validity with renewal documented.

## 7.6 Application security

| Threat | Control |
|---|---|
| SQL injection | Parameterised queries only (Kysely); raw SQL fragments reviewed; no string-built SQL |
| XSS | React escaping; strict CSP (no inline script, self-only sources, no `eval`); notes/names rendered as text; ESC/POS renderer strips control characters from user text |
| CSRF | `SameSite=Strict` cookies + required custom header on mutations + `Origin` check |
| Mass assignment / tampering | Zod schemas whitelist fields; prices/totals/table IDs never accepted from clients |
| IDOR | Every query scoped by permission scope (own tables, own session, own shift) |
| Brute force | Login/PIN lockouts; rate limits on customer endpoints |
| Card data | No PAN/CVV fields exist. `card_reference` is validated to reject 13–19 digit sequences that pass a Luhn check |
| PII | Customer name/phone only where needed (takeaway/delivery); masked in lists; retention per D-25; logs contain IDs, not PII |
| Supply chain | Locked dependencies (pnpm lockfile), `pnpm audit` in CI, pinned Electron/Node versions, installer built reproducibly in CI, no runtime downloads |
| Electron | contextIsolation, sandbox, no nodeIntegration, CSP, origin-locked navigation, minimal preload API, auto-update **disabled** (updates via installer) |

## 7.7 Audit trail

**Always audited (actor, device, time, before/after, reason, approver, correlation ID):** login/logout/lockout; user, role and permission changes; device registration; price, menu, recipe and promotion changes; round accept/reject; voids, comps, discounts; bill lock/reopen; payments, refunds, payment corrections; drawer no-sale; cash shift open/close/variance approval; stock receipts, waste, counts, adjustments, opening balances; ledger entries/reversals, expenses, asset changes; settings changes; exports and report schedule changes; backup/restore actions; reprints.

- `audit_events` is append-only (trigger + DB privileges). Retention: indefinite (D-25).
- **OPTIONAL:** tamper-evidence hash chain (`hash = sha256(prev_hash || row)`), verified nightly, so after-the-fact edits by someone with DB superuser access are detectable.
- Audit viewer: filter by user, entity, action, date; entity pages show their own history timeline.
