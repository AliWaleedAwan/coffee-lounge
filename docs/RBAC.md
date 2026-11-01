# Coffee Lounge — Permission Catalog & Default Roles (Phase 1, package 1A)

> Design specification for review R1. Seeded into `cl.permissions` / `cl.role_permissions` by migration. Enforcement: every API route declares its permission; the service re-checks scope inside the transaction. The UI only hides what the user can't use. Phase 0 background: `docs/phase-0/07-rbac-security.md`.

## 1. Rules

1. **Effective permissions** = union of role grants + user override grants − user override denies. **Deny always wins.**
2. **Protected (🔒)** permissions are owner-only and can't be granted to any other role or user.
3. **Scopes** narrow a permission:
   - `acceptance`: owner/manager = all rounds; waiter = assigned tables; cashier = takeaway, delivery, unassigned tables, escalated rounds (D-07, D-36).
   - `own_tables`: waiter limited to tables currently assigned to them.
   - `limit`: discount ceiling from `role_discount_limits` (PROVISIONAL D-14: cashier 10 %, manager 20 %).
   - `own_shift`: cashier sees/acts on their own cash shift only.
4. **Step-up approval** (approver enters PIN on the same device; approver ≠ requester): discount above limit, refund, payment method correction, bill reopen after a payment, cash shift variance, count variance above threshold (D-18), void after pickup by a role without `orders.void_prepared`.
5. **Kitchen role** stays in the catalog but has no users while there is no kitchen device (D-33).
6. Riders are **not users** (D-41); they're `staff_profiles` chosen by staff.

Legend: ✔ default grant · ○ grantable by owner (off by default) · ✕ not grantable · 🔒 owner-only · S scoped (see §1.3)

## 2. Catalog and defaults

| Permission | Description | Owner | Manager | Waiter | Cashier | Inv. clerk | Kitchen* |
|---|---|---|---|---|---|---|---|
| **Orders & tables** | | | | | | | |
| `tables.read` | Floor plan, table states | ✔ | ✔ | ✔ | ✔ | ✕ | ✕ |
| `tables.manage` | Tables, layout, QR codes (incl. counter QR), regenerate tokens | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `tables.assign` | Assign/unassign waiters to tables | ✔ | ✔ | ○ (claim unassigned) | ✔ | ✕ | ✕ |
| `sessions.transfer` | Move a session to another table | ✔ | ✔ | ○ | ○ | ✕ | ✕ |
| `sessions.reset_guests` | Revoke guest phones on a table | ✔ | ✔ | ✔ S own_tables | ✔ | ✕ | ✕ |
| `orders.create` | Enter staff rounds (go straight to kitchen) | ✔ | ✔ | ✔ | ✔ | ✕ | ✕ |
| `orders.accept` | Accept/reject QR rounds | ✔ | ✔ | ✔ S acceptance | ✔ S acceptance | ✕ | ✕ |
| `orders.serve` | Mark served/collected | ✔ | ✔ | ✔ | ✔ | ✕ | ○ |
| `orders.void` | Cancel quantity not yet made | ✔ | ✔ | ✔ S own_tables | ✔ | ✕ | ✕ |
| `orders.void_prepared` | Void made/picked-up items as waste | ✔ | ✔ | ✕ (step-up) | ○ | ✕ | ✕ |
| `orders.read_all` | See all sessions and rounds | ✔ | ✔ | ○ | ✔ | ✕ | ✕ |
| **Kitchen** | | | | | | | |
| `kitchen.pickup` | **Picked up** = prepared = stock consumption (D-33) | ✔ | ✔ | ✔ | ✔ | ✕ | ✔ |
| `kitchen.read` | Ticket queue view (never prices) | ✔ | ✔ | ✔ | ✔ | ✕ | ✔ |
| `kitchen.reprint` | Reprint kitchen ticket (labelled) | ✔ | ✔ | ○ | ✔ | ✕ | ✔ |
| `kitchen.templates.manage` | Edit ticket templates | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| **Delivery** | | | | | | | |
| `delivery.create` | Enter delivery orders | ✔ | ✔ | ○ | ✔ | ✕ | ✕ |
| `delivery.dispatch` | Assign rider, dispatch | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ |
| `delivery.record_return` | Record delivered/failed + COD/card handover | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ |
| `delivery.resolve_failed` | Re-attempt / convert / cancel failed delivery | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `riders.manage` | Rider profiles | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| **Billing & cash** | | | | | | | |
| `invoices.read` | View bills | ✔ | ✔ | ✔ S own_tables | ✔ | ✕ | ✕ |
| `invoices.lock` | Prepare (lock) bill | ✔ | ✔ | ○ | ✔ | ✕ | ✕ |
| `invoices.reopen` | Reopen locked bill | ✔ | ✔ | ✕ | ○ | ✕ | ✕ |
| `discounts.apply` | Manual line/bill discount with reason | ✔ | ✔ S limit | ✕ | ✔ S limit | ✕ | ✕ |
| `discounts.comp` | Comp an item (100 %) | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `payments.collect` | Cash / card / transfer payments | ✔ | ✔ | ○ | ✔ | ✕ | ✕ |
| `payments.refund_request` | Request a refund/correction | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ |
| `payments.refund` | Approve refunds/method corrections (step-up) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `receipts.reprint` | Reprint receipt (labelled) | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ |
| `cash_shifts.operate` | Open/close own shift, paid-in/out | ✔ | ✔ | ✕ | ✔ S own_shift | ✕ | ✕ |
| `cash_shifts.approve_variance` | Approve shift variance | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| **Menu & recipes** | | | | | | | |
| `menu.read` | Staff menu with prices | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `menu.manage` | Items, variants, modifiers | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `menu.price_change` | Change prices | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `menu.availability_toggle` | Mark item temporarily unavailable | ✔ | ✔ | ○ | ✔ | ✔ | ✔ |
| `promotions.manage` | Scheduled promotions | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `recipes.read` | View recipes | ✔ | ✔ | ✕ | ✕ | ✔ | ✔ |
| `recipes.manage` | Draft/activate recipe versions (D-29: clerk enters weekly) | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| **Inventory & purchasing** | | | | | | | |
| `inventory.read` | Quantities, lots, movements | ✔ | ✔ | ✕ | ✕ | ✔ | ✕ |
| `inventory.cost_view` | Costs and stock values | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `inventory.items_manage` | Items, pack sizes, barcodes, thresholds | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| `inventory.stock_control_activate` | Switch stock control on for an item (D-29) | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| `inventory.receive` | Post purchase receipts | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| `inventory.waste` | Record ingredient waste | ✔ | ✔ | ✕ | ✕ | ✔ | ○ |
| `inventory.count` | Count and submit | ✔ | ✔ | ✕ | ✕ | ✔ | ✕ |
| `inventory.count_approve` | Approve variances above threshold | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `inventory.opening_balance` | Post opening balances | ✔ | ✕ | ✕ | ✕ | ○ | ✕ |
| `inventory.cost_adjust` | Supplier price corrections | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `purchases.manage` | Draft receipts, supplier links | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| `suppliers.manage` | Supplier records | ✔ | ○ | ✕ | ✕ | ✔ | ✕ |
| **Finance & assets** | | | | | | | |
| `ledger.read` | View ledger | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `ledger.manage` | Manual entries and reversals (never edits, D-31) | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `expenses.read` | Expenses | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `expenses.manage` | Expenses | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `assets.read` | Asset register | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `assets.manage` | Asset register | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| **Reports** | | | | | | | |
| `reports.sales` | Sales reports | ✔ | ✔ | ✕ | ○ (own shift) | ✕ | ✕ |
| `reports.profit` | COGS, margins, operating result | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `reports.inventory` | Usage, waste, expiry, COGS coverage | ✔ | ✔ | ✕ | ✕ | ✔ | ✕ |
| `reports.staff` | Staff activity | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `reports.export` | CSV/PDF (also needs the report's own permission) | ✔ | ○ | ✕ | ✕ | ○ | ✕ |
| `reports.schedule` | Scheduled e-mails | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| **Administration** | | | | | | | |
| `users.manage` | Non-owner users, PIN resets | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `roles.manage` 🔒 | Roles, grants, overrides | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ |
| `devices.manage` | Register/revoke devices (incl. personal phones) | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `settings.manage` | Operational settings, branding | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `settings.financial` 🔒 | Business day, rounding, tax, costing parameters | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ |
| `settings.mailbox` 🔒 | The shop's mailbox for scheduled e-mails (address, app password) | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ |
| `printers.manage` | Printer setup, test print | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `drawer.open` | Open the cash drawer by hand (each open is in the audit log) | ✔ | ✔ | ✕ | ✔ | ✕ | ✕ |
| `audit.read` | Audit log | ✔ | ○ | ✕ | ✕ | ✕ | ✕ |
| `system.health` | Diagnostics page | ✔ | ✔ | ✕ | ✕ | ✕ | ✕ |
| `backup.manage` | Run/download backups | ✔ | ✕ | ✕ | ✕ | ✕ | ✕ |
| `backup.restore` 🔒 | Restore | 🔒 | ✕ | ✕ | ✕ | ✕ | ✕ |

\* Kitchen role: no users at launch (D-33).

Not in the launch catalog: `cash_drawer.no_sale` (no drawer, D-03). It will be added if a drawer is connected.

## 3. Guest (customer) capabilities

Guests are not users. Their API is a separate route set on the customer listener, scoped by the guest token to **one** session:

| Capability | Table QR guest | Counter-QR guest |
|---|---|---|
| View menu & availability | ✔ (dine-in eligible items) | ✔ (takeaway eligible items) |
| Submit round (pending approval) | ✔ | ✔ (unpaid; pay at counter) |
| Withdraw own pending round | ✔ | ✔ |
| See rounds and statuses of this session | ✔ (all rounds of the table, PROVISIONAL D-09) | ✔ (own order only) |
| Request bill / see total | ✔ | — (pays first) |
| Anything else | ✕ | ✕ |

## 4. Sessions and device rules (PROVISIONAL D-24, confirmed D-39)

| Device | Login | Idle behaviour | Notes |
|---|---|---|---|
| Counter PC (Electron) | Password on first login per shift; PIN quick-switch between cashier, manager, clerk (D-38) | Auto-lock to PIN after 10 min idle | Owner functions always re-ask the owner password |
| Shop tablets | Registered device + PIN | Auto-lock to PIN after 5 min idle | Shop certificate installed |
| Personal phones | Registered device + PIN | Auto-lock after 5 min idle; device session 12 h | Certificate installed (D-39); revocable instantly; manager/cashier/owner logins only on certificate-trusted devices |
| Any unregistered browser | Refused for all staff APIs | — | Being on the Wi-Fi grants nothing |

## 5. Segregation of duties (enforced by constraints/services)

| Rule | Enforced by |
|---|---|
| Refund approver ≠ requester | `refunds` CHECK |
| Step-up approver ≠ requester | `step_up_approvals` CHECK |
| Shift variance approver ≠ cashier | `cash_shifts` CHECK |
| Count approver ≠ submitter | `stock_counts` CHECK |
| At least one active owner always | Trigger on users/roles |
| Owner-only permissions can't be granted | Service + seed (`is_protected`) |
