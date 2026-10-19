# 08 — Quality, Acceptance Criteria & Test Plan

> Phase 0 · Test strategy and measurable acceptance criteria. Numeric performance targets are **proposals to be confirmed by benchmarking on the chosen host hardware** (SRS §8). They are not guarantees.

## 8.1 Test layers & tooling

| Layer | Tool | Runs against | Purpose |
|---|---|---|---|
| Unit | Vitest | Pure functions | Decimal math, price resolution, recipe explosion, UOM conversion, WAC/FIFO maths, state-machine transition tables, ESC/POS rendering |
| Property-based | fast-check | Pure functions + DB | Inventory conservation (Σ movements = balance), rounding invariants, discount allocation sums to bill discount, UOM round-trips |
| Integration (transactional) | Vitest + **real PostgreSQL** (disposable DB per test file) | Services + DB | Every critical atomic operation, constraints, triggers, idempotency replay |
| Concurrency | Custom harness: N parallel connections/requests with barriers | API + DB | Races C-1 … C-10 (04-workflows §4.9), repeated 100+ times per run to surface timing bugs |
| API authorisation | Generated test per route × role | API | Every route rejects every role lacking the permission (403) and logs where required |
| End-to-end | Playwright, multiple browser contexts (guest, waiter, KDS, cashier) | Full stack | Critical journeys and cross-device realtime |
| Print | ESC/POS **printer simulator** (TCP 9100 server that records bytes and can simulate paper-out, disconnect, slow ack) + golden files | Worker | Template output, retries, uncertain-state handling |
| Fault injection | Scripts: kill API/worker mid-transaction, restart PostgreSQL, drop SSE, network toxics (toxiproxy) | Full stack | Recovery behaviour (§4.10) |
| Load | k6 | Staging on target-like hardware | Latency/throughput targets |
| Report reconciliation | SQL fixtures with hand-computed expected outputs | Reporting | KPI = Σ detail rows = CSV = PDF |
| Windows packaging | Windows CI runner + a clean VM | Installer | Install, service start on boot, upgrade, rollback, uninstall |
| Hardware (on site) | Checklist with evidence (photos/logs) | Real printers/drawer/scanner/router | Things simulators cannot prove |
| Restore drill | Scripted | Clean replacement machine/VM | Backup restorability + integrity checks |

**CI gates** (every merge): lint, type-check, dependency-cycle check, unit + property + integration + authorisation tests, migration up-test on a fresh DB, and migration from the previous release's schema with seed data. Nightly: concurrency suite (extended iterations), E2E, fault injection.

## 8.2 Measurable acceptance criteria

### Correctness invariants (must be 100 %, any failure is a release blocker)

| ID | Criterion | Evidence |
|---|---|---|
| AC-INV-1 | For every item, `on_hand` equals Σ `qty_delta` of its movements, and `reserved` equals Σ active reservation remainder | Nightly reconciliation job output = 0 mismatches; property tests |
| AC-INV-2 | No accepted acceptance ever leaves `available < 0` | Concurrency suite: 1,000 iterations of competing acceptances on scarce stock |
| AC-INV-3 | Each prepared quantity produces exactly one consumption per ingredient | Retry/duplicate tests; unique source-key violations caught and replayed |
| AC-FIN-1 | Every settled invoice: `total = Σ net lines − bill discounts + tax(0) + rounding`; `Σ payments − change = total` (with refunds tracked separately) | Integrity query = 0 violations |
| AC-FIN-2 | No duplicate payments under retries/double-clicks | 500 parallel duplicate submissions → exactly 1 payment |
| AC-FIN-3 | Day-end/shift report totals equal the sum of underlying payments/refunds | Reconciliation tests on fixture days |
| AC-RPT-1 | Every dashboard KPI equals its drill-down detail rows and its CSV/PDF export for the same filters (to the rupee) | Automated comparison per KPI per filter preset |
| AC-SEC-1 | 100 % of staff routes have an authorisation test for every role | Coverage report of the route × role matrix |
| AC-KDS-1 | No kitchen ticket/KDS payload contains price/payment fields | Schema test + golden ticket tests + payload scan |

### Performance & realtime (proposed; confirm on target hardware)

| ID | Criterion | Load profile |
|---|---|---|
| AC-PERF-1 | p95 API latency ≤ 300 ms for ordering/KDS/checkout actions; p99 ≤ 1 s | 3 waiter + 2 KDS + 1 reception + 1 manager + 25 concurrent guest phones; 120 order lines/hour burst for 30 min |
| AC-PERF-2 | p95 SSE hint delivery ≤ 1 s, p99 ≤ 2 s on healthy Wi-Fi | Same |
| AC-PERF-3 | Customer menu first load ≤ 2.5 s on a mid-range Android phone on shop Wi-Fi | Lighthouse/real device |
| AC-PERF-4 | Standard owner reports (month range) render ≤ 3 s with 1 year of synthetic data | 300k lines, 1.5M movements |
| AC-REC-1 | After host power-cut, services are ready ≤ 3 min after Windows boot with no committed data lost | Fault test on target hardware |
| AC-REC-2 | Restore from backup on a clean machine ≤ 2 h following the runbook | Drill evidence |

### Usability (prototype and UAT)

| ID | Criterion |
|---|---|
| AC-UX-1 | Journeys in 06-ui-ux §6.7 met by ≥ 4 of 5 test participants without assistance |
| AC-UX-2 | WCAG 2.1 AA contrast for all text (automated + manual check), touch targets ≥ 44 px |
| AC-UX-3 | Every screen has designed loading, empty, error, offline/reconnecting and unauthorised states |

## 8.3 Test scenario catalogue

SRS AT-01 … AT-23 are adopted unchanged as the acceptance baseline. Additional scenarios cover gaps found in discovery:

| ID | Area | Given / When | Expected |
|---|---|---|---|
| AT-01 … AT-23 | (SRS §9) | — | As specified in SRS |
| AT-24 | Orders | Guest double-taps Submit / network drops after commit and client retries | One round; the retry returns the same round number |
| AT-25 | Orders | Price raised between submission and acceptance | Guest is charged the quoted price per D-08 rule; adjustment recorded |
| AT-26 | Orders | Waiter with `orders.accept` submits round with one unavailable line | Nothing saved; affected lines flagged; cart preserved |
| AT-27 | Kitchen | Ready tapped for qty 2 of a qty-3 line, then the remaining 1 is cancelled | 2 units consumed, 1 unit reservation released; counters consistent |
| AT-28 | Kitchen | Worker killed after sending bytes, before marking sent | Job becomes `uncertain`; no automatic duplicate; reprint labelled REPRINT |
| AT-29 | Inventory | Count posts lower than reserved quantity | Adjustment posted; shortfall alert; new acceptances for that item blocked |
| AT-30 | Inventory | Lot expires between acceptance and Ready | Consumption still posts truthfully; `expired_lot_used` flagged; alert raised |
| AT-31 | Inventory | Pack conversion "6 × 1 L" received | 6,000 ml posted; cost per ml exact to 8 dp; no float drift |
| AT-32 | Inventory | Attempt to convert g ↔ ml without a defined conversion | Rejected |
| AT-33 | Costing | Fixture of §5.2 events | WAC (or FIFO) values exactly match the worked example |
| AT-34 | Checkout | Payment attempted after the bill was reopened and changed | `409 BILL_CHANGED`; no payment |
| AT-35 | Checkout | Split tender cash + card | Invoice settled once; change only on the cash portion; shift totals correct |
| AT-36 | Checkout | Refund of settled invoice | Invoice unchanged; refund record + ledger reversal; requester ≠ approver enforced |
| AT-37 | Cash | Shift close with variance | Expected cash = float + cash payments − cash refunds ± paid-in/out; variance requires approval |
| AT-38 | RBAC | User override deny on a role-granted permission | Denied server-side; UI hides; effective-permission preview matches |
| AT-39 | RBAC | Last owner tries to disable themselves / remove owner role | Blocked |
| AT-40 | Security | Guest token from a closed session used against customer API | 401 "visit ended"; no data returned |
| AT-41 | Security | Staff API called from an unregistered browser with valid password | Rejected (device not registered) |
| AT-42 | Security | Card number typed into card reference | Rejected by validation |
| AT-43 | Realtime | SSE disconnected for 10 min while orders change | On reconnect: resync; UI equals server state; write buttons were disabled while stale |
| AT-44 | Time | Sale settled at 00:30 with business-day cutoff 04:00 | Counted in the previous business date |
| AT-45 | Upgrade | Install vN+1 over vN with live data | Pre-upgrade backup taken; migrations applied; health green; rollback procedure verified on a copy |
| AT-46 | Electron | Reception app closed | All other devices keep working |
| AT-47 | Startup | Host rebooted, nobody logs into Windows | API, worker and DB running; devices reconnect |
| AT-48 | Acceptance routing | Assigned waiter, another waiter, cashier and manager all press Accept on the same QR round at once | Exactly one succeeds; others see "accepted by …"; one ticket, one reservation; the unassigned waiter's request is refused with 403 even when sent directly to the API |
| AT-49 | Acceptance routing | Table reassigned to waiter B while waiter A's accept request is in flight | Only the waiter assigned at commit time can accept; no double acceptance |
| AT-50 | Escalation | QR round pending > 3 min (D-36) | Highlighted to manager and cashier; cashier accept now allowed |
| AT-51 | Takeaway | Counter-QR order, guest pays, cashier presses Accept & pay with sufficient stock | One transaction: reserved, accepted, settled, kitchen ticket + receipt printed once |
| AT-52 | Takeaway | Accept & pay when an ingredient ran out after submission | Nothing committed; screen says no payment recorded; round rejected with reason |
| AT-53 | Takeaway | Counter-QR order never paid | Auto-cancelled after 30 min (D-40); no stock movement |
| AT-54 | Delivery | COD order dispatched, rider returns with cash | Payment linked to rider in the cashier's shift; invoice settled; delivered; COD outstanding report back to zero |
| AT-55 | Delivery | Delivery failed → manager cancels | Consumption kept and classified as waste; prepaid amount refunded via refund flow; no stock credit |
| AT-56 | Power | Power cut to host (no UPS) during order entry and payment | After restart: committed rounds/payments intact; in-flight requests retried with the same key produce no duplicates; WAL archive on USB intact |
| AT-57 | Printing | Single counter printer out of paper with a kitchen ticket and a receipt queued | Both jobs held and visible; after paper is loaded, printed in order once; kitchen order also visible on screen |
| AT-58 | Network | Router reboot (ISP-managed) | Host keeps its static IP; QR URL still valid; clients reconnect |
| AT-59 | Payments | Transfer payment (JazzCash) without a transaction ID | Rejected; with an ID it's recorded with provider and confirming staff, excluded from expected cash |
| AT-60 | Delivery | Card on delivery via portable terminal; recorded on rider's return | Card payment linked to rider, settled once; retry with the same key → no duplicate |
| AT-61 | Data | Menu item sold before its recipe exists (weekly data entry, D-29) | Sold as non-stock (no reservation/consumption); reports show it under "COGS incomplete" |
| AT-62 | Kitchen | Accepted line cancelled before pickup, answer "already made: yes" | Consumption + waste recorded; no reservation left open |

## 8.4 Hardware & site verification sheet (per device, before go-live)

| Check | Evidence |
|---|---|
| Model, firmware, connection (USB/LAN/BT), IP/port, paper width | Recorded in `PRINTING_HARDWARE.md` |
| Prints kitchen ticket + receipt templates correctly (code page, Urdu/special characters if needed) | Photo of output |
| Paper-out, cover-open, power-off behaviour as detected by the system | Screenshot of diagnostics + job state |
| Cash drawer: **not installed** (D-03), so drawer integration is not tested and must not be claimed as working | — |
| Counter host: auto power-on after a power cut (iMac setting), boots straight into Windows, services up without login | Test log with timings |
| Barcode scanner: suffix (Enter), speed, symbologies of supplier barcodes | Scan log with sample products |
| Router: guest→host reachability, staff/guest separation, captive portal behaviour, client isolation off for the required path | Test from iOS + Android guest phones |
| Wi-Fi coverage at every table and the kitchen | Signal survey notes |
| UPS: runtime and clean shutdown signal (**only if one is added, D-35**) | Test log |

## 8.5 Evidence & reporting

- Each phase ends with a **test evidence pack**: CI run links, concurrency/fault reports, reconciliation outputs and screenshots.
- A requirement → test traceability table (requirement ID → test IDs → latest result) is maintained in `docs/TEST_PLAN.md` from Phase 2.
- No feature or hardware integration is labelled "production-ready" without its tests passing on the **target hardware**. Hardware not yet supplied is reported as "simulator-verified only".
