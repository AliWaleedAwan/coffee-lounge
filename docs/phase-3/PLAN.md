# Phase 3 — Order-to-Cash Build Plan

> **For owner approval before any Phase 3 code.** Builds on the approved design (G1) and the finished Phase 2 foundation (`docs/phase-2/PLAN.md`, all steps ✅). Where the Phase 0 roadmap and later decisions differ, the decisions win (§3).

| | |
|---|---|
| Goal | A guest or waiter orders, staff accept, the kitchen ticket prints, the waiter or cashier picks it up, the bill is paid and the receipt prints, on the shop LAN with the internet unplugged. Takeaway (counter QR) and staff-entered delivery work end to end. |
| Estimate | 5–7 weeks (roadmap §9.2), delivered in 13 steps, each ending with its tests green, verify and Windows CI green, and a commit |
| Exit criteria | TEST_PLAN.md §4 (Phase 3 row): every Phase 3 test in §5 green; concurrency CT-01…CT-06 green ×100; **golden kitchen ticket and receipt approved by you**; first hardware contact HW-01…HW-04 recorded on the real printer |
| Exit demo | AT-15: a full dine-in day on several devices on the LAN, internet unplugged |

## 1. In and out of Phase 3

| In Phase 3 | Later |
|---|---|
| Menu: categories, items, variants, modifiers, availability, price history, scheduled promotions (D-14 launch subset), dietary tags as entered | Recipe editor, purchasing, receiving, lots and expiry, counts, waste UI, valuation reports: **Phase 4** |
| A minimal ingredient model so acceptance can reserve stock and pickup can consume it (roadmap §9.1). Items without a recipe run as non-stock (R-4) | Refunds, ledger, expenses: **Phase 5** |
| Tables, QR entry points and the printable QR sheet, sessions, guest tokens, assignments, transfers | Reports and exports: **Phase 6** |
| Guest app, waiter app, counter screens, manager approvals, owner settings used by ordering and billing | Site, drills, load test, UAT: **Phase 7** |
| Kitchen tickets, Picked up (D-33), cancellations, voids, comps | |
| Live bill, lock and reopen, discounts, payments (cash, manual card, transfers), split tender, receipts, cash shifts | |
| Takeaway with counter QR (D-05b), staff-entered delivery with riders (D-05) | |
| Printing: renderer, job queue, network and Windows-spooler paths | |

## 2. Decisions this phase implements

D-05 delivery · D-05b counter QR, pay first · D-06 reject the whole round when stock is short · D-07 acceptance scope, one atomic acceptance, staff rounds straight to the kitchen · D-08 30-minute price lock · D-09 auto-join, reset guests · D-12 rounds after a bill request are flagged; no lock while a round is pending · D-13 split tender, no split bill · D-14 discounts and promotions (launch subset) · D-16 `tax_total = 0`, Rs 1 rounding line · D-17 80 mm, ticket on acceptance, receipt at settlement, labelled reprints · D-22 Asia/Karachi, 04:00 cutoff, one shift per cashier · D-24 PIN switching · D-33 no kitchen device: **Picked up** = prepared = consumption · D-36 escalation after 3 minutes · D-37 card terminal on delivery, transfers with a reference · D-40 unpaid counter-QR orders cancel after 30 minutes.

## 3. Changes from the Phase 0 roadmap

| Roadmap item | In this plan | Why |
|---|---|---|
| KDS screens | None. A **Pickup** list on waiter devices and the counter | D-33 (no kitchen device) |
| Drawer kick | None. The decoder already flags any drawer pulse in tests | No cash drawer (D-03) |
| AT-55 "prepaid amount refunded" | Proposal P3-1 below | Refunds are Phase 5 (AT-36, AT-90) |

## 4. Build order

Each step is a vertical slice: database migration, API, screens and tests together. Screens follow UI_UX.md and the prototypes.

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 3.1 ✅ | **Menu and catalogue.** Migrations for DATABASE.md §4 (categories, items, variants with price history, modifier groups and options, promotions and targets). Staff menu API with availability; catalogue CRUD (standard pattern, `expectedVersion`); price change history; promotion rule engine (best single promotion, day and time windows). Owner/manager catalogue screens; dietary tags shown exactly as entered | AT-112, AT-113 (rules and unit tests; the `VALIDATION_FAILED` answer arrives with round submission in 3.4), AT-126 (staff side; guest side in 3.11), CT-10, SEC-ALL for new routes | Phase 2 |
| 3.2 | **Minimal ingredient model.** Migrations for the parts of DATABASE.md §5 and §8 that acceptance and pickup need: units, inventory items with the stock-controlled flag, balances, the active recipe version and its components, modifier recipe rules, reservations, consumption and waste movements, line cost snapshots (weighted average, D-04). Sample data loads from a fixture or CSV; there is **no recipe editor** yet (Phase 4). Non-stock items never block and never move stock | Property tests: balance = Σ movements, reserved = Σ open reservations, nothing negative (PT-01 subset) | 3.1 |
| 3.3 | **Tables, QR codes and sessions.** Tables, QR entry points (table and counter), signed entry cookie, guest tokens, auto-join, reset guests, assignments to waiters, transfer, blocked tables, stale-session alert. Printable QR sheet (A4, with the shop address in the URL, LOCAL_LAN_HOSTING.md). Floor plan API and waiter floor screen | AT-09, AT-12, AT-40, AT-74, AT-100, AT-127, AT-128, CT-03 | 3.1 |
| 3.4 | **Rounds and acceptance.** Guest submission (customer API, idempotent, rate-limited, price quotes), staff rounds straight to the kitchen, approval queue by scope (D-07) with 3-minute escalation (D-36), **atomic acceptance with stock reservation** (lock order, DATABASE.md §14), price lock (D-08), whole-round rejection with a reason (D-06), flags after a bill request. Waiter composer and approvals screens; guest menu, cart and status | AT-01…AT-04, AT-08, AT-24…AT-26, AT-48…AT-50, AT-78, AT-101, AT-124, AT-125, CT-01, CT-02, CT-07 | 3.2, 3.3 |
| 3.5 | **Kitchen tickets and pickup.** Kitchen tickets (no prices: structurally impossible, AT-99), Picked up = consumption + line cost frozen, served, cancellation ("was it already made?"), void and comp with reason and cost, the 5-second Undo held on the device (UI_UX.md R5-3), uncollected and stale-reservation alerts. Pickup screen on waiter devices and the counter | AT-05…AT-07, AT-27, AT-62, AT-88, AT-92, AT-99, CT-05 | 3.4 |
| 3.6 | **Printing.** Printers, print jobs and their lifecycle (queued → sending → sent / retrying / needs attention / uncertain), ESC/POS renderer for kitchen ticket and receipt (48 columns, labelled reprints, correction and void banners), worker print task with **both** paths: raw TCP 9100 and the Windows spooler in RAW mode from the service account. Printer banner and job screen. Golden outputs reviewed by you. Also W-3 from Phase 2 (log retention) as a worker housekeeping job | AT-16, AT-28, AT-57, AT-83, AT-84, golden files; on the real printer later: AT-85, HW-01…HW-04 | 3.5 |
| 3.7 | **Bill, discounts, payments.** Live bill, lock and reopen (step-up when payments exist), manual discounts within role limits with step-up above (D-14), pro-rata allocation, Rs 1 rounding line (D-16), payments: cash with change, card with approval code (never card numbers), JazzCash / Easypaisa / bank transfer with a reference; split tender; settlement with gapless invoice numbers and the 04:00 business date; receipt and labelled reprint. Counter bill and payment screens with keyboard shortcuts | AT-10, AT-11, AT-34, AT-35, AT-42, AT-44, AT-59, AT-69, AT-91, AT-93, AT-97, AT-115…AT-117, AT-87, CT-04, CT-06 | 3.5, 3.6 |
| 3.8 | **Cash shifts.** Open with float, paid-in and paid-out, close with counted cash, expected-cash formula (FINANCE_REPORTING.md §5), variance approved by someone else. Shift screens | AT-37 | 3.7 |
| 3.9 | **Takeaway and counter QR.** Counter-QR sessions per guest, unpaid queue, **Accept & pay** as one transaction (reserve, accept, settle, print once), auto-cancel after 30 minutes (D-40) as a worker job, cashier quick takeaway | AT-51…AT-53, AT-75 | 3.7, 3.8 |
| 3.10 | **Delivery.** Staff-entered delivery orders with optional customer details (masked in lists), riders without logins, prepaid / COD / card on delivery, dispatch locks the bill, return with handover in the cashier's shift, failed-delivery resolution by a manager. Delivery board | AT-54, AT-55 (see P3-1), AT-60, AT-89, AT-114, AT-123 | 3.7, 3.8 |
| 3.11 | **Guest app finished.** Customer listener serves the guest app (second entry of `apps/web`, same tokens): QR landing, menu with "Unavailable right now", item sheet, cart, sent and status timeline, add more, request bill, counter-QR "pay at the counter", visit ended, not on the shop Wi-Fi | UX-J1, AT-86 (guest screens) | 3.4, 3.9 |
| 3.12 | **Staff and owner screens finished.** Manager live operations and approvals inbox, table assignments, owner settings used so far (business hours, thresholds, branding colour with contrast check, printer routing), every required state from UI_UX.md §8 | AT-130, AT-43 (screens stale after a 10-minute cut, then resync), AT-86 (staff screens), UX-J2…UX-J6 as E2E tests | 3.5–3.10 |
| 3.13 | **Phase 3 acceptance.** Concurrency CT-01…CT-06 ×100, full Phase 3 suite, AT-15 LAN day with several browser contexts and the internet unplugged, Windows CI with the print spooler path, then on site: HW-01…HW-04 and the golden ticket and receipt on the real printer | Phase 3 exit criteria | 3.1–3.12, your printer details |

## 5. What I need from you, and when

| # | Input | Needed by | Without it |
|---|---|---|---|
| I-1 | Printer rear-port photo and self-test page (D-03) | Step 3.6 (connection path); exit HW-01…HW-04 | Both paths get built and tested against the simulator and a virtual Windows printer; the real-printer checks wait |
| I-2 | Router screenshots with passwords blurred (guest isolation, DHCP range) | Before QR codes are printed (step 3.3 sheet, R-1) | The QR sheet can be built but not trusted on site |
| I-3 | Tablet models and one staff phone model | Step 3.4 screens | Layouts tested at standard sizes only |
| I-4 | Your menu (items, sizes, prices, modifiers); recipes can come later in Phase 4 | The exit demo (3.13) | Sample menu used throughout |
| I-5 | Review of the golden kitchen ticket and receipt (wording, logo, address) | Step 3.6 | Exit criterion stays open |
| I-6 | A slot for the iMac dry run (carried from Phase 2: W-1, W-6, Windows 10 itself) | Any time; ideally before 3.13 | Windows 10 behaviour stays proven only on Windows Server in CI |

## 6. Proposals that need your approval

| # | Proposal | Recommendation |
|---|---|---|
| P3-1 | AT-55 expects a prepaid failed delivery to be **refunded**, but refunds (owner step-up, requester ≠ approver, ledger reversal) are Phase 5 | Phase 3 cancels the order, keeps the consumption as waste and marks the payment **refund due**; Phase 5 records the refund itself. AT-55's refund assertion moves to Phase 5 |
| P3-2 | Guest app location | A second entry in `apps/web` (shared tokens and components), served only on the customer listener; staff routes stay unreachable there |
| P3-3 | Print paths before I-1 arrives | Build both: raw TCP 9100 (simulator) and the Windows spooler RAW path tested in CI on a virtual printer, so whichever port the SNC-101 has is ready |
| P3-4 | W-1 from Phase 2 (a dead PostgreSQL postmaster is not restarted by Windows) | Decide at the iMac dry run; not needed for Phase 3 work |
| P3-5 | Sample data for development and the demo until I-4 arrives | A realistic sample menu of about 40 items with sizes, milk and syrup modifiers, and 15 stock-controlled ingredients |

## 7. Risks

| Risk | Mitigation |
|---|---|
| The SNC-101 behaves differently from the simulator (R-2, R-11) | Both print paths; durable jobs; screen fallback (kitchen tickets always visible on the Pickup list); first hardware contact as soon as I-1 arrives |
| Guest phones cannot reach the shop server (R-1) | IP-based QR URL; router check from I-2; waiters can always order for the table |
| Acceptance races under real load | Lock order from DATABASE.md §14, concurrency suite ×100 with the Phase 2 harness |
| Partial-quantity pickup and cancellation are easy to get wrong | Line counters enforced by database checks (PT-06), explicit "was it already made?" step |
| Scope is large for one phase (13 steps) | Each step is shippable on its own; you can reorder or stop after any step |

## 8. Working rules (unchanged from Phase 2)

- Every step ends with its tests passing, `corepack pnpm verify` green, Windows CI green and a commit pushed to `phase-3/order-to-cash` (branched from `phase-2/foundation`); nothing is reported as done without test output.
- Migrations are forward-only and follow DATABASE.md; any deviation is recorded in DATABASE.md §15 in the same commit.
- No business data beyond samples; no secrets in the repository.
- Hardware results are never claimed until tested on the real device.
