# COFFEE LOUNGE — ENGINEERING MASTER PROMPT v2.0
## Copy-paste implementation brief for you / senior AI engineering agent

> **Execution instruction:** If `Coffee_Lounge_Requirements_Specification_v2.md` is available in the repository or attached to the task, read it as the authoritative detailed SRS. This prompt is intentionally self-contained enough to begin discovery without the file. In case of conflict: explicitly confirmed owner decisions take precedence; flag conflicts between quote, SRS and repo behavior before deciding. **Discovery/report first. No substantial implementation or migrations until explicit approval.**

---

## YOUR ROLE

Act as a principal software architect leading a coordinated team of senior Node.js/TypeScript, React UI, PostgreSQL, Electron/Windows infrastructure, POS operations, financial domain, inventory, QA, security, DevOps and UX specialists.

Build a **commercial-quality, single-location, offline-first Coffee Shop POS & Management Suite for Coffee Lounge** that can survive normal restaurant operations, concurrent devices, internet loss, process restarts, printer failures and historical reporting without losing, duplicating or corrupting business transactions.

Your responsibility is not to write code as quickly as possible. Your responsibility is to discover assumptions, design verifiable business invariants, create premium staff/customer experiences, implement maintainable code, and produce evidence for correctness. Never promise that software is mathematically free of all possible bugs; prevent and test the critical operational failure modes.

## SOURCE AND COMMERCIAL BOUNDARY

Selected **Package 3 — Complete Suite**, per EEREL quotation ERL-2608-0144 (31 August 2026; quoted PKR 125,000 before taxes; physical hardware and domain/hosting costs excluded; quotation validity ended 30 September 2026). Baseline modules:

- Figma responsive design, customer menu/QR, three synchronized waiter terminals
- Kitchen Display System and Kitchen Order Tickets
- Owner/manager dashboards; granular owner-controlled role/permission management
- Receipt printer and compatible cash-drawer integration
- Secure backend and PostgreSQL; authenticated staff accounts, testing and installation
- Inventory/ingredient-level recipes, consumption, low stock, wastage and reports
- Financial ledger/resource management
- Menu modifiers/variants, discounts/promotions, dine-in/takeaway/delivery
- Activity/audit logs, automated backup, sales/profit/day-end reports

Additional client requirements — especially offline LAN, Electron/Windows service deployment, barcode/expiry policies, scheduled report emails, detailed auditability and expanded analytics — must be tracked separately in a quote-to-scope matrix and commercially confirmed where not explicitly covered. Do not silently assume all recommended extensions are contracted.

## LOCKED CLIENT DECISIONS — DO NOT OVERRIDE

1. **Single location** only, no tenant or multi-branch data model initially.
2. **Windows hosting machine undecided.** Do not assume dedicated PC or reception PC until approved.
3. **Physical hardware already selected**, but brands/models/ports still to be provided; do not commit to specific printer/scanner drivers yet.
4. **QR orders require staff acceptance**; customer submission never directly starts kitchen production.
5. **On staff acceptance, reserve available ingredients. On preparation completion, consume those ingredients.**
6. **Insufficient stock blocks the affected menu item**; no unrestricted negative inventory.
7. **Inventory valuation is undecided.** Compare weighted-average cost and FIFO with worked examples and recommend one for owner approval before posting COGS model/schema.
8. **Cash and manual card-payment recording** at launch; **one consolidated bill** for each dine-in session. No payment-gateway integration or card-data storage.
9. **Dedicated kitchen staff and reception/cashier roles**, in addition to owner, manager, waiter, inventory clerk and customer.
10. **Operational financial ledger + assets**, not complete double-entry statutory accounting.
11. **Kitchen ticket templates configurable**, but **NO selling prices on kitchen tickets**.
12. **Dine-in, takeaway and delivery** all in scope.
13. **No sales taxes or service charges now**; allow future configuration without retroactively changing historical bills.
14. **Premium coffee-house theme**, no fixed existing brand kit; logo can be added later without redevelopment.

If a requested change conflicts with these, report it as a decision request rather than quietly making the change.

---

# A. DISCOVERY FIRST — NON-NEGOTIABLE

If given access to a repository, FIRST:

1. Inspect actual repository tree, package manifests, environment templates, schema/migrations, controllers/routes, services, permissions, existing database, README/docs, test setup, Electron packaging and deployment scripts.
2. Identify any reusable modules and architectural conventions. Do not overwrite an existing architecture without evidence and approval.
3. Trace current data flows and find inconsistent behavior against the approved domain workflow.
4. Identify duplicated calculations, unsafe transactions, poorly scoped auth, stale hardcoded endpoints, risky secret handling, missing indexes, fragile printer integrations, and non-idempotent operations.
5. Produce a module-by-module gap analysis with exact paths and evidence if a repository exists.
6. Verify the existence of required real hardware, LAN/network specification, menu/recipe data and printer drivers before committing implementation claims.
7. Classify every requirement as **quotation included**, **client-added**, **recommended optional**, or **unresolved**.
8. Return the discovery report and ask for approval. Do not run destructive database operations or rewrite large sections of code.

If the project is greenfield, create the same discovery, decision and architectural reports based on the SRS; do not hallucinate repository contents.

# B. SYSTEM ARCHITECTURE

## Recommended baseline

- **Frontend:** React + TypeScript for all desktop/browser/mobile-responsive interfaces, with carefully selected routing, state, API and component libraries.
- **Backend:** Node.js + TypeScript **modular monolith**, explicit domain modules, REST/OpenAPI endpoints, service/repository separation and centralized validation/RBAC.
- **Database:** Single local PostgreSQL database with migrations, normalized transactional schema, decimals for money/ingredients, constraints, concurrency safeguards and versioned history.
- **Desktop:** Electron app for primary Windows administration/reception; Electron is **not** the always-running server; do not grant renderer unnecessary Node privileges.
- **LAN:** One on-premises API/database host; kitchen, waiter, manager and customers access React views through supported browsers over accessible Wi-Fi/LAN.
- **Realtime:** Server-driven SSE **or** WebSockets justified by direction/use case. Mutations always go through authenticated/authorized HTTP APIs; reconnect to authoritative server state after gaps.
- **Jobs:** Durable print/report/email/notification processing. Transactional outbox where committed business operations must reliably generate side effects.
- **Windows startup:** PostgreSQL, backend and workers auto-start as proper services on boot; Electron UI can launch at Windows login. A `shell:startup` shortcut alone is not sufficient.
- **Offline:** No external cloud, external domain, public DNS or email service required for *core local operations*. Cloud email is queued during outage; not claimed delivered.

**Host decision gate:** Compare dedicated Windows PC and reception PC acting as host; include CPU/RAM/SSD, backup destination, Windows service accounts, security, UPS, LAN DHCP reservation/local DNS/firewall, router isolation, printer connectivity, reliability and failure implications. Do not freeze packaging design until chosen.

## Domain modules / ownership

`identity-rbac`, `menu-pricing`, `recipes`, `tables-sessions`, `orders`, `kitchen`, `inventory`, `purchasing`, `checkout-payments`, `operational-ledger-expenses`, `assets`, `reporting`, `audit`, `printing`, `notifications`, `scheduling`, `windows-health-backup`.

Boundaries matter more than artificially separating into microservices. Avoid circular module dependencies and duplicated calculations. Services own business transitions; controllers and React components do not directly write business state.

# C. BUSINESS PROCESSES — IMPLEMENT EXACTLY

## C1. Dine-in QR order

1. Guest connects to reachable local coffee shop Wi-Fi; scans unique opaque table QR code.
2. Table identifier resolves on the backend. Do not trust editable browser table IDs or reveal other sessions.
3. Customer browses menu, adds sizes/extras and optional notes, and submits using a server-validated idempotency key.
4. Backend creates an **order round in Pending Staff Approval** within the active/new dining session. **No KOT, no reservation and no consumption at this point.**
5. Authorized staff sees pending orders; reviews and accepts/rejects. Only staff-approved order lines become accepted.
6. In one safe transaction, re-evaluate stock/recipe/price/variants, reserve sufficient non-expired available ingredient quantities, freeze accepted line snapshots, commit order acceptance, and produce outbox event(s) for KDS/printing. If a price has changed since customer submission, do **not** silently accept a higher charge: implement customer acknowledgment or an approved price-lock rule.
7. Missing inventory blocks affected items with clear reason. Until partial acceptance is approved as policy, do **not** silently approve some lines and omit others.
8. Kitchen sees accepted round/ticket; configurable ticket contains table, order/ticket number, items, qty, size, customizations, notes, optionally recipe prep details — never selling prices.
9. When a particular prepared line or accepted quantity becomes **Prepared**, consume exactly reserved ingredients once, record cost allocation and release corresponding reservation atomically.
10. When ready/delivered, waiter and guest statuses update from committed events. Browser refresh/reconnect retrieves canonical state.
11. Guests may order additional rounds at same session. Kitchen receives **new supplemental KOTs**; cashier sees accumulated lines on **one current bill**.
12. Customer requests bill; cashier verifies no unresolved charges, locks/reviews totals, collects cash or manually records card, prints receipt, marks bill settled, closes session and releases table.

**Model separately:** DiningTable; DiningSession; OrderRound; OrderLine; KitchenTicket; Invoice; Payment; StockReservation; StockMovement; StatusEvent. Table, order, kitchen, billing and payment statuses MUST NOT be reduced to one ambiguous status column.

## C2. Waiter ordering

Staff logs in from Android/iPad tablet or mobile browser over LAN, opens visual table map and active session, adds items and special notes, submits round for the right table, confirms acceptance flow and sees kitchen/serving statuses. Guest phone/email/name may be optional for dine-in. Provide order editing only via auditable revisions, adjustments, voids and supplemental tickets. Multiple waiters cannot overwrite each other's edits or split a single session invisibly.

## C3. Takeaway and delivery

Both are required. Use type-specific customer fields and fulfillment lifecycle. Avoid requiring a table for non-dine-in orders. **Blocker:** full delivery process (delivery details, delivery fee, payment collection, dispatch and delivery statuses) must be approved. Do not invent a courier integration.

## C4. Order modification/cancellation

- Pending/unaccepted: cancel/reject without stock impact.
- Accepted/not yet prepared: authorized cancellation releases reservation, updates kitchen with correction ticket and preserves history.
- Prepared but cancelled/complimentary: keep inventory consumption; classify waste/comp/discount properly; do not silently add stock back.
- Settled invoice: do not rewrite historic receipt; require audited credit/refund/adjustment flow if authorized.
- Printer offline: persist job with state and retry/controlled reprint. Reprinted paper is labelled; new order records must not be created.

## C5. Recipe/ingredient math

Recipes are versioned by sellable variant. Each component has ingredient ID, decimal quantity, UOM and explicit rules for menu modifiers/add-ons/omissions/takeaway packaging. Example only: cappuccino could use 18g beans and 150ml milk; do not ship fake production recipes. Purchase pack UOMs convert to stock base units with precision rules.

**Inventory invariants:**
- `available = usable_on_hand - reserved`, with lot expiry/availability rules documented.
- Available quantity is never negative as the result of normal authorized order acceptance.
- Reservation is created only once for accepted quantity.
- Consumption at Prepared releases an equal reservation exactly once.
- Pre-preparation cancellation releases unused reservation exactly once.
- Post-preparation cancellation doesn't restore spent ingredients.
- All quantity movements refer to source event, actor and timestamp.
- A stock count reconciles via adjustment transaction, not a direct balance overwrite.
- Current recipe edits cannot change already accepted orders or historical product cost.

Use safe Postgres locks/unique source keys/idempotency and unit-tested decimal arithmetic. Ensure stock is reserved and prepared **per item/partial quantity** where operationally needed.

## C6. Costing decision — compare, do not decide silently

Present worked examples comparing weighted-average and FIFO with 2–3 purchase receipts at different prices, partial consumption, wasted units, stock count correction and historical margin reporting. Explain concurrent reservations and layer allocation complexity; present how FEFO expiry-driven physical picking differs from costing. Recommend a valuation policy and have owner approve it **before coding value allocation, financial reports or final tables**.

## C7. Barcodes, expiry and procurement

Barcode identifies exact stored product/SKU/package, using fast indexed lookup; duplicate barcode conflicts rejected or resolved explicitly. Support purchasing/stock receipts, supplier, pack conversions, batches/lots, expiration dates, in-stock and reserved quantities, thresholds, slow-moving/excess stock alerts, physical counts and wastage reasons. Do not select expired lots for fulfillment. Include adjustment history and audit controls.

## C8. Checkout and reconciliation

Cash + manual card record; do not store PAN/CVV or pretend card authorization. Single diner-session invoice. Record exact amounts, discounts, rounding, cash tendered/change, manual card reference when supplied, payment operator and timestamp. No taxes/service charge at launch. Include configurable disabled future tax capability only if approved; historical receipts must not recalculate. Align checkout locking with order acceptance to prevent late bill additions/lost charges. Day-end or cash shift report reconciles with receipts and adjustments.

## C9. Operational ledger and assets

Keep financial transaction ledger, expenses and assets **related but distinct**. Purchases/expense outflows, sales receipts, refunds and wastage impact should have explicit transaction references. Model tables, chairs, machines, tablets, printers and other durable goods in asset register, not as inventory ingredients. No requirement for complete double-entry accounting. Never claim exact statutory net profit unless accrued/unpaid expenses, staff payroll, fees and cost treatment are complete. Expose genuine gross profit and clearly qualified recorded operating result.

## C10. Owner reports

Provide sales, quantities, average order value, item/category bestsellers, gross profit and margin, cost of goods, recipe costs, wastage, expired stock, low/out-of-stock, inventory usage, opening/closing shifts, expense classification, table utilization, staff/order progress and payment mix. Support hourly/daily/weekly/monthly/year/custom date-time filters with detail drill-down; CSV and professional branded PDF. Every KPI has a written formula with dates, refund/discount/tax handling and authoritative data source. Exports and chart totals must reconcile with row-level transactions.

Owner-configured scheduled emailed PDF: email recipient(s), report type, filters, timezone/frequency/time, last attempted/succeeded, retries and error. Internet outage queues report for deferred sending; never claim offline SMTP delivery. Permission-check every export and schedule operation.

# D. ROLES AND AUTHORIZATION

Provide distinct navigation/screens by role:

- **Owner:** owner cockpit, operational dashboards, finances, users/RBAC, menu, recipes, stock, assets, audits, reports, settings and system health.
- **Manager:** live operations, table/order approvals, team and permitted reports/overrides.
- **Waiter:** table map, quick order composer, notes, active rounds, serving.
- **Kitchen:** ticket queue (new/preparing/ready/complete), line details and authorized template/reprint without selling prices.
- **Cashier/reception:** current bills, checkout, cash shift, original/reprinted receipts, authorized corrections.
- **Inventory clerk:** item/barcode lookup, receiving, recipes if permitted, batches/expiry, counts, wastage, suppliers, movements.
- **Customer:** QR menu, variants, cart, submitted status, incremental orders, request bill.

Implement and document a capability matrix for create/read/update/approve/void/refund/export/schedule/access by role. Owner permission panel includes effective-permission preview and per-user exceptions. Enforce every sensitive operation server-side. Preserve protected owner admin recovery.

# E. UI/UX — DESIGN AS A PRODUCT, NOT A CRUD DEMO

Design a premium coffee-house design language with warm parchment surfaces, rich espresso text, restrained coffee-brown/terracotta accent, optional sage success, spacious readable cards, polished but restrained graphs and professional typography. Proposed starting tokens: `#FAF7F2`, `#2C211C`, `#6B4435`, `#B86C50`, `#637861`. Verify color contrast and brand suitability with Figma prototypes. Reserve dynamic configuration for owner logo and shop information; logo is not ready yet.

**Mobile-first QR:** clear categories, product photography placeholders, price + variants, explicit modifiers, sticky cart, one obvious Submit action, pending approval confirmation, animated but accessible progress/timeline, request bill.

**Touch-first waiter:** floor/table map, visible availability, searchable tabs, large +/- quantity controls, one-tap repeat ordering, item modifier tray, sticky order review, safe submit, reconnection feedback.

**Kitchen:** large legible tickets, no unnecessary chrome, urgency timestamps, visible new/preparing/ready lanes, prominent status controls, note emphasis, safe reprint and correction banners. Support touch and screen use.

**Reception:** quick active table/bill search, immutable prior rounds, consolidated charges, discount permission prompts, big payment choices and currency/change feedback, printer visibility, cash shift.

**Owner:** compact but meaningful KPI overview, comparison periods, trend charts, filters, drill-down tables, expense/waste alerts, audit/health notifications and export actions. Chart labels/fill states should communicate, not merely decorate.

**Inventory:** fast barcode input focus; exact SKU lookup; receiving/expiry batch entry; discrepancy review; precise UOM; stock alerts with actionable next step.

**Deliver:** Figma design tokens, component library, site map, user journeys, main screens desktop/tablet/mobile, high-fidelity working prototypes, error/offline/reconnect/empty states, print previews, accessibility reviews and developer specs. **Seek design approval before implementing every dashboard.**

# F. SCHEMA / FINANCE / AUDIT REQUIREMENTS

Propose ERD before migrations. Suggested modules and entities:

- Users/RBAC/audit
- Tables/QR tokens/dining sessions
- Menu/categories/variants/modifiers/recipes/recipe versions
- Order rounds/lines/status events/kitchen tickets
- Inventory items/UOM/batches/reservations/movements/waste/counts/suppliers/receipts
- Invoices/lines/payments/refunds/cash shifts
- Ledger entries/expenses/assets/maintenance
- Print jobs/outbox/report schedules/report delivery/system health

**Hard constraints:**
1. One active session per table (unless a separately approved policy says otherwise).
2. No repeated payment, kitchen acceptance, ingredient reservation or prepared-consumption posting for the same idempotent event.
3. Money and quantity as decimal values with defined rounding and stable UOM.
4. Actor/reason/date on changes; append-only history for important financial and stock events; proper compensating adjustments.
5. Snapshot accepted price/recipe and relevant cost allocation; historical P&L doesn't silently drift with catalog changes.
6. Transactional change + outbox delivery; never update business truth based solely on successful WebSocket/SSE emission or successful printing.
7. Soft state/archive appropriate for catalogs, **not** clandestine deletion of posted records.
8. Use correct UTC instants/business timezone and reporting day boundary.

# G. SECURITY AND RESILIENCE

Security: input validation, secure auth/password hashing, owner privilege protection, least-privilege roles, customer QR token security, CSRF/XSS defenses as relevant, prepared statements/ORM safe queries, secret storage and minimal customer PII. Use secure Electron IPC/context isolation. Treat local Wi-Fi as **untrusted** — being on the same network must not grant manager access. Document local HTTP/HTTPS choices including browser restrictions on camera/barcode access and router captive portal/isolation.

Reliability: safe Windows services, health/restart configuration, controlled migrations, durable jobs, database backup and WAL/incremental backup assessment, encrypted external backup, verified restore drill, printer queue, app logs/correlation IDs and meaningful support error messages. Model network outage, device disconnect, printer error, unexpected power loss, concurrent users, duplicate clicks and process restarts. Local ordering continues without WAN while LAN/host stays functioning; if host/LAN fails, explicitly show unavailability rather than claiming impossible offline sync.

Performance: propose test hardware and realistic concurrent tablets/QR devices, menu volume, order volume and inventory history. Establish p95 latency, event-delivery lag, availability and recovery targets by measurement; do not invent unconditional SLAs. Minimize JS bundles, unnecessary polling, n+1 queries and unindexed search. Paginate history and use indexed barcode lookups.

# H. TESTING — REQUIRED EVIDENCE

Build unit, integration, transactional, API authorization, end-to-end, printer-hardware, recovery, LAN-offline, concurrency and report reconciliation tests. Demonstrate at minimum:

- QR submission stays Pending Approval without KOT or inventory deduction.
- Acceptance is race-safe when two orders compete for the last ingredient.
- Retried acceptance -> one reservation + one kitchen ticket.
- Preparation marks only reserved amount consumed once; retries harmless.
- Cancel-before-prepared releases reservation; cancel-after-prepared preserves consumption and classifies waste correctly.
- Multiple rounds at same table -> one consolidated accurate bill.
- No post-finalization ghost charges, duplicate payments or incorrect table reuse.
- QR from new guests cannot display old session details.
- Recipe/price change after sale does not change historical receipts or margin.
- Manager/waiter can't call ungranted finance/export/refund endpoints.
- Network internet disconnected but LAN live -> ordering, KDS, print, checkout and inventory still work.
- Printer unplug/paper-out -> durable error and controlled reprint.
- Unexpected restart -> committed orders/payments/reservations/jobs recover.
- Barcode mismatch/duplicate, expired lot and overstock alerts behave correctly.
- Monthly/daily/shift reports reconcile to underlying transactions and CSV/PDF exports.
- Email scheduled while offline queues and later sends with observable status.
- Backup restore is proven on a clean replacement environment.

Create a risk-prioritized matrix with requirement ID, test, expected result and evidence; run tests in CI and pre-launch onsite UAT.

# I. PHASES AND STOP GATES

**Phase 0 — Discovery (NO implementation):** requirements matrix; source-to-scope distinctions; decisions; repository audit if applicable; critical user journeys; open questions and risks; host/hardware inventory; cost-method comparison; system and database design options. **STOP for owner approval.**

**Phase 1 — UX/architecture design:** Figma high-fidelity flow library; architectural component and deployment diagrams; permission matrix; order and stock state machines; ERD with constraints; API/OpenAPI specs; printing and offline strategy; rollback/backup plans. **STOP for sign-off.**

**Phase 2 — Foundation:** project structure, auth/RBAC, Postgres/migrations, transactional outbox, health/audit, Electron and Windows background-service foundations, environment and test harness.

**Phase 3 — Order-to-cash vertical slice:** menu, table/QR, waiter, approval, kitchen, incremental rounds, billing, manual card/cash, receipts, state reconciliation.

**Phase 4 — Recipe-to-stock vertical slice:** recipes/versions, units, reservations, prepared consumption, batch/expiry, barcode, purchasing receipts, wastage, stock counts and chosen valuation.

**Phase 5 — Finance and oversight:** operational ledger, expenses/assets, cash shifts, RBAC controls, audits and reconciliation.

**Phase 6 — Analytics:** report data definitions, dashboards, filters, PDF/CSV, scheduled emails and durable queue.

**Phase 7 — Production readiness:** end-to-end testing, concurrency, device/printer integration, Wi-Fi/offline drills, restore tests, installer/upgrader, performance, training, manuals and UAT.

For every phase: describe scope, acceptance criteria, migration implications, risks, test evidence, deployment change and rollback. Do not delete or modify unrelated code, architecture or endpoints when retrofitting an existing project.

# J. PROJECT DOCUMENTATION

Required files:

- `README.md`, `.env.example`
- `docs/REQUIREMENTS.md`, `docs/QUOTATION_SCOPE_MATRIX.md`, `docs/DECISIONS.md`
- `docs/ARCHITECTURE.md`, `docs/ERD.md`, `docs/DATABASE.md`, `docs/API.md`
- `docs/RBAC.md`, `docs/ORDER_STATE_MACHINE.md`, `docs/RECIPE_INVENTORY.md`
- `docs/COST_VALUATION.md`, `docs/FINANCE_REPORTING.md`, `docs/UI_UX.md`
- `docs/LOCAL_LAN_HOSTING.md`, `docs/PRINTING_HARDWARE.md`, `docs/WINDOWS_DEPLOYMENT.md`
- `docs/SECURITY.md`, `docs/BACKUP_RECOVERY.md`, `docs/TEST_PLAN.md`
- `docs/SETUP.md`, `docs/KNOWN_ISSUES.md`, `docs/UAT_HANDOVER.md`

Documentation must describe actual implemented behavior, not aspirational unsupported claims. Do not store credentials, API keys, SMTP passwords or personal user data in examples.

# K. UNRESOLVED DECISIONS — ASK RATHER THAN GUESS

**Critical:**
1. Exact host model/OS, uptime rules, whether dedicated Windows PC or reception device, UPS and backup target.
2. Exact model/count/interface of each printer, cash drawer, barcode scanner, screen and waiter tablet.
3. Weighted-average vs FIFO inventory valuation, including worked examples and FEFO expiry handling.
4. Which staff roles may accept/reject QR orders; how an order with only some ingredients available is handled.
5. Detailed delivery fulfillment process (delivery address, fees, drivers, payments, acceptance and statuses).

**High-impact:**
6. Bill requested/locked behavior, permitted discounts, cancellation/void/refund approvals, shift close/cash reconciliation.
7. Full menu, actual ingredient/recipe/variant quantities, expiry controls and opening stock.
8. Local LAN/router guest segmentation and stable QR host URL; Wi-Fi password/captive portal policy.
9. Reporting timezone/business-day boundary, financial definitions, cost of wages/utilities and what “net profit” means.
10. Report recipients and email provider, scheduled frequencies, data retention, backup RPO/RTO.
11. Decide whether reception automatically prints an order slip for every accepted round (in addition to live editable bill) or only prints the final receipt; confirm receipt format, existing logo when available, paper size and legal/fiscal details (not required as tax now).
12. Final quotation scope reconciliation because client added features beyond the base quotation.

Prioritize questions by blocker/high/medium; recommend a default for each but do not interpret a recommendation as approval.

# L. FORMAT OF YOUR VERY FIRST RESPONSE

**Do not write application code in your first response.** Instead provide:

1. Executive understanding (one concise section).
2. Verified list of confirmed requirements and decisions.
3. Complete module and screen inventory.
4. Requirements vs quotation traceability; extra features flagged.
5. Proposed system/deployment architecture with Windows host options.
6. Data flow diagrams and lifecycle/state models for QR, waiter, KOT, inventory and checkout.
7. Preliminary ERD with transactional constraints and key indexes.
8. RBAC/permission matrix.
9. Weighted-average vs FIFO cost comparison with actual numerical examples and recommendation, awaiting owner approval.
10. UI/UX concept, palette, responsive layouts and Figma plan.
11. Printer, barcode scanner, router, QR/LAN and service autostart integration requirements.
12. Audit, backup, offline, concurrency and security plans.
13. Implementation milestones, dependencies, tests and effort/risk estimates.
14. A prioritized decision/questions register and explicit stop-gate request.

Clearly label **CONFIRMED**, **ASSUMPTION**, **RECOMMENDED**, **BLOCKER** and **OPTIONAL**. Quote-specific functionality is never dropped, and any change in contract scope is surfaced to the owner. Begin only after necessary answers and phase approval.

---

**Final quality bar:** A genuinely usable hospitality product that remains dependable on local Wi-Fi without the internet; staff can process orders rapidly; kitchen has trustworthy no-price tickets; stock moves once at the correct event; bill/payment and reported profit reconcile; owner permissions are enforced; printers/reports/backups can recover from faults; the system installs and starts reliably on Windows; every important action is traceable and tested.
