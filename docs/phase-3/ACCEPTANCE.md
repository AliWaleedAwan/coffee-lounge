# Phase 3 acceptance (step 3.13)

Status on 25 October 2026, branch `phase-3/order-to-cash`. Everything that can be proven in software is green. Two exit criteria need the shop: the real printer (I-1) and your approval of the printed layouts (I-5).

## 1. Exit criteria (PLAN.md, TEST_PLAN.md §4 Phase 3 row)

| Criterion | Status | Evidence |
|---|---|---|
| Every Phase 3 test in TEST_PLAN.md §5 green | ✅ in software; AT-85 waits for the printer | 73 Phase 3 test IDs, each mapped to its test below. `corepack pnpm verify`: 428 tests green. E2E: 16 journeys green on installed Chrome |
| Concurrency CT-01…CT-06 green ×100 | ✅ | `CL_RACE_RUNS=100` on every race test, and ×1,000 on CT-01…CT-06 (about 6,000 contested runs, 43 s) |
| Golden kitchen ticket and receipt approved by you | ⏳ **Your review (I-5)** | `apps/server/test/printing/golden/`: kitchen ticket (new, supplement, correction, void, reprint, 58 mm takeaway), receipt and reprint, shift report, test page |
| First hardware contact HW-01…HW-04 on the real printer | ⏳ **On site (I-1)** | Checklist in §4 below |
| Exit demo AT-15: a dine-in day on several devices, internet unplugged | ✅ rehearsed; ⏳ on site with the real router | `apps/web/e2e/workday.spec.ts` "AT-15": counter PC, waiter tablet and guest phone serve two tables (staff round, guest QR round accepted by the waiter, pickup, bill request, cash and card, shift close balanced) while every browser may reach the shop's server only; any other request is refused and recorded, and there are none |
| Windows CI with the print spooler path | ✅ | Every step's CI: unattended install on Windows Server 2022, all smoke checks, and a RAW print through a "Generic / Text Only" queue from the worker's service account (481 bytes) |

## 2. Longer runs before the exit

| Run | Result |
|---|---|
| Races ×100 (`CL_RACE_RUNS=100`): CT-01…CT-06, CT-07 (price edit vs acceptance), Accept & pay vs the 30-minute cancel, cash payment vs shift close, concurrent invoice numbering (AT-117), same Idempotency-Key at once | all green |
| CT-01…CT-06 ×1,000 | all green (they need more than the 20 s per-test limit at this count: run with `--test-timeout`) |
| Property tests `CL_PROP_RUNS=2000`: bill maths (AT-69, totals reconcile, Rs 1 rounding), weighted-average costing (PT-02), stock ledger invariants (PT-01 subset) | all green; PT-01 takes about 10 minutes at this count (database-backed) |

What the AT-15 rehearsal does not cover: the server's own outbound traffic. In Phase 3 the server sends nothing to the internet except the health page's internet probe (it reports "offline" and nothing waits on it); e-mail is Phase 6. The on-site run with the router's internet cable out covers both.

## 3. Phase 3 tests and where they run

TEST_PLAN.md §5, every test whose phase is 3, plus CT-01…CT-06.

| Test | What | Where |
|---|---|---|
| AT-01 | Guest scans Table 5 QR and submits 2 coffees → round pending approval; no ticket, reservation or stock movement | `apps/server/test/orders/orders.test.ts` |
| AT-02 | Staff accepts with enough stock → reservations = recipe × qty; one accepted round; one ticket; one print job | `apps/server/test/orders/orders.test.ts`, `apps/server/test/orders/kitchen.test.ts` |
| AT-03 | Accept retried or double-pressed → one acceptance, one set of reservations, one ticket | `apps/server/test/orders/orders.test.ts` |
| AT-04 | Two staff accept competing rounds for the last stock → only what's available is reserved; available never < 0 | `apps/server/test/orders/orders.test.ts` |
| AT-05 | Picked up 1 of 2 cappuccinos → exactly one consumption per ingredient; matching reservation released; line cost frozen | `apps/server/test/orders/kitchen.test.ts` |
| AT-06 | Accepted round cancelled before pickup, "not made yet" → reservations released; correction ticket; no consumption | `apps/server/test/orders/kitchen.test.ts` |
| AT-07 | Picked-up coffee voided (spilled) or comped → consumption kept; waste or comp recorded with cost | `apps/server/test/orders/kitchen.test.ts` |
| AT-08 | Table orders again 20 min later → new round, supplement ticket, same bill | `apps/server/test/orders/orders.test.ts`, `apps/server/test/orders/kitchen.test.ts` |
| AT-09 | Two phones at one table submit different rounds → both kept, one session | `apps/server/test/floor/floor.test.ts`, `apps/server/test/orders/orders.test.ts` |
| AT-10 | Cashier locks the bill while a round is being submitted → lock refused while pending, or submission refused once locked | `apps/server/test/billing/billing.test.ts` |
| AT-11 | Payment request retried → one payment, one settlement | `apps/server/test/billing/billing.test.ts` |
| AT-12 | New guests scan after checkout → new session; earlier orders invisible | `apps/server/test/floor/floor.test.ts` |
| AT-24 | Guest double-taps Send / retries after a network drop → one round, same round number | `apps/server/test/orders/orders.test.ts` |
| AT-25 | Price raised after submission, accepted within 30 min → guest charged the quoted price; adjustment recorded | `apps/server/test/orders/orders.test.ts` |
| AT-26 | Waiter round with an out-of-stock line → nothing saved; lines flagged; cart kept | `apps/server/test/orders/orders.test.ts` |
| AT-27 | Pick up 2 of a qty-3 line, cancel 1 → counters consistent; 2 consumed, 1 released | `apps/server/test/orders/kitchen.test.ts` |
| AT-28 | Worker killed after sending bytes → job `uncertain`; no automatic duplicate; reprint labelled | `apps/server/test/printing/jobs.test.ts` |
| AT-34 | Payment after the bill was reopened and changed → `BILL_CHANGED` | `apps/server/test/billing/billing.test.ts` |
| AT-35 | Split tender cash + card → settled once; change only on cash; shift totals right | `apps/server/test/billing/billing.test.ts` |
| AT-37 | Shift close with a variance → expected cash per formula (FINANCE_REPORTING §5); approval by someone else | `apps/web/e2e/till.spec.ts`, `apps/server/test/billing/shifts.test.ts` |
| AT-40 | Guest token from a closed session → `401 VISIT_ENDED`, no data | `apps/server/test/floor/floor.test.ts` |
| AT-42 | Card number typed as reference → `CARD_NUMBER_NOT_ALLOWED` | `apps/server/test/billing/compute.test.ts`, `apps/server/test/billing/billing.test.ts` |
| AT-43 | Live updates cut for 10 min → resync on reconnect; write buttons disabled while stale | `apps/web/e2e/workday.spec.ts`, `apps/server/test/live/hub.test.ts` |
| AT-44 | Sale settled at 00:30 with 04:00 cutoff → previous business date | `apps/server/test/db/foundation.test.ts`, `apps/server/test/billing/billing.test.ts` |
| AT-48 | Assigned waiter, other waiter, cashier and manager press Accept at once → exactly one succeeds; unassigned waiter gets 403 even calling the API directly | `apps/server/test/orders/orders.test.ts` |
| AT-49 | Table reassigned while an accept is in flight → only the waiter assigned at commit time can accept | `apps/server/test/orders/orders.test.ts` |
| AT-50 | QR round pending > 3 min → highlighted to manager + cashier; cashier may now accept | `apps/server/test/orders/orders.test.ts` |
| AT-51 | Counter-QR order, guest pays, cashier presses Accept & pay → one transaction: reserved, accepted, settled; ticket + receipt printed once | `apps/web/e2e/takeaway.spec.ts`, `apps/server/test/billing/takeaway.test.ts` |
| AT-52 | Accept & pay when an ingredient ran out → nothing committed; "no payment recorded" | `apps/server/test/billing/takeaway.test.ts` |
| AT-53 | Counter-QR order never paid → auto-cancelled after 30 min; no stock effect | `apps/server/test/billing/takeaway.test.ts` |
| AT-54 | COD order dispatched, rider returns with cash → payment linked to rider in the cashier's shift; settled; outstanding COD back to 0 | `apps/web/e2e/rider.spec.ts`, `apps/server/test/delivery/delivery.test.ts` |
| AT-55 | Failed delivery cancelled by manager → consumption kept as waste; prepaid amount refunded; no stock credit | `apps/server/test/delivery/delivery.test.ts`. The refund itself is Phase 5 (P3-1): the cancel marks **refund due** and raises an alert |
| AT-57 | Single printer out of paper with a ticket and a receipt queued → both held, then printed in order, once | `apps/server/test/printing/jobs.test.ts` |
| AT-59 | Transfer without transaction ID → refused; with ID → recorded with provider and confirmer, excluded from expected cash | `apps/server/test/billing/billing.test.ts` |
| AT-60 | Card on delivery recorded on return; retried → one payment | `apps/web/e2e/rider.spec.ts`, `apps/server/test/delivery/delivery.test.ts` |
| AT-62 | Cancel before pickup, "already made" → consumption + waste; reservation closed | `apps/server/test/orders/kitchen.test.ts` |
| AT-69 | Bill-level discount → shares allocated pro-rata across lines and sum exactly to the discount | `apps/server/test/billing/compute.test.ts` |
| AT-74 | Guest only browses → no session, table stays Available; first submit opens the session | `apps/server/test/floor/floor.test.ts`, `apps/server/test/orders/orders.test.ts` |
| AT-75 | Two guests use the counter QR → two separate takeaway sessions; neither sees the other's order | `apps/web/e2e/takeaway.spec.ts`, `apps/server/test/billing/takeaway.test.ts` |
| AT-78 | Price rose and the 30-min lock expired → `PRICE_CHANGED_LOCK_EXPIRED`; round must be rejected | `apps/server/test/orders/orders.test.ts` |
| AT-83 | Kitchen ticket golden output: no "Rs" or decimal amounts; correction, void and reprint banners present | `apps/server/test/printing/jobs.test.ts`, `apps/server/test/printing/render.test.ts` |
| AT-84 | Receipt golden output: every line ≤ 48 characters; totals aligned; reprint label | `apps/server/test/printing/render.test.ts` |
| AT-85 | RAW printing from the worker's service account on the real printer | **On site.** Windows CI prints RAW from the worker service account through a Windows queue on every build; the SNC-101 itself waits for I-1 |
| AT-86 | Automated accessibility scan (axe) on key screens: no serious issues; all text pairs AA; focus visible | `apps/web/e2e/shell.spec.ts`, `apps/web/e2e/pickup.spec.ts`, `apps/web/e2e/orders.spec.ts` |
| AT-87 | Counter keyboard: `/` search, `↑↓`, `Enter`, `F2` lock, `F4` cash, `F5` card, `Esc` closes | `apps/web/e2e/till.spec.ts` |
| AT-88 | Accepted line not picked up after 30 min → uncollected alert; reservation open > 12 h → stale alert | `apps/server/test/orders/kitchen.test.ts` |
| AT-89 | Prepaid delivery can't be dispatched until settled; COD/card dispatch locks the bill | `apps/server/test/delivery/delivery.test.ts` |
| AT-91 | Reopening a locked bill that has payments requires step-up approval | `apps/server/test/billing/billing.test.ts` |
| AT-92 | Picked up then Undo within 5 s → no request sent; no Undo → sent once after 5 s; device offline → "Not sent" | `apps/web/e2e/pickup.spec.ts`, `apps/web/src/screens/pickup/pickup.test.tsx` |
| AT-93 | Discount above the role limit → `STEP_UP_REQUIRED`; with a manager's approval it succeeds | `apps/server/test/billing/billing.test.ts` |
| AT-97 | Any change to a settled invoice or its lines → rejected by the database | `apps/server/test/billing/billing.test.ts` |
| AT-99 | Kitchen ticket API payloads contain no price, payment or contact fields | `apps/server/test/orders/kitchen.test.ts` |
| AT-100 | Transfer session to a free table → moved and audited; to an occupied table → `TABLE_OCCUPIED` | `apps/server/test/floor/floor.test.ts` |
| AT-101 | Rounds submitted after a bill request are accepted but flagged `after_bill_request` | `apps/server/test/orders/orders.test.ts` |
| AT-112 | Two promotions match a line → best single promotion applied; outside its day/time window none applies | `apps/server/test/catalog/catalog.test.ts`, `apps/server/test/catalog/units.test.ts` |
| AT-113 | Modifier group min/max violated (e.g. two milk choices) → `VALIDATION_FAILED` server-side | `apps/server/test/catalog/units.test.ts` |
| AT-114 | Item not allowed for delivery added to a delivery order → refused | `apps/server/test/delivery/delivery.test.ts` |
| AT-115 | Total with paisa after a % discount → rounded to Rs 1 with an explicit rounding line | `apps/server/test/billing/compute.test.ts`, `apps/server/test/billing/billing.test.ts` |
| AT-116 | Any attempt to store `tax_total` ≠ 0 → rejected by the database | `apps/server/test/billing/billing.test.ts` |
| AT-117 | Invoice numbers assigned only at settlement; gapless and unique under concurrent settlements | `apps/server/test/billing/billing.test.ts` |
| AT-123 | Delivery with no customer details accepted; phone numbers masked in lists | `apps/web/e2e/rider.spec.ts`, `apps/server/test/delivery/delivery.test.ts` |
| AT-124 | Notes over 120 chars refused; control characters stripped from printed output | `apps/server/test/orders/orders.test.ts` |
| AT-125 | Guest exceeds 10 submissions/min or 3 pending rounds → `RATE_LIMITED` / refused | `apps/server/test/orders/orders.test.ts` |
| AT-126 | Dietary/allergen tags entered by the owner are shown on the guest menu exactly as entered; nothing is inferred | `apps/web/e2e/menu.spec.ts`, `apps/web/src/screens/menu/menu.test.tsx`, `apps/server/test/catalog/catalog.test.ts` |
| AT-127 | Guest request that includes a table or session id → the id is ignored or refused; the table always comes from the QR token | `apps/server/test/floor/floor.test.ts`, `apps/server/test/orders/orders.test.ts` |
| AT-128 | Session open > 3 h → stale-session alert to the manager; a blocked/maintenance table can't be ordered from by QR | `apps/server/test/floor/floor.test.ts` |
| AT-130 | Owner settings (business hours, thresholds, branding, printer routing) take effect and are audited; a brand colour failing AA contrast for button text is refused | `apps/web/e2e/workday.spec.ts`, `apps/server/test/settings/settings.test.ts` |
| CT-01 | Two staff accept the same round | `apps/server/test/orders/orders.test.ts` |
| CT-02 | Two rounds compete for the last stock | `apps/server/test/orders/orders.test.ts` |
| CT-03 | Two guests open the same empty table | `apps/server/test/floor/floor.test.ts` |
| CT-04 | Guest submits while cashier locks | `apps/server/test/billing/billing.test.ts` |
| CT-05 | Pickup vs cancel on the same units | `apps/server/test/orders/kitchen.test.ts` |
| CT-06 | Two cashiers pay the same invoice | `apps/server/test/billing/billing.test.ts` |

The UX journeys are E2E tests with their targets: J1 (guest, 8 taps) in `apps/web/e2e/visit.spec.ts`; J2 (≤ 5 taps), J3 (1 tap), J4 (1 tap per ticket), J5 (≤ 4 actions) and J6 (2 actions) in `apps/web/e2e/workday.spec.ts`. AT-86 (accessibility) runs an axe scan on every screen the E2E tests visit.

## 4. On site (needs you)

| # | Check (PRINTING_HARDWARE.md §8) | How |
|---|---|---|
| HW-01 | Rear ports of the SNC-101 | Photo of the back (I-1) |
| HW-02 | Self-test page: firmware, interface, code page, ESC/POS | Hold FEED while switching on; photo (I-1) |
| HW-03 | Windows driver or "Generic / Text Only" queue; queue name | Screenshot of Windows Printers |
| HW-04 | RAW print from the worker service account | Settings → Printers → Add printer, then **Test print**; the page prints and cuts |
| AT-85 | The same, with a kitchen ticket and a receipt from a real order | Run one order through; compare with the golden files |
| I-5 | Approve the golden ticket and receipt wording, address and footer | Settings → Shop and branding sets the shop name, address, phone and footer |

Also still open from Phase 2, for the iMac dry run (I-6): Windows 10 itself (CI runs Windows Server 2022), W-1 (a dead PostgreSQL postmaster is not restarted by Windows), W-6 (the logon task as the Counter user).

## 5. Known limits carried forward

- Refunds (AT-55's refund part, P3-1) and the ledger: Phase 5.
- The shop's logo on screens and receipts waits for file uploads.
- Guest screens are tested on emulated phones (Pixel 7) and tablets (iPad); a real phone on the shop Wi-Fi is part of the on-site run (I-3).
- Recipes, purchasing, lots, counts: Phase 4. Phase 3 uses the minimal ingredient model and the sample menu (P3-5) until your menu arrives (I-4).
