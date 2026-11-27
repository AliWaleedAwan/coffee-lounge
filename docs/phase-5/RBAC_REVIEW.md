# RBAC hardening review (Phase 5 step 5.6)

> Roadmap §9 "RBAC hardening review". Done on 27 Oct 2026 against the code as built through Phase 5 step 5.6 (`phase-5/finance-oversight`). The tables in section 3 are generated from the running routes and the database by `apps/server/test/identity/rbac-review.test.ts`, which fails when they drift from the code.

## 1. How access is enforced

| Layer | What it guarantees | Where it is tested |
|---|---|---|
| Device registration | Every staff route except registering needs a registered, not revoked device (one-time codes, 10 min) | `route-matrix.test.ts` (device and session levels) |
| Session and idle lock | A user session per device; idle lock 5–10 min by device kind; sessions end when a user is disabled, reset or a device revoked | `http.test.ts`, `access.test.ts` |
| Route permission | Each route names one permission, checked before the handler (refusal audited, AT-18). **Every route × every role** is exercised | `route-matrix.test.ts` (SEC-ALL), table 3.A |
| Scope inside the service | Waiters only on their tables (`requireOwnTable`), a cashier sees their own shifts, costs only with `inventory.cost_view`, template imports check each file's own permission | domain tests (floor, billing, stock, imports) |
| Step-up approval | Approver ≠ requester, approver's PIN on the same device, approver's permission, 2 minutes, used once, attempts throttled | `billing`, `refunds`, `shifts`, `counts` tests; table 3.C |
| Database | Grants the RBAC.md ✕ forbids and owner-only (🔒) grants refused by trigger; at least one active owner; append-only tables (audit, payments, refunds, ledger, events…); final states frozen | `foundation.test.ts`, `access.test.ts`, domain tests |
| Audit | Every change with actor, device, before/after, reason, approver; readable with `audit.read` only | `access.test.ts` (AT-95) |

## 2. Findings and what was done

| # | Finding | Severity | Action |
|---|---|---|---|
| F-1 | A manager given `users.manage` could reset another manager's password **and PIN**, then use that account as the "someone else" in a step-up approval (refund, variance, void), defeating requester ≠ approver | High | **Fixed:** only an owner resets a manager, an owner, or anyone holding a granted override; a non-owner resets waiters, cashiers, clerks and kitchen staff only (`access.test.ts`) |
| F-2 | A PIN set by someone else (a reset or a new account) could approve at once | High | **Fixed:** an approver who must still change their password cannot approve; the account works for approvals once its owner has chosen their own password (`access.test.ts`). A new manager therefore logs in once before approving anything |
| F-3 | Rider profiles were guarded by `users.manage`, while RBAC.md gives `riders.manage` (owner ✔, manager ✔); managers could not add a rider | Medium (wrong key) | **Fixed:** `POST/PATCH /riders` need `riders.manage` (`delivery.test.ts`) |
| F-4 | Cash rounding and the stock-count approval thresholds could be changed with `settings.manage` (○ for managers), although RBAC.md puts money and control parameters under owner-only `settings.financial` 🔒 | Medium | **Fixed:** these settings need `settings.financial`; the screen shows them read-only to others (`access.test.ts`). The business day and time zone stay fixed at installation (D-22) |
| F-5 | An attached PDF bill was served inline: a document from outside opened inside the app's origin | Low | **Fixed:** PDFs are downloaded and opened by the PC's viewer; photos show inside the page under a sandboxing CSP with `nosniff`; types are taken from the file's bytes |
| F-6 | `users.manage`, if granted to a manager, lets them create people with any **non-owner** role (including another manager) | Accepted by design (RBAC.md "Non-owner users") | Recommendation: keep `users.manage` with the owner; if granted, check `user.create` in the audit log. Changing a person's roles later needs `roles.manage` 🔒 |
| F-7 | `POST /imports/{template}/apply` names `inventory.read`; each template checks its own permission (items, opening stock, menu, assets…) inside | Accepted | Covered by `import.test.ts` and `assets.test.ts` (clerk refused `09_assets.csv`) |
| F-8 | Closing or noting an inventory alert needs only `inventory.read` | Accepted | An alert closed while its cause remains is raised again by the next evaluation; the close is audited |
| F-9 | `POST /auth/step-up` is open to any logged-in user | Accepted | The approver's PIN, permission and the 20-per-10-minutes throttle decide; an approval is bound to the requester, device, action and record, and used once |
| F-10 | The counter app (Electron) blocks downloads and new windows, so a PDF bill cannot be opened there yet | Open (Phase 6) | Photos work everywhere; PDFs open from a browser on another device. A reviewed download path arrives with exports in Phase 6 |

Permissions in table 3.E that no route names are checked inside services (`inventory.cost_view`, `inventory.count_approve`, `inventory.opening_balance`, `inventory.stock_control_activate`, `orders.void_prepared`, `payments.refund` as step-up approvers), or belong to later phases (reports and exports in Phase 6, backups in Phase 7, `kitchen.templates.manage`, `purchases.manage`, `settings.financial` besides F-4).

## 3. As built

<!-- generated:start (rbac-review.test.ts) -->

### A. Every staff route (278)

Access: a permission key (checked before the handler, SEC-ALL), `session` (any logged-in user: their own data only), `device` (a registered device, before login), `public` (no device yet).

| Method | Path | Access |
|---|---|---|
| GET | `/access/catalog` | `users.manage` |
| POST | `/alerts/:id/acknowledge` | `reports.sales` |
| GET | `/approvals` | `orders.accept` |
| GET | `/assets` | `assets.read` |
| POST | `/assets` | `assets.manage` |
| GET | `/assets/:id` | `assets.read` |
| POST | `/assets/:id/changes` | `assets.manage` |
| POST | `/assets/:id/dispose` | `assets.manage` |
| POST | `/assets/:id/maintenance` | `assets.manage` |
| POST | `/assets/categories` | `assets.manage` |
| GET | `/assets/choices` | `assets.manage` |
| GET | `/assignable-staff` | `tables.assign` |
| GET | `/audit` | `audit.read` |
| GET | `/audit/filters` | `audit.read` |
| POST | `/auth/login` | device |
| POST | `/auth/logout` | session |
| GET | `/auth/me` | session |
| POST | `/auth/password` | session |
| POST | `/auth/pin` | session |
| POST | `/auth/pin-switch` | device |
| POST | `/auth/step-up` | session |
| GET | `/backup/offsite` | `backup.manage` |
| PUT | `/backup/offsite` | `backup.manage` |
| POST | `/backup/offsite/test` | `backup.manage` |
| GET | `/bills` | `invoices.read` |
| GET | `/branding` | session |
| GET | `/cash-shifts` | `cash_shifts.operate` |
| POST | `/cash-shifts` | `cash_shifts.operate` |
| GET | `/cash-shifts/:id` | `cash_shifts.operate` |
| POST | `/cash-shifts/:id/approve` | `cash_shifts.approve_variance` |
| POST | `/cash-shifts/:id/close` | `cash_shifts.operate` |
| POST | `/cash-shifts/:id/movements` | `cash_shifts.operate` |
| POST | `/cash-shifts/:id/report/reprint` | `cash_shifts.operate` |
| GET | `/cash-shifts/current` | `cash_shifts.operate` |
| GET | `/customers` | `delivery.create` |
| GET | `/customers/lookup` | `delivery.create` |
| GET | `/deliveries` | `delivery.create` |
| GET | `/deliveries/:id` | `delivery.create` |
| POST | `/deliveries/:id/dispatch` | `delivery.dispatch` |
| POST | `/deliveries/:id/resolve` | `delivery.resolve_failed` |
| POST | `/deliveries/:id/return` | `delivery.record_return` |
| GET | `/demo` | device |
| POST | `/demo/switch` | device |
| POST | `/demo/wipe` | session |
| GET | `/devices` | `devices.manage` |
| POST | `/devices/:deviceId/revoke` | `devices.manage` |
| POST | `/devices/register` | public |
| POST | `/devices/registration-codes` | `devices.manage` |
| POST | `/discounts/:id/void` | `discounts.apply` |
| GET | `/drawer` | `drawer.open` |
| GET | `/events` | session |
| GET | `/expense-categories` | `expenses.read` |
| POST | `/expense-categories` | `expenses.manage` |
| PATCH | `/expense-categories/:id` | `expenses.manage` |
| GET | `/expenses` | `expenses.read` |
| POST | `/expenses` | `expenses.manage` |
| GET | `/expenses/:id` | `expenses.read` |
| GET | `/expenses/:id/attachment` | `expenses.read` |
| PUT | `/expenses/:id/attachment` | `expenses.manage` |
| POST | `/expenses/:id/correct` | `expenses.manage` |
| POST | `/expenses/:id/void` | `expenses.manage` |
| GET | `/floor` | `tables.read` |
| POST | `/imports/:template/apply` | `inventory.read` |
| POST | `/imports/:template/preview` | `inventory.read` |
| POST | `/imports/old-pos/apply` | `settings.manage` |
| POST | `/imports/old-pos/preview` | `settings.manage` |
| GET | `/imports/templates` | `inventory.read` |
| GET | `/inventory/alerts` | `inventory.read` |
| POST | `/inventory/alerts/:id/acknowledge` | `inventory.read` |
| POST | `/inventory/alerts/:id/close` | `inventory.read` |
| POST | `/inventory/barcodes/:id/deactivate` | `inventory.items_manage` |
| GET | `/inventory/items` | `inventory.read` |
| POST | `/inventory/items` | `inventory.items_manage` |
| GET | `/inventory/items/:id` | `inventory.read` |
| PATCH | `/inventory/items/:id` | `inventory.items_manage` |
| POST | `/inventory/items/:id/archive` | `inventory.items_manage` |
| POST | `/inventory/items/:id/barcodes` | `inventory.items_manage` |
| GET | `/inventory/items/:id/movements` | `inventory.read` |
| POST | `/inventory/items/:id/pack-sizes` | `inventory.items_manage` |
| POST | `/inventory/lots/:id/expiry` | `inventory.items_manage` |
| GET | `/inventory/overview` | `inventory.read` |
| PATCH | `/inventory/pack-sizes/:id` | `inventory.items_manage` |
| GET | `/inventory/scan` | `inventory.read` |
| GET | `/inventory/waste` | `inventory.read` |
| POST | `/inventory/waste` | `inventory.waste` |
| POST | `/invoices/:id/comps` | `discounts.comp` |
| POST | `/invoices/:id/discounts` | `discounts.apply` |
| POST | `/invoices/:id/lock` | `invoices.lock` |
| POST | `/invoices/:id/payments` | `payments.collect` |
| POST | `/invoices/:id/receipt/reprint` | `receipts.reprint` |
| GET | `/invoices/:id/refunds` | `payments.refund_request` |
| POST | `/invoices/:id/refunds` | `payments.refund_request` |
| POST | `/invoices/:id/reopen` | `invoices.reopen` |
| GET | `/ledger` | `ledger.read` |
| POST | `/ledger/entries` | `ledger.manage` |
| POST | `/ledger/entries/:id/reverse` | `ledger.manage` |
| POST | `/lines/:id/cancel` | `orders.void` |
| POST | `/lines/:id/pickup` | `kitchen.pickup` |
| POST | `/lines/:id/serve` | `orders.serve` |
| POST | `/lines/:id/void` | `orders.void` |
| GET | `/mail/account` | `settings.mailbox` |
| PUT | `/mail/account` | `settings.mailbox` |
| POST | `/mail/test` | `settings.mailbox` |
| GET | `/menu` | `menu.read` |
| GET | `/menu-photos/:file` | `menu.read` |
| GET | `/menu/catalog` | `menu.manage` |
| POST | `/menu/categories` | `menu.manage` |
| PATCH | `/menu/categories/:id` | `menu.manage` |
| POST | `/menu/categories/:id/archive` | `menu.manage` |
| POST | `/menu/items` | `menu.manage` |
| PATCH | `/menu/items/:id` | `menu.manage` |
| POST | `/menu/items/:id/archive` | `menu.manage` |
| DELETE | `/menu/items/:id/photo` | `menu.manage` |
| PUT | `/menu/items/:id/photo` | `menu.manage` |
| POST | `/menu/items/:id/variants` | `menu.manage` |
| PATCH | `/menu/variants/:id` | `menu.manage` |
| POST | `/menu/variants/:id/archive` | `menu.manage` |
| POST | `/menu/variants/:id/availability` | `menu.availability_toggle` |
| POST | `/menu/variants/:id/price` | `menu.price_change` |
| GET | `/menu/variants/:id/price-history` | `menu.manage` |
| POST | `/modifier-groups` | `menu.manage` |
| PATCH | `/modifier-groups/:id` | `menu.manage` |
| POST | `/modifier-groups/:id/options` | `menu.manage` |
| PATCH | `/modifier-options/:id` | `menu.manage` |
| GET | `/operations` | `reports.sales` |
| GET | `/pickup` | `kitchen.pickup` |
| GET | `/print-jobs` | `kitchen.reprint` |
| POST | `/print-jobs/:id/resolve-uncertain` | `kitchen.reprint` |
| POST | `/print-jobs/:id/retry` | `kitchen.reprint` |
| GET | `/printers` | `printers.manage` |
| POST | `/printers` | `printers.manage` |
| PATCH | `/printers/:id` | `printers.manage` |
| POST | `/printers/:id/drawer/open` | `drawer.open` |
| POST | `/printers/:id/retry-all` | `kitchen.reprint` |
| POST | `/printers/:id/test` | `printers.manage` |
| GET | `/printers/detect` | `printers.manage` |
| GET | `/printers/status` | `kitchen.read` |
| POST | `/products` | `inventory.items_manage` |
| GET | `/products/by-item/:id` | `inventory.read` |
| POST | `/products/by-item/:id/price` | `menu.price_change` |
| GET | `/products/sell-scan` | `orders.create` |
| GET | `/promotions` | `promotions.manage` |
| POST | `/promotions` | `promotions.manage` |
| PATCH | `/promotions/:id` | `promotions.manage` |
| GET | `/purchase-receipts` | `inventory.read` |
| POST | `/purchase-receipts` | `inventory.receive` |
| GET | `/purchase-receipts/:id` | `inventory.read` |
| POST | `/purchase-receipts/:id/cost-corrections` | `inventory.cost_adjust` |
| POST | `/purchase-receipts/:id/returns` | `inventory.receive` |
| POST | `/purchase-receipts/:id/reverse` | `inventory.receive` |
| POST | `/qr-entry-points/generate` | `tables.manage` |
| GET | `/recipes` | `recipes.read` |
| POST | `/recipes/preview` | `recipes.read` |
| POST | `/recipes/rules` | `recipes.manage` |
| POST | `/recipes/rules/:id/retire` | `recipes.manage` |
| GET | `/recipes/variants/:id` | `recipes.read` |
| POST | `/recipes/variants/:id/draft` | `recipes.manage` |
| POST | `/recipes/variants/:id/stock-mode` | `recipes.manage` |
| PUT | `/recipes/versions/:id` | `recipes.manage` |
| POST | `/recipes/versions/:id/activate` | `recipes.manage` |
| POST | `/refunds/:id/slip/reprint` | `payments.refund_request` |
| GET | `/refunds/bills` | `payments.refund_request` |
| GET | `/report-deliveries` | `reports.schedule` |
| POST | `/report-deliveries/:id/retry` | `reports.schedule` |
| GET | `/report-schedules` | `reports.schedule` |
| POST | `/report-schedules` | `reports.schedule` |
| PUT | `/report-schedules/:id` | `reports.schedule` |
| GET | `/reports` | session |
| GET | `/reports/audit-log` | `audit.read` |
| GET | `/reports/audit-log/export` | `audit.read` + `reports.export` |
| GET | `/reports/bill-lines` | `reports.sales` |
| GET | `/reports/bill-lines/export` | `reports.sales` + `reports.export` |
| GET | `/reports/bills` | `reports.sales` |
| GET | `/reports/bills/export` | `reports.sales` + `reports.export` |
| GET | `/reports/day-end` | `reports.sales` |
| GET | `/reports/day-end/export` | `reports.sales` + `reports.export` |
| POST | `/reports/day-end/print` | `reports.sales` |
| GET | `/reports/deliveries` | `reports.sales` |
| GET | `/reports/deliveries/export` | `reports.sales` + `reports.export` |
| GET | `/reports/discounts` | `reports.sales` |
| GET | `/reports/discounts/export` | `reports.sales` + `reports.export` |
| GET | `/reports/expenses` | `expenses.read` |
| GET | `/reports/expenses/export` | `expenses.read` + `reports.export` |
| GET | `/reports/inventory-usage` | `reports.inventory` |
| GET | `/reports/inventory-usage/export` | `reports.inventory` + `reports.export` |
| GET | `/reports/ledger` | `ledger.read` |
| GET | `/reports/ledger/export` | `ledger.read` + `reports.export` |
| GET | `/reports/menu-engineering` | `reports.profit` |
| GET | `/reports/menu-engineering/export` | `reports.profit` + `reports.export` |
| GET | `/reports/old-pos` | `reports.sales` |
| GET | `/reports/operating-result` | `reports.profit` |
| GET | `/reports/operating-result/export` | `reports.profit` + `reports.export` |
| GET | `/reports/overview` | `reports.sales` |
| GET | `/reports/payment-mix` | `reports.sales` |
| GET | `/reports/payment-mix/export` | `reports.sales` + `reports.export` |
| GET | `/reports/purchases` | `reports.inventory` |
| GET | `/reports/purchases/export` | `reports.inventory` + `reports.export` |
| GET | `/reports/sales-by-category` | `reports.sales` |
| GET | `/reports/sales-by-category/export` | `reports.sales` + `reports.export` |
| GET | `/reports/sales-by-day` | `reports.sales` |
| GET | `/reports/sales-by-day/export` | `reports.sales` + `reports.export` |
| GET | `/reports/sales-by-hour` | `reports.sales` |
| GET | `/reports/sales-by-hour/export` | `reports.sales` + `reports.export` |
| GET | `/reports/sales-by-item` | `reports.sales` |
| GET | `/reports/sales-by-item/export` | `reports.sales` + `reports.export` |
| GET | `/reports/staff` | `reports.sales` |
| GET | `/reports/staff-activity` | `reports.staff` |
| GET | `/reports/staff-activity/export` | `reports.staff` + `reports.export` |
| GET | `/reports/stock-counts` | `reports.inventory` |
| GET | `/reports/stock-counts/export` | `reports.inventory` + `reports.export` |
| GET | `/reports/stock-on-hand` | `reports.inventory` |
| GET | `/reports/stock-on-hand/export` | `reports.inventory` + `reports.export` |
| GET | `/reports/waste` | `reports.inventory` |
| GET | `/reports/waste/export` | `reports.inventory` + `reports.export` |
| GET | `/riders` | `delivery.dispatch` |
| POST | `/riders` | `riders.manage` |
| PATCH | `/riders/:id` | `riders.manage` |
| DELETE | `/roles/:roleKey/permissions/:permissionKey` | `roles.manage` |
| PUT | `/roles/:roleKey/permissions/:permissionKey` | `roles.manage` |
| POST | `/rounds/:id/accept` | `orders.accept` |
| POST | `/rounds/:id/accept-and-pay` | `payments.collect` |
| POST | `/rounds/:id/reject` | `orders.accept` |
| GET | `/sessions` | `orders.read_all` |
| GET | `/sessions/:id` | `tables.read` |
| GET | `/sessions/:id/bill` | `invoices.read` |
| POST | `/sessions/:id/bill-request` | `invoices.read` |
| POST | `/sessions/:id/cancel` | `orders.void` |
| POST | `/sessions/:id/reset-guests` | `sessions.reset_guests` |
| POST | `/sessions/:id/rounds` | `orders.create` |
| POST | `/sessions/:id/transfer` | `sessions.transfer` |
| POST | `/sessions/delivery` | `delivery.create` |
| POST | `/sessions/takeaway` | `orders.create` |
| GET | `/settings` | `settings.manage` |
| PATCH | `/settings/:key` | `settings.manage` |
| PUT | `/settings/branding` | `settings.manage` |
| GET | `/settings/receipt-design` | `settings.manage` |
| PUT | `/settings/receipt-design` | `settings.manage` |
| POST | `/settings/receipt-design/preview` | `settings.manage` |
| PUT | `/stations/:id/printer` | `printers.manage` |
| GET | `/stock-counts` | `inventory.read` |
| POST | `/stock-counts` | `inventory.count` |
| GET | `/stock-counts/:id` | `inventory.read` |
| POST | `/stock-counts/:id/approve` | `inventory.count` |
| POST | `/stock-counts/:id/cancel` | `inventory.count` |
| POST | `/stock-counts/:id/lines` | `inventory.count` |
| DELETE | `/stock-counts/:id/lines/:lineId` | `inventory.count` |
| POST | `/stock-counts/:id/send-back` | `inventory.count` |
| POST | `/stock-counts/:id/submit` | `inventory.count` |
| GET | `/suppliers` | `inventory.read` |
| POST | `/suppliers` | `suppliers.manage` |
| PATCH | `/suppliers/:id` | `suppliers.manage` |
| GET | `/system/backup-status` | session |
| GET | `/system/health` | `system.health` |
| GET | `/system/update` | `system.update` |
| POST | `/system/update` | `system.update` |
| POST | `/system/update/check` | `system.update` |
| GET | `/tables` | `tables.manage` |
| POST | `/tables` | `tables.manage` |
| PATCH | `/tables/:id` | `tables.manage` |
| POST | `/tables/:id/archive` | `tables.manage` |
| DELETE | `/tables/:id/assignment` | `tables.assign` |
| PUT | `/tables/:id/assignment` | `tables.assign` |
| POST | `/tables/:id/sessions` | `orders.create` |
| GET | `/takeaway/queue` | `orders.accept` |
| GET | `/tickets/:id` | `kitchen.read` |
| POST | `/tickets/:id/pickup` | `kitchen.pickup` |
| POST | `/tickets/:id/reprint` | `kitchen.reprint` |
| POST | `/tickets/:id/start` | `kitchen.pickup` |
| PUT | `/tills/:id/printer` | `printers.manage` |
| GET | `/users` | `users.manage` |
| POST | `/users` | `users.manage` |
| POST | `/users/:userId/credentials` | `users.manage` |
| GET | `/users/:userId/effective-permissions` | `users.manage` |
| GET | `/users/:userId/permission-overrides` | `users.manage` |
| DELETE | `/users/:userId/permission-overrides/:permissionKey` | `roles.manage` |
| PUT | `/users/:userId/permission-overrides/:permissionKey` | `roles.manage` |
| PUT | `/users/:userId/roles` | `roles.manage` |
| POST | `/users/:userId/status` | `users.manage` |

### B. ○ grants: what the owner may give each role (RBAC.md)

| Role | May be given |
|---|---|
| manager | `assets.manage`, `assets.read`, `audit.read`, `expenses.manage`, `expenses.read`, `inventory.cost_view`, `inventory.count_approve`, `inventory.items_manage`, `inventory.receive`, `inventory.stock_control_activate`, `kitchen.templates.manage`, `ledger.manage`, `ledger.read`, `menu.manage`, `menu.price_change`, `payments.refund`, `promotions.manage`, `purchases.manage`, `recipes.manage`, `reports.export`, `reports.profit`, `reports.schedule`, `settings.manage`, `suppliers.manage`, `tables.manage`, `users.manage` |
| waiter | `delivery.create`, `invoices.lock`, `kitchen.reprint`, `menu.availability_toggle`, `orders.read_all`, `payments.collect`, `sessions.transfer`, `tables.assign` |
| cashier | `invoices.reopen`, `orders.void_prepared`, `reports.sales`, `sessions.transfer` |
| inventory_clerk | `assets.manage`, `assets.read`, `expenses.manage`, `expenses.read`, `inventory.cost_view`, `inventory.opening_balance`, `menu.manage`, `reports.export` |
| kitchen | `inventory.waste`, `orders.serve` |

### C. Step-up actions (approver ≠ requester, same device, 2 minutes, used once)

| Action | Approver needs |
|---|---|
| `discount.over_limit` | `discounts.apply` |
| `refund.approve` | `payments.refund` |
| `payment.correct` | `payments.refund` |
| `invoice.reopen_with_payments` | `invoices.reopen` |
| `shift.variance` | `cash_shifts.approve_variance` |
| `count.variance` | `inventory.count_approve` |
| `line.void_prepared` | `orders.void_prepared` |

### D. Owner-only (🔒) permissions

`backup.restore`, `roles.manage`, `settings.financial`, `settings.mailbox`, `system.update`

### E. Permissions no route names (checked inside services, or for later phases)

`backup.restore`, `inventory.cost_view`, `inventory.count_approve`, `inventory.opening_balance`, `inventory.stock_control_activate`, `kitchen.templates.manage`, `orders.void_prepared`, `payments.refund`, `purchases.manage`, `settings.financial`

<!-- generated:end -->
