# Coffee Lounge — Test Plan & Traceability (Phase 1, package 1F)

> Design specification for review R6 → Gate G1. Consolidates `docs/phase-0/08-quality-testing.md` and adds tests for everything designed in packages 1A–1E. Requirement → test mapping: [traceability.csv](traceability.csv) (checked automatically, §11). No feature or hardware integration is called "production-ready" until its tests pass **on the target counter iMac and real devices**.

## 1. Principles

1. **Evidence, not claims.** Every requirement has at least one test; every test produces stored evidence (CI log, report, photo or signed sheet).
2. **Real PostgreSQL, never a mocked database** for anything transactional.
3. **Money and stock tests use exact expected values**, computed independently (decimal arithmetic), not "looks right".
4. **Concurrency tests repeat** (≥ 100 runs per race in nightly CI) because timing bugs hide.
5. **Target hardware decides performance and recovery.** CI proves logic; the iMac, router, printer and phones prove operation.

## 2. Test levels

| Code | Level | Tooling | Runs |
|---|---|---|---|
| U | Unit (pure logic: decimal math, recipe explosion, WAC, KPI formulas, ESC/POS rendering, state tables) | Vitest | Every commit |
| P | Property-based (invariants over random inputs) | fast-check | Every commit (short), nightly (long) |
| I | Integration (services + real PostgreSQL, constraints, triggers, idempotency) | Vitest + disposable DB | Every commit |
| C | Concurrency (parallel connections with barriers) | Custom harness | Every commit (×10), nightly (×100) |
| API | Authorisation matrix: every route × every role | Generated tests from RBAC.md | Every commit |
| E2E | Multi-device journeys (guest, waiter, cashier, clerk, owner) | Playwright, several browser contexts | Nightly + before release |
| G | Golden output (kitchen tickets, receipts, PDFs, CSV) | Snapshot files reviewed by a human once | Every commit |
| F | Fault injection (kill processes, restart DB, drop SSE, slow network) | Scripts + toxiproxy | Nightly |
| L | Load | k6 on a Windows 10 machine of similar spec, then the iMac | Phase 7 |
| HW | Hardware (printer, scanner) | Checklists with photos | Phase 3 (first contact), Phase 7 (final) |
| S | Site (router, Wi-Fi, power) | On-site checklist | Phase 7 |
| D | Drill (restore, power cut, drive swap) | Timed runbook | Phase 7, then quarterly |
| UAT | User acceptance with real staff | Scripted service sessions | Phase 7 |

## 3. Environments

| Environment | Purpose | Notes |
|---|---|---|
| Developer machine | Unit/integration | PostgreSQL 17 locally |
| CI (Linux) | All automated levels except Windows-specific | Fresh DB per test file |
| CI (Windows runner) | Installer, services, spooler printing helper, clock check, upgrade/rollback | Windows 10 image where available |
| Staging VM | Windows 10 Pro VM mirroring the counter iMac config (static IP, services, firewall) | Printer simulator on TCP and a virtual RAW printer queue |

**Printer simulator (built in step 2.10):** `apps/server/test/support/escpos/` holds an ESC/POS decoder (text lines with style, cuts, images, barcodes, status requests, drawer pulses, unknown or truncated commands) and a raw-TCP printer simulator (one connection = one job, byte capture, DLE EOT / GS r status answers from paper and cover state, faults: drop mid-job, stall, reset, switched off). Standalone: `node scripts/printer-sim.ts --port 9100 --out ./print-captures` in `apps/server` saves each job as `.bin` plus a decoded `.txt`. The simulator stands in for **the network path only**; the expected USB/spooler path (PRINTING_HARDWARE.md §2) is tested with a virtual RAW queue on Windows.
| Target | Counter iMac, Huawei router, Sonic printer & scanner, 3 tablets, staff phones | On site; owner present for router/power tests |

**Test data:** generated sample menus, recipes, stock and a year of synthetic sales (≈ 300k order lines) for report and performance tests. **No real customer data** in any non-production environment.

## 4. Entry and exit criteria per phase

| Phase | Entry | Exit (all required) |
|---|---|---|
| 2 Foundation | G1 signed | U/I/API green; idempotency + SSE + auth tests pass; services start on clean Windows VM (AT-47); migrations apply on empty DB |
| 3 Order-to-cash | Phase 2 exit | All Phase-3 tests in §5 green; concurrency CT-01…CT-06 ×100 green; golden tickets/receipts approved; first hardware contact HW-01…HW-04 recorded |
| 4 Recipe-to-stock | Phase 3 exit; costing confirmed (D-04 ✔) | Phase-4 tests green; property tests PT-01…PT-04 long run green; costing fixtures exact (AT-33, AT-66) |
| 5 Finance | Phase 4 exit | Phase-5 tests green; ledger ↔ source reconciliation 100 % |
| 6 Reports | Phase 5 exit | Every KPI reconciles to detail and exports (AT-20, AC-RPT-1); scheduled e-mail queue tests green |
| 7 Readiness | Phase 6 exit; hardware on site | Site, hardware, drill, load and UAT suites passed; no open Critical/High defects; known issues documented |

## 5. Functional test catalog

Level codes from §2; phase = first build phase that must pass it.

### 5.1 Ordering, approval, kitchen pickup

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-01 | Guest scans Table 5 QR and submits 2 coffees → round pending approval; no ticket, reservation or stock movement | I, E2E | 3 |
| AT-02 | Staff accepts with enough stock → reservations = recipe × qty; one accepted round; one ticket; one print job | I | 3 |
| AT-03 | Accept retried or double-pressed → one acceptance, one set of reservations, one ticket | I | 3 |
| AT-04 | Two staff accept competing rounds for the last stock → only what's available is reserved; available never < 0 | C | 3 |
| AT-05 | Picked up 1 of 2 cappuccinos → exactly one consumption per ingredient; matching reservation released; line cost frozen | I | 3 |
| AT-06 | Accepted round cancelled before pickup, "not made yet" → reservations released; correction ticket; no consumption | I | 3 |
| AT-07 | Picked-up coffee voided (spilled) or comped → consumption kept; waste or comp recorded with cost | I | 3 |
| AT-08 | Table orders again 20 min later → new round, supplement ticket, same bill | E2E | 3 |
| AT-09 | Two phones at one table submit different rounds → both kept, one session | C | 3 |
| AT-24 | Guest double-taps Send / retries after a network drop → one round, same round number | I, E2E | 3 |
| AT-25 | Price raised after submission, accepted within 30 min → guest charged the quoted price; adjustment recorded | I | 3 |
| AT-26 | Waiter round with an out-of-stock line → nothing saved; lines flagged; cart kept | I, E2E | 3 |
| AT-27 | Pick up 2 of a qty-3 line, cancel 1 → counters consistent; 2 consumed, 1 released | I | 3 |
| AT-48 | Assigned waiter, other waiter, cashier and manager press Accept at once → exactly one succeeds; unassigned waiter gets 403 even calling the API directly | C, API | 3 |
| AT-49 | Table reassigned while an accept is in flight → only the waiter assigned at commit time can accept | C | 3 |
| AT-50 | QR round pending > 3 min → highlighted to manager + cashier; cashier may now accept | I | 3 |
| AT-62 | Cancel before pickup, "already made" → consumption + waste; reservation closed | I | 3 |
| AT-74 | Guest only browses → no session, table stays Available; first submit opens the session | I, E2E | 3 |
| AT-75 | Two guests use the counter QR → two separate takeaway sessions; neither sees the other's order | E2E | 3 |
| AT-78 | Price rose and the 30-min lock expired → `PRICE_CHANGED_LOCK_EXPIRED`; round must be rejected | I | 3 |
| AT-88 | Accepted line not picked up after 30 min → uncollected alert; reservation open > 12 h → stale alert | I | 3 |
| AT-92 | Picked up then Undo within 5 s → no request sent; no Undo → sent once after 5 s; device offline → "Not sent" | U, E2E | 3 |
| AT-99 | Kitchen ticket API payloads contain no price, payment or contact fields | API, G | 3 |
| AT-100 | Transfer session to a free table → moved and audited; to an occupied table → `TABLE_OCCUPIED` | I | 3 |
| AT-101 | Rounds submitted after a bill request are accepted but flagged `after_bill_request` | I | 3 |
| AT-102 | Ingredient stock hits zero → dependent variants show unavailable on guest and staff menus; manual "unavailable" overrides stock | I, E2E | 4 |
| AT-112 | Two promotions match a line → best single promotion applied; outside its day/time window none applies | U, I | 3 |
| AT-113 | Modifier group min/max violated (e.g. two milk choices) → `VALIDATION_FAILED` server-side | API | 3 |
| AT-114 | Item not allowed for delivery added to a delivery order → refused | API | 3 |
| AT-124 | Notes over 120 chars refused; control characters stripped from printed output | U, API | 3 |
| AT-125 | Guest exceeds 10 submissions/min or 3 pending rounds → `RATE_LIMITED` / refused | API | 3 |
| AT-127 | Guest request that includes a table or session id → the id is ignored or refused; the table always comes from the QR token | API | 3 |
| AT-128 | Session open > 3 h → stale-session alert to the manager; a blocked/maintenance table can't be ordered from by QR | I | 3 |

### 5.2 Sessions, takeaway, delivery

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-12 | New guests scan after checkout → new session; earlier orders invisible | E2E | 3 |
| AT-40 | Guest token from a closed session → `401 VISIT_ENDED`, no data | API | 3 |
| AT-51 | Counter-QR order, guest pays, cashier presses Accept & pay → one transaction: reserved, accepted, settled; ticket + receipt printed once | I, E2E | 3 |
| AT-52 | Accept & pay when an ingredient ran out → nothing committed; "no payment recorded" | I | 3 |
| AT-53 | Counter-QR order never paid → auto-cancelled after 30 min; no stock effect | I | 3 |
| AT-54 | COD order dispatched, rider returns with cash → payment linked to rider in the cashier's shift; settled; outstanding COD back to 0 | I, E2E | 3 |
| AT-55 | Failed delivery cancelled by manager → consumption kept as waste; prepaid amount refunded; no stock credit | I | 3 |
| AT-60 | Card on delivery recorded on return; retried → one payment | I | 3 |
| AT-89 | Prepaid delivery can't be dispatched until settled; COD/card dispatch locks the bill | I | 3 |
| AT-123 | Delivery with no customer details accepted; phone numbers masked in lists | I, E2E | 3 |

### 5.3 Billing, payments, cash

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-10 | Cashier locks the bill while a round is being submitted → lock refused while pending, or submission refused once locked | C | 3 |
| AT-11 | Payment request retried → one payment, one settlement | I, C | 3 |
| AT-34 | Payment after the bill was reopened and changed → `BILL_CHANGED` | I | 3 |
| AT-35 | Split tender cash + card → settled once; change only on cash; shift totals right | I | 3 |
| AT-36 | Refund of a settled invoice → invoice unchanged; refund + ledger reversal; requester ≠ approver | I | 5 |
| AT-37 | Shift close with a variance → expected cash per formula (FINANCE_REPORTING §5); approval by someone else | I | 3 |
| AT-42 | Card number typed as reference → `CARD_NUMBER_NOT_ALLOWED` | API | 3 |
| AT-59 | Transfer without transaction ID → refused; with ID → recorded with provider and confirmer, excluded from expected cash | I | 3 |
| AT-69 | Bill-level discount → shares allocated pro-rata across lines and sum exactly to the discount | U, P | 3 |
| AT-90 | Refund larger than what was paid → `REFUND_EXCEEDS_PAID` | I | 5 |
| AT-91 | Reopening a locked bill that has payments requires step-up approval | API | 3 |
| AT-93 | Discount above the role limit → `STEP_UP_REQUIRED`; with a manager's approval it succeeds | API | 3 |
| AT-115 | Total with paisa after a % discount → rounded to Rs 1 with an explicit rounding line | U | 3 |
| AT-116 | Any attempt to store `tax_total` ≠ 0 → rejected by the database | I | 3 |
| AT-117 | Invoice numbers assigned only at settlement; gapless and unique under concurrent settlements | C | 3 |

### 5.4 Inventory, recipes, costing

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-13 | Only expired lots remain for an ingredient → item unavailable; cannot reserve | I | 4 |
| AT-14 | Scan known / unknown / duplicate barcode → exact SKU / link flow / refused | I, E2E | 4 |
| AT-19 | Recipe or price changed after a sale → old invoices, consumption and margins unchanged | I | 4 |
| AT-29 | Count posted below reserved quantity → adjustment posted; shortfall alert; acceptances for that item blocked | I | 4 |
| AT-30 | Lot expires between acceptance and pickup → consumption posts; `expired_lot_used`; alert | I | 4 |
| AT-31 | Receive 6 × 1 L → 6,000 ml exactly; unit cost to 8 dp | U, I | 4 |
| AT-32 | Convert g ↔ ml without a defined conversion → refused | U | 4 |
| AT-33 | Phase-0 §5.2 milk events → WAC values exactly as in the worked example | U, I | 4 |
| AT-61 | Item without a recipe sold → no reservation/consumption; counted in COGS coverage | I | 4 |
| AT-63 | Activate a recipe with an ingredient that isn't stock-controlled → refused | I | 4 |
| AT-64 | Takeaway cappuccino + oat milk + extra shot → 27.0000 g beans, 157.5000 ml oat milk, 1 cup; dine-in → no cup | U | 4 |
| AT-65 | Last units of a line → consume the exact remaining reservation; reservation closes with no residue | I | 4 |
| AT-66 | COST_VALUATION §10 fixture (drain rule, found stock at last cost) → exact values | U, I | 4 |
| AT-67 | Pickup needs more than on hand after a low count → `auto_found_stock` adjustment then consumption; owner alert | I | 4 |
| AT-68 | Supplier price correction → split stock/variance per COST_VALUATION §6; past periods unchanged | I | 4 |
| AT-94 | Nightly reconciliation finds a deliberately corrupted balance (test DB) → `balance_mismatch` alert; nothing auto-fixed | I | 4 |
| AT-108 | Blind count; variance over threshold needs approval by someone other than the submitter; posting adds a delta | I | 4 |
| AT-109 | Ingredient waste with lot and reason → movement + waste record valued at average | I | 4 |
| AT-110 | Supplier return → valued at current average; ledger cash-in when refunded | I | 4 |
| AT-111 | Low / near-expiry / overstock alerts fire once per item and kind, and resolve when cleared | I | 4 |
| AT-129 | Two non-expired lots with different expiry dates → pickup consumes the earliest-expiring lot first (FEFO) | I | 4 |
| AT-82 | Template import: preview lists row errors; any error saves nothing; `EX-` SKUs refused; re-import updates instead of duplicating; recipes become drafts | I, E2E | 4 |

### 5.5 Finance, reports, audit

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-18 | Waiter calls profit/ledger APIs → 403, audited | API | 2 |
| AT-20 | Dashboard with date/staff/order-type filters → equals detail rows and CSV/PDF exports | I | 6 |
| AT-21 | Scheduled report due while offline → queued; sent after reconnect; status visible | I, S | 6 |
| AT-23 | Asset or expense corrected → reversal/version history; original traceable | I | 5 |
| AT-44 | Sale settled at 00:30 with 04:00 cutoff → previous business date | U, I | 3 |
| AT-70 | Coverage < 100 % → margin over recipe items only; coverage < 95 % → operating result shows "Needs recipes" | U, I | 6 |
| AT-71 | Every payment/refund/purchase payment/expense has exactly one ledger entry; method correction = reversal + new entry | I | 5 |
| AT-95 | Each audited action writes actor, device, before/after, reason, approver | I | 2 |
| AT-96 | UPDATE/DELETE on payments, movements, ledger, audit → rejected by the database | I | 2 |
| AT-97 | Any change to a settled invoice or its lines → rejected by the database | I | 3 |
| AT-103 | CSV export: UTF-8 BOM, ISO dates, plain decimals; PDF footer states formulas and filters | G | 6 |
| AT-104 | Scheduled e-mail retried after failure → same Message-ID; statuses and errors visible | I | 6 |
| AT-105 | Delivery PII older than 12 months → redacted; transactions intact | I | 5 |
| AT-106 | Asset lifecycle (acquired → moved → maintenance → disposed) fully in history | I | 5 |
| AT-107 | Expense voided → reversal entry; original preserved | I | 5 |
| AT-121 | Ledger running balance per channel matches Σ entries for any date range | I | 5 |
| AT-122 | Day-end report totals reconcile with payments, refunds, shifts and open bills | I | 6 |

### 5.6 Access, devices, security

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-38 | User override deny on a role-granted permission → denied server-side; effective-permission preview matches | API | 2 |
| AT-39 | Last active owner tries to disable themselves or drop the owner role → blocked | I | 2 |
| AT-41 | Staff API from an unregistered browser with a valid password → `DEVICE_NOT_REGISTERED` | API | 2 |
| AT-72 | Same Idempotency-Key, different payload → `409 IDEMPOTENCY_KEY_REUSED`; same payload → replay with `Idempotent-Replayed: true` | I | 2 |
| AT-73 | Live updates: a guest stream receives only its own session and menu events; a waiter only in-scope approvals | I | 2 |
| AT-76 | Personal phone registered; revoked by a manager → its sessions end immediately | API | 2 |
| AT-77 | Step-up with approver = requester → refused; token reused or older than 2 min → refused | API | 2 |
| AT-118 | Role/permission changes audited; protected permissions can't be granted to non-owners | API | 2 |
| AT-119 | Owner recovery with code + host admin rights works once and is audited | I | 2 |
| SEC-ALL | Route × role matrix: every staff route returns 403 for every role lacking its permission (generated) | API | 2+ |
| ARCH-01 | Module dependency rules: no cycles; reporting never writes; controllers don't write business tables (dependency-cruiser in CI) | U | 2 |

### 5.7 Operations, printing, resilience

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-15 | Router internet cable removed, LAN up → ordering, pickup, billing, inventory work; e-mail queued | S | 7 |
| AT-16 | Printer unplugged during a kitchen ticket → job durable, visible error, retry or labelled reprint; no duplicate orders | HW | 3 / 7 |
| AT-17 | Host and PostgreSQL restarted → committed sessions, payments, reservations and pending jobs recover | F, D | 2 / 7 |
| AT-22 | Restore onto a replacement PC → system recovers; integrity checks pass; QR codes still work | D | 7 |
| AT-28 | Worker killed after sending bytes → job `uncertain`; no automatic duplicate; reprint labelled | F | 3 |
| AT-43 | Live updates cut for 10 min → resync on reconnect; write buttons disabled while stale | F, E2E | 3 |
| AT-45 | Upgrade vN → vN+1 with live data → pre-upgrade backup, migrations, health green; rollback proven on a copy | D | 7 |
| AT-46 | Counter app (Electron) closed → all other devices keep working | E2E | 2 |
| AT-47 | Host rebooted, nobody logs in → database, API and worker running; devices reconnect | F | 2 |
| AT-56 | Power cut to the iMac during order entry and payment (no UPS) → committed data intact; retries create no duplicates; WAL archive intact | D | 7 |
| AT-57 | Single printer out of paper with a ticket and a receipt queued → both held, then printed in order, once | HW | 3 |
| AT-58 | ISP router rebooted → server keeps 192.168.100.250; QR still works | S | 7 |
| AT-79 | System clock earlier than the latest stored timestamp at startup → API stays "starting"; clock alert | I, F | 2 |
| AT-80 | Backup drive removed → archive-failure banner within 15 min; WAL catches up when reinserted | D | 7 |
| AT-81 | Weekly automated test restore runs integrity checks; a failure alerts the owner | I, D | 7 |
| AT-83 | Kitchen ticket golden output: no "Rs" or decimal amounts; correction, void and reprint banners present | G | 3 |
| AT-84 | Receipt golden output: every line ≤ 48 characters; totals aligned; reprint label | G | 3 |
| AT-85 | RAW printing from the worker's service account on the real printer | HW | 3 |
| AT-120 | Health page reflects DB down, worker stale, printer error, backup age, disk space, internet offline | I, F | 2 |

### 5.8 User interface

| ID | Scenario → expected | Level | Phase |
|---|---|---|---|
| AT-86 | Automated accessibility scan (axe) on key screens: no serious issues; all text pairs AA; focus visible | E2E | 3 |
| AT-87 | Counter keyboard: `/` search, `↑↓`, `Enter`, `F2` lock, `F4` cash, `F5` card, `Esc` closes | E2E | 3 |
| AT-126 | Dietary/allergen tags entered by the owner are shown on the guest menu exactly as entered; nothing is inferred | E2E | 3 |
| AT-130 | Owner settings (business hours, thresholds, branding, printer routing) take effect and are audited; a brand colour failing AA contrast for button text is refused | I, E2E | 3 |
| UX-J1…J8 | Prototype journeys (UI_UX.md §7) rebuilt as E2E tests and timed in UAT against their targets | E2E, UAT | 3–7 |

## 6. Concurrency suite

| ID | Race (ORDER_STATE_MACHINE / phase-0 §4.9) | Pass condition |
|---|---|---|
| CT-01 | Two staff accept the same round | One acceptance; other gets `ROUND_ALREADY_DECIDED` |
| CT-02 | Two rounds compete for the last stock | Available never < 0 |
| CT-03 | Two guests open the same empty table | One session; both joined |
| CT-04 | Guest submits while cashier locks | Consistent outcome per AT-10 |
| CT-05 | Pickup vs cancel on the same units | Each unit changes once |
| CT-06 | Two cashiers pay the same invoice | No overpayment; one settlement |
| CT-07 | Price edit while round pending | Price lock rules hold |
| CT-08 | Recipe activation while rounds pending | Each round snapshots exactly one version |
| CT-09 | Count posting vs pickups on the same item | Balance = Σ movements afterwards |
| CT-10 | Two managers edit the same menu item | Second gets `STALE_STATE` |

Each race runs ×10 per commit and ×100 nightly. Any single failure blocks the build.

**Harness (built in Phase 2, step 2.10):** `apps/server/test/support/concurrency.ts`. Every contender gets its own database connection; contenders meet at a `Barrier` right before the racing statement, so they really overlap; `waitUntilBlocked` proves that one transaction queued behind another's lock; a contender that never releases its connection fails the test. Runs per race come from `CL_RACE_RUNS` (default 10). Nightly: `CL_RACE_RUNS=100 corepack pnpm test`. The harness self-tests (`test/harness/concurrency.test.ts`) show it catches a lost update deterministically, and run gapless numbering and idempotency under real overlap.

## 7. Property-based suite

| ID | Property |
|---|---|
| PT-01 | For random sequences of receipts, reservations, pickups, cancels, waste and counts: `on_hand = Σ qty_delta`, `reserved = Σ open reservations`, `value = Σ value_delta`, nothing negative |
| PT-02 | WAC: value reaches exactly 0 whenever quantity reaches 0 (drain rule); average stays within [min, max] receipt cost |
| PT-03 | Discount allocation: shares are ≥ 0 and sum exactly to the bill discount |
| PT-04 | UOM: kg ↔ g and l ↔ ml round-trip exactly; cross-dimension always refused |
| PT-05 | Refunds per invoice never exceed payments |
| PT-06 | Line counters: any sequence of pickup/serve/cancel/void respects the database CHECK invariants or is refused |
| PT-07 | Invoice: `total = subtotal − discounts + tax(0) + rounding` for random carts and discounts |
| PT-08 | Money: half-up rounding to 2 dp; formatting/parsing round-trip without loss |

**Harness (built in Phase 3, step 3.2):** `apps/server/test/support/random.ts`, a seeded generator with no extra dependency. Runs per property come from `CL_PROP_RUNS`; a failure names its seed and `CL_PROP_SEED=<seed>` replays it exactly. Before a phase exit: `CL_PROP_RUNS=100 corepack pnpm test`. Phase 3 ran PT-01 without receipts and counts; since Phase 4 step 4.10 it runs the full mix (receipts, counts, returns, cost corrections, expiring lots) and PT-02 on the costing functions; the PT-01 test fails when release forgets to lower the reserved quantity (checked by hand).

## 8. Non-functional acceptance (target hardware)

| ID | Criterion | Measured on |
|---|---|---|
| AC-PERF-1 | p95 API latency ≤ 300 ms, p99 ≤ 1 s for ordering, pickup and payment with 3 tablets + 6 phones + counter PC + 30 guest phones and a 120 lines/hour burst for 30 min | Counter iMac via real Wi-Fi |
| AC-PERF-2 | p95 live-update delivery ≤ 1 s, p99 ≤ 2 s | Same |
| AC-PERF-3 | Guest menu first load ≤ 2.5 s on a mid-range Android phone | Shop Wi-Fi |
| AC-PERF-4 | Month-range owner reports ≤ 3 s with one year of synthetic data | Counter iMac |
| AC-REC-1 | Services ready ≤ 3 min after Windows boots following a power cut; no committed data lost | Counter iMac, plug pulled |
| AC-REC-2 | Full restore onto another Windows PC ≤ 2 h following BACKUP_RECOVERY.md | Spare PC |
| AC-INV-1 | Nightly reconciliation: 0 mismatches over the UAT period | Target |
| AC-FIN-1/2/3 | Invoice equations, no duplicate payments, shift/day-end reconciliation: 100 % | CI + target |
| AC-RPT-1 | Every KPI = drill-down = export, to the rupee | CI |
| AC-SEC-1 | Route × role authorisation coverage 100 % | CI |
| AC-KDS-1 | No price on any kitchen output | CI + printed sample |
| AC-UX-1 | Journeys J1–J8 completed by ≥ 4 of 5 staff without help within target | UAT |
| AC-UX-2 | WCAG 2.1 AA contrast and ≥ 44 px targets | CI + manual |
| AC-UX-3 | Every screen has loading, empty, error, offline and unauthorised states | Design review + E2E |

Targets are proposals until measured on the iMac (Windows 10, i5-2500S). If a target can't be met on this hardware, the result is reported with the measured value, never hidden.

## 9. Site, hardware and drills

| Suite | Content | Source |
|---|---|---|
| SITE-N1…N9 | Network acceptance (static IP survives router reboot, guest phones on both bands, iPhone with Private Relay, every table, port probes, certificate on staff devices, internet unplugged, router power cycle) | LOCAL_LAN_HOSTING.md §7 |
| HW-01…HW-10 | Printer ports and self-test, driver, RAW print from service account, golden ticket and receipt, cut, paper-out detection, unplug during print, scanner suffix and symbologies | PRINTING_HARDWARE.md §8 |
| HOST-H1…H18 | Host preparation checklist incl. auto power-on, write-safety (`pg_test_fsync`), clock check, firewall | WINDOWS_DEPLOYMENT.md §3 |
| DRILL-1…4 | Restore to another PC; power cut during service; backup drive swap; owner opens a backup with the private key | BACKUP_RECOVERY.md §7 |

## 10. User acceptance (Phase 7)

Two scripted **service sessions** of ~90 minutes each with real staff on the real equipment (internet disconnected for the second):

| ID | Role | Script highlights | Sign-off |
|---|---|---|---|
| UAT-01 | Guests (staff acting) | QR orders at 4 tables, add-on rounds, an out-of-stock rejection, counter-QR takeaway | Owner |
| UAT-02 | Waiters | Assigned tables, approvals, staff rounds, pickups with undo, transfer a table | Manager |
| UAT-03 | Cashier | Bills, discounts within and over limit, cash/card/JazzCash, split tender, refund request | Owner |
| UAT-04 | Cashier + rider | Two deliveries (COD and prepaid), one failed and resolved | Manager |
| UAT-05 | Clerk | Receive a real delivery with lots, a waste entry, a blind count with one variance | Owner |
| UAT-06 | Owner | Day-end report, margin with coverage, ledger, audit search, export PDF/CSV | Owner |
| UAT-07 | Everyone | Printer out of paper mid-service; router reboot; counter PC power cut | Owner |
| UAT-08 | Owner | Restore drill result reviewed; backup key check | Owner |

Each session ends with the reconciliation checks (AC-INV-1, AC-FIN-3) run on that day's data.

## 11. Traceability

- **[traceability.csv](traceability.csv)** maps every SRS requirement (MENU, TABLE, ORD, KDS, INV, PAY, FIN, RPT, OPS: 94 IDs), every non-functional requirement (NFR-01…NFR-12) and every behaviour-changing owner decision (D-xx) to the tests above.
- An automated check (run in CI from Phase 2) fails if any requirement has no test, or a test ID in the CSV doesn't exist in this document.
- Requirements marked **[R/TBD]** in the SRS are traced to the decision that resolved them.
- Test number AT-98 is unused (reserved). Run the check: `corepack pnpm check:trace` (scripts/check-traceability.mjs; reads the SRS from docs/source/).

## 12. Defects and release rules

| Severity | Definition | Release rule |
|---|---|---|
| Critical | Wrong money, lost or duplicated order/payment/stock, security breach, data loss | Blocks any release |
| High | Core journey blocked with no workaround; wrong report figure | Blocks release |
| Medium | Workaround exists; cosmetic issue on a money screen | Release allowed with documented workaround (KNOWN_ISSUES.md) |
| Low | Cosmetic | Fix when convenient |

Go-live (Gate after Phase 7) requires: all suites in §5–§10 passed on target, zero open Critical/High defects, KNOWN_ISSUES.md reviewed by the owner, and signed UAT sheets.
