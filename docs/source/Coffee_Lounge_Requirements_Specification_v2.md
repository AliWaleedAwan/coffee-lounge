# COFFEE LOUNGE
## Software Requirements Specification (SRS) — Package 3 Complete Suite

| Document control | Value |
|---|---|
| Document ID | CL-SRS-002 |
| Version | 2.0 — decision-integrated draft |
| Date | 18 October 2026 |
| Status | **Draft for client/architect sign-off; not implementation-approved** |
| Scope | Single-location, offline-first Coffee Shop POS & Management System |
| Reference | EEREL Quotation ERL-2608-0144, dated 31 August 2026; client project brief; confirmed decision checklist |

> **Purpose and source boundary.** This document consolidates the selected **Package 3 — Complete Suite** quotation with subsequent client requirements and decisions. Features marked **[Q]** are stated in the quotation; **[C]** are later client-requested requirements or confirmed choices; **[R]** are professional recommendations pending business approval; **[TBD]** need a documented decision. A feature tagged [R] is **not** automatically a paid-scope commitment. The quotation total was **PKR 125,000 excluding applicable taxes**, with physical hardware, domain and hosting not included; the quotation listed validity through **30 September 2026**, so commercial scope/pricing should be reconfirmed before contractual sign-off.

---

# 1. Product charter

**Product vision.** A centrally managed, premium, reliable, offline-first application allowing Coffee Lounge staff to run one coffee shop even without internet, while providing the owner accurate control of orders, kitchen production, inventory, costs, assets, sales, expenses, and reports.

**Primary outcomes:**
1. Reduce order-taking and checkout friction across QR, waiter, reception, and kitchen workflows.
2. Prevent double orders, duplicated inventory deduction, inaccurate bills, and untraceable stock changes.
3. Calculate recipe-based ingredients and credible profitability using explicitly defined costing rules.
4. Give the owner appropriate controls, insights, alerts, auditability, and export/reporting functionality.
5. Run predictably on a local network with a Windows host and browser-connected tablets/phones.
6. Deliver production-grade installation, service recovery, backup/restore, documentation, and staff usability.

**Business scope:** one business, one physical location, one operational database. Do not create tenants, organizations, or branch management merely to anticipate hypothetical future branches. Keep architectural boundaries extensible without introducing unused business complexity.

## 1.1 Package inclusion traceability

| Quote work item | Baseline | Note |
|---|---|---|
| Figma UI/UX, responsive dashboards/customer interface | [Q] | High-fidelity designs and developer handoff |
| Customer menu with dine-in/takeaway/QR | [Q] | Delivery also stated in quote's additional features |
| Three synchronized waiter terminals | [Q] | Three is baseline terminal count, not a hard-coded software ceiling |
| Kitchen Display System and KOT | [Q] | Real-time preparation statuses |
| Owner reporting and manager dashboard | [Q] | Permissions shape visibility |
| Role and permission management | [Q] | Per-role and individual access |
| Thermal printers and compatible POS hardware | [Q] | Hardware is client-supplied; models pending |
| Backend, authentication, database, deployment, testing | [Q] | Local Windows topology is subsequent specific requirement |
| Inventory, recipes, consumption, wastage, alerts | [Q] | Package 3 includes Inventory add-on |
| Digital financial ledger/resource management | [Q] | Package 3 includes Ledger add-on |
| Menu variants/modifiers, promotions, discounting | [Q] | Include in design/testing |
| Auditing, backup, responsive device support | [Q] | Include backup verification and recovery procedures |
| Barcode scanning; lot/expiry detail; excess stock detection | [C] | Expanded functional specificity |
| Offline LAN, Windows/Electron installer and autostart | [C] | Deployment and architecture require sign-off |
| Scheduled email PDF; CSV export; richer profit reporting | [C] | Internet email queues; detailed definitions required |
| Purchase orders, formal returns, asset depreciation, advanced analysis | [R] | Evaluate separately; do not assume approved |

## 1.2 Confirmed decisions (authoritative)

- **DEC-01:** One shop only; no multi-location management now.
- **DEC-02:** Host device selection **undecided**.
- **DEC-03:** Hardware selected; models and interfaces will be supplied.
- **DEC-04:** QR customer orders require staff approval before kitchen execution.
- **DEC-05:** Reserve stock at approval/acceptance; consume on preparation completion.
- **DEC-06:** Insufficient-stock items are blocked and displayed as unavailable.
- **DEC-07:** Architect compares **weighted-average vs FIFO**; no costing-method choice yet.
- **DEC-08:** Cash and manually recorded card payments; single consolidated bill.
- **DEC-09:** Dedicated kitchen and reception roles/interfaces.
- **DEC-10:** Operational ledger + fixed asset register; not a full double-entry accounting system.
- **DEC-11:** Configurable kitchen ticket templates, with **no selling prices**.
- **DEC-12:** Dine-in, takeaway, and delivery at launch.
- **DEC-13:** No tax or service charge initially; existing historical invoices must not be altered when rules change in future.
- **DEC-14:** Premium coffee-house UI theme; client logo may be added later without redesign.

## 1.3 Explicit exclusions / not assumed

- Full double-entry general ledger, audited balance sheets, and tax filing automation.
- Online card processing/payment gateway, customer card-data storage, or unattended card capture.
- Multi-branch consolidation or cloud synchronization.
- Loyalty points, customer app, subscriptions, or marketing campaigns.
- Self-service customer order auto-approval.
- Guaranteed operation during loss of power, Windows host, database, or the local network.
- Automated delivery-driver dispatch, route optimization, or integration with third-party delivery platforms.

These can be proposed as change requests without silently expanding the quoted package.

---

# 2. Users, access, and permissions

| Persona | Principal functions | Key restrictions |
|---|---|---|
| Owner | Full operational visibility, accounts, users, RBAC, configuration, reports, finance, assets | Owner privilege delegation must be explicit and audited |
| Manager | Staff/table/order supervision; approved adjustments and reporting | Cannot access ungranted finance or security permissions |
| Waiter | Table selection, in-person order entry, customer notes, delivery confirmation, authorized amendments | No general ledger/profit visibility unless explicitly granted |
| Reception/Cashier | Open bills, customer invoices, cash/manual card collection, receipt printing, cash shift closing | Discounts/refunds/reopens require designated permissions |
| Kitchen Staff | New ticket queue, preparation line statuses, instructions, reprints | No sale prices or unrestricted customer information |
| Inventory Clerk | Ingredients, supplier receipts, batch/expiry, counts, wastage and adjustments | Authorized correction only; traceability mandatory |
| Customer | Table-linked QR menu/cart, order submission, order state, bill request | Can access only its own table session/order context; no staff endpoints |

**RBAC:** define permissions for users, roles, optional explicit per-user overrides, effective permissions, and a small set of protected owner operations. Enforcement must be in every relevant API/service, not only frontend routes. An owner can control reports, ledger, purchasing, stock adjustments, assets, staff, discounts, voids, kitchen templates, exports, and settings. Maintain an audit trail for permission grants/revocations. [TBD] Specify account creation, password-reset, manager approvals and owner recovery workflow.

**Initial permission namespace (illustrative):** `menu.read/manage`, `tables.read/manage`, `orders.create/accept/modify/void`, `kitchen.read/update/reprint`, `inventory.read/receive/adjust/waste`, `recipes.read/manage`, `purchases.read/manage`, `payments.collect/refund`, `discounts.apply`, `cash_shifts.open/close`, `ledger.read/manage`, `assets.read/manage`, `reports.sales/profit/inventory/export/schedule`, `users.manage`, `roles.manage`, `settings.manage`, `audit.read`, `backup.manage`.

---

# 3. Functional requirements

## 3.1 Menu, recipes and modifiers

- **MENU-001 [Q]:** Create/edit/archive categories and menu items, with names, descriptions, media, sort order, price, availability and order-type eligibility.
- **MENU-002 [Q]:** Support size/variant pricing, modifiers, extras, exclusions, notes and discounts/promotions.
- **MENU-003 [C]:** Associate each applicable sellable variant with a versioned recipe of ingredients, quantity, UOM, yield, optional wastage/preparation factors and preparation instructions.
- **MENU-004 [C]:** Modifier combinations must adjust recipe quantities as well as price (e.g., extra shot, soy milk, additional syrup, takeaway cup).
- **MENU-005 [R]:** Validate required recipe data before enabling a stock-consuming menu variant; allow documented exceptions for non-stock items.
- **MENU-006 [C]:** Store immutable price, recipe version and relevant modifiers on accepted order lines; changing current catalog data must not change historical transactions.
- **MENU-007 [C]:** Use controlled quantity conversions (e.g., 1 kg = 1000 g; 1 L = 1000 ml); avoid accidental dimension conversion between weight and volume.
- **MENU-008 [R]:** Display allergen/dietary tags when provided by client; never automatically infer clinical dietary safety.

## 3.2 Tables, QR and dine-in sessions

- **TABLE-001 [C]:** Each table has a unique internal ID, display number/name and secure opaque QR identifier.
- **TABLE-002 [C]:** Table QR opens a mobile-first local URL while the customer is on the restaurant's reachable Wi-Fi/LAN; the app must not require public internet DNS to operate.
- **TABLE-003 [C]:** The server resolves the table identity; a customer may not override table assignment through client-provided parameters.
- **TABLE-004 [C]:** Multiple customer devices may order within an authorized shared table session without accessing prior guests' private data.
- **TABLE-005 [C]:** One active dining session per physical table under the initial single-bill policy, unless the owner approves an explicit exception model.
- **TABLE-006 [C]:** Support Available, Occupied, Checkout Requested, and Completed/Settled records; *Completed* is a session state, not a long-lived occupied table state.
- **TABLE-007 [C]:** A completed/settled dining session remains immutable enough for history; new diners create a new session and do not inherit earlier orders.
- **TABLE-008 [C]:** Customer QR access expires or rotates logically with session closure; ensure old session URLs cannot inspect newer sessions.
- **TABLE-009 [R/TBD]:** Define stale sessions, abandoned tables, blocked/maintenance tables and authorized table transfer/merge policy.

## 3.3 Orders, approval and lifecycle

- **ORD-001 [Q/C]:** Create orders from QR, waiter devices or reception, across dine-in, takeaway and delivery.
- **ORD-002 [C]:** All QR-submitted orders enter **Pending Staff Approval** and must NOT reach kitchen preparation or reserve stock until accepted.
- **ORD-003 [C]:** Approval is atomic: validate the server-calculated line prices/modifiers/recipes, availability, table/session validity and sufficient unreserved stock; reserve required stock and transition the order or line to Accepted.
- **ORD-004 [C]:** If one or more products lack inventory, block affected items with actionable feedback; do not silently partially approve an order. [TBD] Define whether authorized partial acceptance is supported.
- **ORD-005 [C]:** Accepting the same order twice or retrying a timed-out request cannot create duplicate reservations or KOTs.
- **ORD-006 [C]:** Support line- and round-level statuses with validated transitions: Submitted -> Pending Approval -> Accepted -> In Preparation -> Ready -> Delivered; controlled Rejected, Cancelled, and Voided alternatives.
- **ORD-007 [C]:** Add-on orders for the same active table generate additional order rounds and kitchen tickets but share the same dining session and current consolidated bill.
- **ORD-008 [C]:** Modification after kitchen acceptance is implemented through revisions, voids, or adjustment events, not untracked direct overwrites.
- **ORD-009 [C]:** Record actor, timestamp, before/after values, reason and causation reference for important lifecycle changes.
- **ORD-010 [C]:** Distinguish order fulfillment state from invoice settlement/payment state and table occupancy state.
- **ORD-011 [C]:** Waiter and QR customer must see current authoritative order state after reconnect, not trust a missed notification.
- **ORD-012 [C]:** Checkout must prevent unnoticed new chargeable items from entering an invoice while it is being finalized; explicitly model checkout lock/reopen policy.
- **ORD-013 [R/TBD]:** Define whether a customer's bill request blocks new items, requires confirmation, or allows manager override.
- **ORD-014 [Q]:** Capture customer name, phone and email only when relevant to the order type; diner contact fields may be optional.
- **ORD-015 [C]:** Delivery support must have a defined customer/address/dispatch flow and roles, to be confirmed before implementation.
- **ORD-016 [C]:** All order-numbering and bill-numbering schemes must be collision-free and suited to printing/search, including offline LAN operation.
- **ORD-017 [R]:** If menu price or availability changes between customer submission and staff approval, do not silently increase the customer-visible charge: require revised price presentation/customer acknowledgment or a defined price-lock window before acceptance.

**Recommended session relationship:** `DiningTable -> DiningSession -> OrderRound -> OrderLine -> KitchenTicket`; `DiningSession -> Invoice -> Payment(s)` and `OrderLine -> RecipeSnapshot -> StockReservation/Consumption`.

## 3.4 Kitchen operations (KDS + KOT)

- **KDS-001 [Q]:** A dedicated kitchen screen shows new, preparing, ready and completed tickets with stable sort/prioritization and readable table references.
- **KDS-002 [C]:** Configurable kitchen ticket templates show table/order type, ticket number, timestamp, item quantities, sizes, modifiers, notes and optionally detailed recipe instructions/ingredient quantities.
- **KDS-003 [C]:** Kitchen tickets and views must **never** contain selling prices, tax totals, payment references or unneeded PII.
- **KDS-004 [C]:** Each newly accepted order round generates a new ticket. Ticket corrections and voids are visible and auditable, including after printing.
- **KDS-005 [C]:** Record item-level preparation completion separately from delivery confirmation; consume reserved inventory at **prepared** transition, exactly once per line/quantity.
- **KDS-006 [Q/C]:** Kitchen statuses update waiter/customer/reception displays without refresh where network conditions permit; reconnect triggers authoritative resynchronization.
- **KDS-007 [C]:** Print queues have durable job IDs/statuses; paper-out/disconnects should not lose ticket records. Reprints show a clear duplicate/reprint label.
- **KDS-008 [R/TBD]:** Optional preparation timing, station routing (bar vs food kitchen), bump screens and audible alerts may be configured after hardware/process confirmation.

## 3.5 Recipe-based reservations, stock consumption and waste

- **INV-001 [Q/C]:** Maintain separate `on_hand`, `reserved` and `available = on_hand - reserved` quantities by inventory item and, where needed, lot/batch.
- **INV-002 [C]:** On accepted order, calculate required stock from immutable recipe snapshot and modifiers; atomically create reservations only when sufficient *available, non-expired* stock exists.
- **INV-003 [C]:** On prepared transition, record consumption and release the corresponding reservation **within one transaction**.
- **INV-004 [C]:** On cancellation before preparation, release reservations; do not record physical consumption unless preparation actually occurred.
- **INV-005 [C]:** On cancellation after preparation, keep consumption and, where appropriate, create an explicitly categorized wastage/comped-order record; never credit stock by default.
- **INV-006 [C]:** All stock movements reference a reason/source event and actor; all stock adjustments preserve a complete immutable transaction trail.
- **INV-007 [C]:** Prevent selling unavailable items when insufficient usable quantity exists; expose a user-friendly unavailable/substitution message.
- **INV-008 [C]:** Direct on-hand edits are forbidden outside auditable opening balance/stock count adjustments.
- **INV-009 [C]:** Support ingredient purchases, receiving, supplier data, pack-size conversions, purchase cost and stock receipt history.
- **INV-010 [C]:** Barcode search resolves to an exact SKU/package unit, with indexed lookup, duplicate detection, unknown-barcode flow and manual text/SKU search.
- **INV-011 [C]:** Store item, batch/lot, expiry date, received date, remaining quantity and expiry warnings where applicable.
- **INV-012 [C]:** Notify staff about low stock, zero stock, near-expiry, expired stock, and excessive/overstock according to configurable thresholds.
- **INV-013 [C]:** Wastage records capture ingredient/product, batch where relevant, quantity, UOM, cost basis, reason, user and date/time.
- **INV-014 [C]:** Support stock count reconciliation with documented variance and owner-controlled approval.
- **INV-015 [R/TBD]:** Evaluate FEFO selection for physical expiry management; **FEFO is not a cost valuation method** and must not be confused with FIFO or weighted-average accounting.
- **INV-016 [C]:** Reservations must survive service restarts and be reliably released or completed; arbitrary timeout release of an accepted kitchen order is forbidden without business-state checks.
- **INV-017 [C]:** Recipes support additions, omissions, sizes and packaging variants. Units must avoid floating-point balance drift.

### Cost-method decision gate

| Topic | Weighted-average cost (WAC) | FIFO cost |
|---|---|---|
| Costing principle | Recompute average unit cost on qualifying receipts; issue consumption at the valid weighted cost | Consumption draws cost from the oldest eligible remaining cost layers |
| Strength | Simpler implementation/reconciliation and smoother unit cost | Strong layer-level cost traceability and sensitivity to purchase sequence |
| Tradeoff | Less precise representation of which purchasing layer was consumed | More complicated concurrent layer allocation, corrections and backdating |
| Expiry interaction | Independently use FEFO operational picking | Accounting FIFO does **not** automatically equal FEFO physical picking |
| Data requirements | Weighted-value rollforward, receipts, adjustments, snapshots | Immutable receipt layers and consumed-cost allocations |
| Decision | **Open** | **Open** |

The architect must present worked examples (multiple purchase prices, partial receipts, wastage, refunds/reversals, and historical margin calculations) and recommend one method for owner approval **before** database valuation and financial reporting implementation. The chosen method must prevent retroactive profit drift in already-posted periods.

## 3.6 Reception, checkout and payments

- **PAY-001 [C]:** Maintain a single consolidated invoice per dine-in session under launch rules, aggregating all valid accepted/billable order rounds.
- **PAY-002 [C]:** Cashier can open the current bill, see all billable items, apply authorized discounts and initiate checkout.
- **PAY-003 [C]:** Support **cash** and **manual card-payment recording**, without claiming card gateway authorization or storing card numbers/CVV.
- **PAY-004 [C]:** Receipt includes invoice number, item prices/quantities, discounts, payment method, amount due/paid, change when cash, timestamps and branding placeholder.
- **PAY-005 [C]:** No taxes/service charges in initial billing; store tax rules as disabled/zero and ensure totals and historical invoices remain stable if a future policy is introduced.
- **PAY-006 [C]:** A payment is recorded only on server-side success, with idempotency, transaction boundaries and exact decimal calculation.
- **PAY-007 [C]:** Cashier cannot finalize a bill containing unresolved chargeable order lines without an approved rule.
- **PAY-008 [C]:** Completing checkout closes the session, maintains full order history and releases the table to its configured next state.
- **PAY-009 [Q/C]:** Print original/reprint receipt safely; compatible cash drawers may open only for authorized events.
- **PAY-010 [R/TBD]:** Whether cancellation/refunds after settlement and cash/card corrections are permitted, and which managerial approval is required, must be defined; no covert invoice edits.
- **PAY-011 [R]:** Track cashier cash shifts, opening float, expected vs actual cash and discrepancy approvals to support quoted shift/day-end reporting.

## 3.7 Operational finance, expenses and assets

- **FIN-001 [Q/C]:** Operational ledger records customer receipts, manual card takings, purchasing outflows, operating expenses, refunds and adjustments, with source references.
- **FIN-002 [C]:** This is not a complete statutory/general-ledger accounting system; do not label reports as balance sheet, tax return or audited P&L.
- **FIN-003 [C]:** Expense records include amount, category, vendor/payee, reference, business date, creation timestamp, operator and optional supporting document.
- **FIN-004 [Q/C]:** Fixed-asset register tracks chairs, tables, coffee machines, tablets, printers, furniture, equipment and durable resources separately from ingredient stock.
- **FIN-005 [C]:** Asset record includes asset ID, category, purchase price/date, supplier, location, quantity, condition, responsible staff, maintenance, status and disposal history as applicable.
- **FIN-006 [C]:** Every privileged financial correction/reversal is permissioned, timestamped and auditable; posted historical entries cannot be silently deleted.
- **FIN-007 [R/TBD]:** Decide whether depreciation, outstanding supplier balances, salaries accrued but unpaid, and asset valuation must be modeled. Without complete expenses, label operating-profit metrics as *estimates/recorded-operating-result*.
- **FIN-008 [C]:** Cash, recorded card, net sales and cost accounting report calculations reconcile to underlying transactions.

## 3.8 Analytics, reporting and scheduled email

- **RPT-001 [Q/C]:** Owner dashboard shows sales, net sales, order count, average order value, open tables, in-progress tickets, ingredient consumption cost, gross profit/margin, wastage cost, stock alerts, recorded expenses and available operating profitability.
- **RPT-002 [Q]:** Reports include sales by item/category/order type, inventory usage, waste, profit margin, and shift/day-end figures.
- **RPT-003 [C]:** Filters: hourly, daily, weekly, monthly, year and custom date-time range; relevant secondary filters such as order type, employee, category, product, supplier and payment method.
- **RPT-004 [C]:** Graphs: revenue by hour/day, revenue vs ingredient cost, gross margin trends, item popularity vs margin, stock use, expiry and wastage reasons, payment mix, table use and expense categories.
- **RPT-005 [C]:** Reports export as properly formatted **CSV** and **PDF**; quote project wording says 'css' but implementation assumes CSV based on the previous clarification context — reconfirm if necessary.
- **RPT-006 [C]:** Owner manages scheduled email recipients, report type, filter/window, business-local delivery time and frequency; PDF generated from committed reporting data.
- **RPT-007 [C]:** If internet/email provider unavailable, mark as queued and retry on reconnection without duplicate delivery; show statuses and errors.
- **RPT-008 [C]:** Respect RBAC for report visualization, export and schedule modification. Avoid disclosing profit reports to kitchen/customer roles.
- **RPT-009 [C]:** Document definitions: gross sales; discounts; refunds; tax (zero initially); net sales; COGS; gross profit; gross margin; expenses; recorded operating result; revenue recognition timing.
- **RPT-010 [R]:** Dashboard widgets should drill into the underlying filtered transactional details and provide an understandable explanation when inputs are incomplete.
- **RPT-011 [C]:** All report timestamps/dates must be calculated using an explicit shop timezone; transactions store instants consistently.

**Proposed definitions to approve:** `NetSales = GrossSales - Discounts - Refunds` (only if discounts are not already netted and excluding zero taxes); `GrossProfit = NetSales - COGS`; `GrossMargin% = GrossProfit / NetSales × 100` where denominator > 0; `RecordedOperatingResult = GrossProfit - RecordedOperatingExpenses` with explicit date basis and no claim to full accounting profit. Finalize how complimentary items, voids, tip/service policies, and card fees are treated before implementation.

## 3.9 Printing, notifications and operational administration

- **OPS-001 [Q/C]:** Support separate configurable kitchen and reception printing routes; avoid lost/ambiguous print jobs on printer failures.
- **OPS-002 [C]:** Customer in-app order status notifications automatically change on committed server events and recover after browser refresh/reconnect.
- **OPS-003 [Q]:** Audit who changed prices, recipes, stock, discounts, bills, permissions, finance and assets.
- **OPS-004 [Q/C]:** Owner settings cover business hours, store details, receipt details, units, thresholds, discounts, report preferences, branding placeholder and printer routing.
- **OPS-005 [R]:** Admin diagnostic screen shows database, API, printer, LAN and queued jobs health to aid support.

---

# 4. Critical transactional workflows

## 4.1 QR order -> preparation -> checkout

1. Guest connects to a Wi-Fi network that can reach the local server; scans opaque table QR.
2. Mobile menu loads from LAN URL, showing relevant availability and price information.
3. Guest selects variants/modifiers, enters notes and submits an **idempotent** request.
4. System creates order round in Pending Approval (no consumption, no kitchen ticket).
5. Staff sees approval queue; explicitly accepts/rejects, or requests a change.
6. On acceptance, backend locks/revalidates inventory availability, freezes relevant recipe/price snapshots, reserves stock and commits transition + transactional outbox message(s).
7. KDS and print queue receive one kitchen event/ticket for that accepted round.
8. Kitchen progresses per-line to Prepared; backend consumes exactly the reserved quantity and records costing exactly once.
9. Waiter delivers; customer sees delivery progress. Further orders create new rounds within same active session.
10. Customer asks for bill; cashier finalizes one invoice after validating session contents and permitted discounts.
11. Cash/card-manual payment is recorded once; invoice settled, session closed, table released and reports updated.

## 4.2 Inventory state machine

`StockReceipt -> OnHand`  
`AcceptedOrder -> Reservation (Available decreases; OnHand unchanged)`  
`PreparedLine -> Consumption (OnHand decreases; Reserved decreases)`  
`CancelBeforePrepared -> ReservationRelease (Available increases)`  
`WasteAfterPrepared -> WasteClassification (no restored stock)`  
`InventoryCount -> AuditedAdjustment (never unlogged direct overwrite)`

Use a transactional outbox so notification/print retries cannot corrupt the committed order and stock changes. Notifications are not the source of truth. Enforce row locks or another proven mechanism to prevent simultaneous reservations overselling the same stock.

## 4.3 Cancel, void, refund and reprint

- Before approval: cancel pending round without reservation or KOT.
- After acceptance but before preparation: authorize cancellation, release remaining reservations and issue kitchen cancellation/correction ticket if relevant.
- After preparation: preserve consumed stock; record wasted/comped item with reason and proper cost classification; any customer refund is separate from stock correction.
- After settlement: changes require authorized refund/credit or reversal process, not silently editing a settled invoice.
- Print retry/reprint: preserve immutable job and ticket identity; mark reprints, do not mistake print ack for kitchen acceptance.

---

# 5. Local/offline deployment design

**Required properties:** Central Node.js API, PostgreSQL and background workers operate on one designated local host. Electron is the Windows shell primarily for administration/reception; other staff/customer devices use browser UI over LAN. Internet outages must not prevent local ordering, KDS, reception, stock transaction or local reports. **Hosting machine is not yet decided.**

**Architecture decisions for discovery:**
1. Compare dedicated Windows PC vs reception PC-as-host; include cost, supportability, restart risk and UPS requirements.
2. Confirm host operating system edition, CPU/RAM/disk, SSD, Windows login behavior, always-on policy and backup target.
3. Select stable LAN access: router DHCP reservation + supported local DNS/name or fixed IP (avoid reliance on public DNS; verify router guest isolation and captive portal).
4. Define LAN security, service binding/firewall, customer-QR access controls, browser local HTTPS/security-context implications and barcode-camera restrictions.
5. Use proper Windows service management/autostart for PostgreSQL, backend and workers; Electron UI may open at login. The Startup folder **alone is not** a service reliability solution.
6. Distinguish power loss, LAN loss, server failure and internet loss; commit to capabilities only where technically possible.
7. Choose SSE/WebSockets on actual event direction; all writes remain authoritative HTTP/API operations; reconnect validates server data.
8. Define email SMTP/provider configuration and outbox retries (email requires internet/provider reachability).
9. Specify offline Windows installer, migration strategy, health check, upgrade/rollback, credentials/secret storage and recovery guidance.
10. Define retention, daily/incremental backup schedule, encrypted off-device copies and tested full restore.

**Hardware integration:** Models [TBD]. For each thermal printer, kitchen printer, scanner and drawer, record brand/model, OS driver, protocol/connection (USB/LAN/Bluetooth), supported print width, command set, error reporting, special requirements and client test access. Avoid promising direct browser raw USB printing on unverified hardware.

---

# 6. UI/UX product specification

## 6.1 Visual direction

**Brand:** Premium modern coffee-house, neutral enough to accept the existing logo later. Proposed design tokens (approval pending): Espresso `#2C211C`; coffee brown `#6B4435`; parchment `#FAF7F2`; sand `#EDE3D7`; terracotta `#B86C50`; muted sage `#637861`; charcoal text `#2B2927`. Ensure WCAG contrast; do not use decorative colors to convey status without text.

**Design philosophy:** A luxury feel in owner analytics, practical efficiency in POS screens, high visibility in kitchen, near-zero learning curve for customers. Use consistent spacing, accessible type, keyboard shortcuts for reception, fast barcode input for clerk, ≥44 px touch targets in tablet/mobile workflows, responsive tables, helpful inline validation and meaningful empty/offline states.

**Information architecture by role:**

- **Owner:** Overview / Live Operations / Sales / Profit & Margin / Menu / Recipes / Inventory / Purchasing / Waste & Expiry / Operational Ledger / Expenses / Assets / Users / RBAC / Audit / Scheduled Reports / Settings / System Health.
- **Manager:** Live Operations / Table Map / Order Approval / Orders / Kitchen Monitor / Shift Activity / Authorized Reports / Staff.
- **Waiter:** Login / Floor Plan / Current Tables / Order Composer / Pending & Active Rounds / Delivery / Bill Request.
- **Reception:** Open Sessions / Consolidated Bills / Checkout & Payments / Receipts / Cash Shift / Authorized Refunds.
- **Kitchen:** New / Preparing / Ready / Completed Ticket Details / Ticket Corrections.
- **Inventory Clerk:** Overview / Product Lookup & Barcode / Stock Receipts / Batches / Counts / Expiry / Wastage / Suppliers / Purchases / Stock Movement History.
- **Customer:** QR Landing / Menu Categories / Item Details / Modifiers / Cart / Submit / Order Status / Add Order / Request Bill.

**Critical design prototypes:** customer QR-to-confirmation, waiter fast order, staff approval queue, kitchen ticket bump, partial/cancel transitions, consolidated checkout, ingredient receiving with barcode, stock count adjustment, owner live dashboard/report drill-down. Include loading, network interruption, duplicate submission protection, unauthorized role, out of stock, no printer, and expiry warnings.

**Figma deliverables:** architecture sitemap, component library, design tokens, desktop/tablet/mobile high-fidelity screens, interactive priority flows, role variants, iconography, export/print previews and developer handoff specs. Branding must be configurable rather than hardcoded into markup.

---

# 7. Data architecture / ERD candidate

**User & security:** `users`, `roles`, `permissions`, `user_roles`, `role_permissions`, `user_permission_overrides`, `user_sessions`, `audit_events`.

**Menu & production:** `menu_categories`, `menu_items`, `menu_variants`, `modifiers`, `modifier_options`, `recipe_versions`, `recipe_components`, `menu_recipe_links`.

**Table & ordering:** `dining_tables`, `table_qr_tokens`, `dining_sessions`, `order_rounds`, `order_lines`, `order_line_modifiers`, `order_status_events`, `kitchen_tickets`, `kitchen_ticket_lines`.

**Inventory & purchases:** `inventory_items`, `uoms`, `unit_conversions`, `inventory_batches`, `suppliers`, `purchase_receipts`, `purchase_receipt_lines`, `stock_reservations`, `stock_movements`, `stock_counts`, `stock_adjustments`, `wastage_records`, plus **cost layers/valuation rollforward** after accounting method approval.

**Finance:** `invoices`, `invoice_lines`, `payments`, `refunds`, `discount_events`, `cash_shifts`, `expense_categories`, `expenses`, `operational_ledger_entries`, `assets`, `asset_events`, `asset_maintenance`.

**Infrastructure:** `printer_configs`, `print_jobs`, `notification_outbox`, `report_schedules`, `report_jobs`, `report_deliveries`, `system_settings`, `backup_runs`, `application_events`.

**ERD invariants:**
- One active dining session per table at a time (enforce with partial unique index or equivalent, except approved special states).
- A stock consumption event may be posted once per accepted order line/preparation unit/event ID; retries return the original result.
- Immutable snapshots of price, recipe quantity and valuation inputs are bound to accepted order lines.
- Posted financial records use compensating events, never unlogged deletes.
- Stock movement and reservation rows are source-identified and idempotent.
- Amounts and measured quantity use safe numeric/DECIMAL representation and explicit rounding policy; no floating point drift.
- Build concurrency constraints, indexes, migrations, timezone rules, pagination and operational retention policy into ERD review.

No schema should be frozen until accounting method and unresolved operational policies are reviewed.

---

# 8. Nonfunctional requirements and acceptance targets

| Attribute | Requirement / proposal |
|---|---|
| Reliability | Critical writes atomic; durable committed state after reboot; idempotent order/payment/stock mutations |
| Local availability | Core workflows function with internet disconnected as long as host and LAN operate |
| Responsiveness | **Proposed**, subject to hardware benchmarking: 95% of ordinary local UI/API actions visibly respond within ~1s under realistic load |
| Realtime | **Proposed:** update active clients in ~2s under healthy LAN; always resync on reconnect |
| Security | Backend RBAC; protected admin actions; input validation; password hashing; safe local credentials; customer/session isolation |
| Auditability | Every important financial/inventory/permission mutation has actor, reason, timestamp, source and immutable history |
| Data durability | Document backup RPO/RTO and verify restore; propose short incremental/WAL interval subject to hardware/backup design |
| Testability | Unit + integration + end-to-end + concurrency + outage/recovery + printer/hardware tests |
| Accessibility | Accessible labels/keyboard flows/contrast; touch-friendly waiter and customer screens |
| Supportability | Structured logs, correlation IDs, health page, bounded job retries, upgrade rollback, runbook |
| Maintainability | Modular monolith preferred unless justified otherwise; no unnecessary microservices, no duplicated business calculation logic |
| Privacy | Optional customer contact info, least-privilege displays, retention and data-export/deletion policy where relevant |

**Performance, RPO/RTO, printer throughput and supported client device/browser matrix are acceptance gates**, not falsely guaranteed numbers before host/hardware testing.

---

# 9. Test and acceptance matrix

| ID | Given / When | Required result |
|---|---|---|
| AT-01 | Guest scans Table 05 QR and submits 2 coffees | Pending approval only; correct table/session; no kitchen ticket or reservation yet |
| AT-02 | Staff approves with sufficient stock | Correct recipe quantities reserved, one accepted round, one KOT/outbox event |
| AT-03 | Staff accepts same request twice/retries | One approval, one reservation, one KOT |
| AT-04 | Two waiters approve competing scarce-stock orders | Only affordable stock is reserved; no negative available stock |
| AT-05 | Kitchen marks one coffee prepared | Exactly one consumption, release of matching reservation, receipt-cost snapshot consistent |
| AT-06 | Accepted round cancelled before preparation | Reservations released, cancellation ticket recorded as necessary, no physical consumption |
| AT-07 | Prepared coffee cancelled/comped | Consumed stock retained; cost/waste classification accurately recorded |
| AT-08 | Table orders again 20 minutes later | New round and KOT, same consolidated active bill |
| AT-09 | Two devices submit different orders for same table | Both valid orders preserved, single dining session, no lost updates |
| AT-10 | Cashier finalizes while order updates race | Inconsistent bills blocked; invoice finalizes only reconciled contents |
| AT-11 | Cash/manual card payment request retried | One payment posting, no duplicated settlement, receipt shows correct totals |
| AT-12 | New diners scan reused table QR after previous checkout | New session isolated; no exposure of prior customers' records |
| AT-13 | Expired inventory only | Item unavailable, invalid stock cannot be reserved |
| AT-14 | Scanner reads known/unknown/duplicate barcode | Exact SKU match; appropriate unknown/duplicate handling |
| AT-15 | Router internet cable removed, LAN remains | QR/waiter/KDS/billing/inventory remain functional; emails queued |
| AT-16 | Kitchen printer disconnected | Ticket remains durable, error shown, controlled retry/reprint; no phantom duplicate orders |
| AT-17 | Host and PostgreSQL restart | Committed sessions, payment, stock, reservations and pending jobs recover correctly |
| AT-18 | Unauthorized waiter requests profit/ledger API | Access rejected server-side and audited where appropriate |
| AT-19 | Menu recipe/price changed after fulfilled sale | Historical invoice/consumption/margin remain unchanged |
| AT-20 | Date range / staff / order type filters used | Dashboard numbers equal underlying report/export/detail rows |
| AT-21 | Report email due while offline | Queued; sent once after internet/provider recovery, failure/success visible |
| AT-22 | Backup restored onto replacement setup | Database and application recover as documented; integrity checks pass |
| AT-23 | Asset price or expense record corrected | Permissioned reversal/version history; earlier action remains traceable |

Add property-based tests for quantity conversion, rounding, inventory conservation and payment/discount invariants. Set target concurrency and data scale after hardware discovery.

---

# 10. Architecture/engineering constraints

- Prefer **React + TypeScript**, **Node.js + TypeScript modular monolith**, **PostgreSQL**, **Electron** Windows shell and browser clients on LAN.
- The backend must run independent of whether the Electron reception UI is open; otherwise staff devices can fail on simple UI closure.
- Consider SSE for server-to-client update streams and HTTP mutation APIs; compare with WebSockets if interactive communication requires bidirectional sockets.
- Use PostgreSQL transactions, safe concurrency controls and a transactional outbox for reliable notifications/print processing.
- Separate domain services: identity/RBAC, menu/recipe, tables/sessions, ordering, kitchen, inventory, pricing/checkout, finance/assets, reporting, and infrastructure.
- No hidden reliance on external cloud services for core ordering, kitchen, inventory, or checkout.
- Treat SMTP connectivity, cloud backups, payment gateways and optional future hosted services as separate from local operation.
- Do not use Electron renderer privileged Node integrations by default; use secure IPC, context isolation and least privilege.
- Packaging/setup must include health checks, safe migration strategy, Windows autostart for server/worker services, installer/uninstaller, documentation and backup/recovery.

---

# 11. Implementation roadmap and approval gates

1. **G0 — Discovery & scope sign-off:** quotation traceability, workflows, permissions, hardware details, host tradeoffs, costing decision analysis, risk and unknowns. **No coding before G0 approval.**
2. **G1 — UI/UX + architecture sign-off:** Figma flows, application navigation, ERD, domain state machines, API specs, LAN design, hardware integration plan, backup and accounting decisions.
3. **G2 — Platform foundation:** app architecture, Postgres, migrations, logging, auth/RBAC, service bootstrap, Electron foundation, background jobs, quality automation.
4. **G3 — Core revenue path:** menu, QR and waiter orders, approval, KDS/KOT, table sessions, reception, manual cash/card payments, final receipts, authorized voids.
5. **G4 — Inventory path:** ingredients, recipes, reservations/consumption, batches/expiry, purchase receipts, barcode, stock count, waste, valuation.
6. **G5 — Finance + operations:** operational ledger, assets, expenses, reconciliation, activity history, settings, permissions hardening.
7. **G6 — Reports:** owner dashboards, item profitability, inventory and waste analytics, CSV/PDF exports, report scheduling and internet email queue.
8. **G7 — Operational hardening:** hardware verification, concurrent load, offline tests, recovery drills, packaging, training, UAT, known issues, sign-off.

Sequence may change where dependencies justify, but each gate requires test evidence, documented decisions and approval. Each sprint must produce usable vertical slices rather than disconnected UI mockups.

---

# 12. Blocking decisions and residual questions

| ID | Priority | Decision required | Why it matters | Recommended resolution |
|---|---|---|---|---|
| OPEN-01 | **Blocker** | Dedicated Windows host vs reception PC; OS/specs/UPS | Controls deployment topology, uptime and LAN URLs | Choose after comparing reliability/cost and confirm configuration |
| OPEN-02 | **Blocker** | Printer/scanner/drawer makes, models, ports and number | Determines reliable POS integration | Record each physical device and test protocol before integration |
| OPEN-03 | **Blocker** | Weighted-average vs FIFO inventory costing | Changes ledger/schema, COGS and profit | Worked examples + architect recommendation, owner approval |
| OPEN-04 | **Blocker** | Staff approval responsibility and rejection/partial approval | Affects queues, stock reservation and guest feedback | Default manager/waiter/reception configurable; reject whole round on unavailable line until approved alternative |
| OPEN-05 | **Blocker** | Delivery workflow: customer info, fee, rider/dispatch, payment at delivery | Quote includes delivery but process unspecified | Gather complete delivery story and statuses before implementing |
| OPEN-06 | **High** | Invoice lock, bill-request and post-settlement void/refund authority | Prevents racing orders and incorrect billing | Lock finalized invoice; use authorized adjustment/refund instead of mutation |
| OPEN-07 | **High** | Recipe data owner, all item/size measurements, packaging treatment | Needed for reliable stock usage | Collect signed-off recipes, ingredient units, variants and opening stock |
| OPEN-08 | **High** | Business hours, operating timezone, shifts, invoice numbering | Governs reporting and shift close | Confirm shop-local timezone, day boundary and cash shift rules |
| OPEN-09 | **High** | LAN customer access, Wi-Fi segmentation/captive portal and QR URL | QR ordering can fail even if on same router | Onsite LAN test and local host-name plan |
| OPEN-10 | **High** | Cash shift opening float, refunds, discounts, rounding | Needed for reconciliation | Specify reconciliation and approval rules |
| OPEN-11 | **High** | Email provider, recipients, frequency, report period and retry retention | Determines scheduled reports | Configure after sender/mail service and internet policy selected |
| OPEN-12 | **High** | Backup target, retention, encryption, recovery SLA | Important for irreversible transaction history | Off-device storage and restore drill; agree RPO/RTO |
| OPEN-13 | **Medium** | Order line/partial-preparation and substitution workflows | Recipe reservation and KDS UI complexity | Define realistic bar/kitchen cases during UAT discovery |
| OPEN-14 | **Medium** | Expense completeness, wages, depreciation and cost allocations | Prevents misleading 'net profit' claims | Report gross profit accurately; label recorded operating result unless accounts are complete |
| OPEN-15 | **Medium** | Receipt details: phone, address, tax identifiers if needed later; exact invoice format | Print layout and records | Provide paper format and sample receipt |
| OPEN-16 | **Commercial** | Approval of features expanded beyond the quote; quotation expired | Delivery scope and timeline governance | Sign approved change/scope matrix and reconfirm pricing/terms |
| OPEN-17 | **Medium** | Existing logo, preferred final typography/brand assets | Visual handoff | Keep replaceable logo slot; finalize during Figma phase |
| OPEN-18 | **High** | Reception paper slip: automatically print a copy at each accepted order round, only show running electronic bill, or both? | Directly affects second-printer routing, paper use and checkout workflow | Recommend configurable: live electronic reception bill, optional per-round slip, final customer receipt at settlement |

**Implementation readiness rule:** G0/G1 blockers must be closed before the relevant schema/deployment/hardware integration is finalized. Unresolved nonblocking items may have documented provisional defaults with the owner's approval.

---

# 13. Required deliverables

- Approved SRS and traceable scope matrix.
- Business process flowcharts (QR, waiter, KOT, inventory, checkout, purchasing, wastage, finance).
- Role/permission matrix and Figma design library/screens.
- Component diagram, deployment diagram, ERD and documented transaction boundaries.
- Versioned REST/OpenAPI contracts, client event contract, error codes and sequence diagrams.
- Implemented frontend/backend/PostgreSQL/Electron source, migrations, `.env.example` and tests.
- Hardware integration and installation verification sheet.
- Windows service/autostart installer and rollback plan.
- Printer templates, scheduled reports, sample CSV/PDF exports.
- Backup/restore runbook, security review, logs/health diagnosis, UAT scenarios and acceptance evidence.
- Operational training guide for each staff persona and owner/admin guide.
- Known limitations and separately approved change requests.

## Definition of Done

A module is complete only when its acceptance tests, RBAC, business invariants, responsive UI, error/empty/reconnect states, migration constraints, audit expectations, documentation, and related integration tests are finished. Avoid absolute promises of 'zero anomalies'; deliver systematic prevention, detection, test coverage and recovery, with no known unresolved critical defects at acceptance.
