# Phase 4 acceptance (step 4.10)

Status on 26 October 2026, branch `phase-4/recipe-to-stock`. Everything that can be proven in software is green, on the sample data. Two exit items need you: your own data (I-7…I-9), and the scanner and J7 timing at the shop (I-11, HW-10).

## 1. Exit criteria (PLAN.md, TEST_PLAN.md §4 Phase 4 row)

| Criterion | Status | Evidence |
|---|---|---|
| Every Phase 4 test in TEST_PLAN.md §5 green | ✅ in software | 23 Phase 4 test IDs plus UX-J7, each mapped to its tests in §3. `corepack pnpm verify`: 528 tests green. E2E: 21 journeys green on installed Chrome |
| Property tests PT-01…PT-04 green on a long run | ✅ | §2. PT-01 now runs the full mix: receipts, reservations, pickups, cancels, waste, counts, supplier returns, cost corrections, and a lot-tracked ingredient whose lots expire along the way |
| Costing fixtures exact (AT-33, AT-66) | ✅ | Both through the real services (receipts, pickups, waste, counts), not only the formulas: `apps/server/test/stock/costing.test.ts`; the formula-level versions stay in `math.test.ts` |
| Exit demo: **your real recipes loaded** | ⏳ **Your data (I-7…I-9)** | Done on the sample data (§4). The same import takes your files: replace the example rows in `docs/templates`, then Inventory → Import |
| Exit demo: a full cycle (receive → sell → waste → count) that the nightly check reconciles with nothing to report | ✅ on the sample data | `apps/server/test/acceptance/phase4-cycle.test.ts` (§4) |
| Windows CI | ✅ | Every step's CI: Linux verify and the unattended Windows install, green |

## 2. Longer runs before the exit

| Run | Result |
|---|---|
| Property tests `CL_PROP_RUNS=100`: PT-01 (database-backed, 60 random steps per sequence, invariants checked after every step), PT-02 (weighted average, drain rule), PT-03 (discount allocation), PT-04 (units) | all green (22 tests) |
| Phase 4 races `CL_RACE_RUNS=100`: a receipt racing an acceptance of the same item; a count posting racing a pickup of the same item | both green |
| Barcode linking: two clerks linking the same code at once | exactly one wins each of 10 rounds, every run (`items.test.ts`) |

## 3. Phase 4 tests and where they run

| Test | What | Where |
|---|---|---|
| AT-13 | Only expired lots remain → unavailable; cannot reserve | `apps/server/test/stock/lots.test.ts` |
| AT-14 | Scan known / unknown / duplicate barcode | `apps/server/test/stock/items.test.ts`; on screen `apps/web/e2e/inventory.spec.ts`, `apps/web/e2e/receiving.spec.ts` (link an unknown code while receiving), `apps/web/src/screens/inventory/inventory.test.tsx` |
| AT-19 | Recipe or price changed after a sale → that sale's consumption, cost and margin unchanged | `apps/server/test/stock/recipe-editor.test.ts` (new recipe version after a sale), `apps/server/test/stock/costing.test.ts` (cost corrections and later receipts); invoice prices are frozen at acceptance since Phase 3 (CT-07) |
| AT-29 | Count below reserved → posted, shortfall alert, acceptances blocked | `apps/server/test/stock/counts.test.ts` |
| AT-30 | Lot expires between acceptance and pickup → posts, flagged, alert | `apps/server/test/stock/lots.test.ts` |
| AT-31 | 6 × 1 L → 6,000 ml exactly; unit cost to 8 dp | `apps/server/test/stock/units.test.ts`, `apps/server/test/stock/items.test.ts`, `apps/server/test/purchasing/receipts.test.ts` |
| AT-32 | g ↔ ml refused | `apps/server/test/stock/units.test.ts`, `apps/server/test/stock/items.test.ts` |
| AT-33 | Phase 0 §5.2 milk example → WAC values exactly | `apps/server/test/stock/costing.test.ts` |
| AT-61 | Size without a recipe sold → no reservation or consumption | `apps/server/test/stock/recipe-editor.test.ts`. The Recipes tab shows how many sizes track stock; the COGS coverage percentage on sales is a Phase 6 report |
| AT-63 | Activating with an uncounted ingredient → refused | `apps/server/test/stock/recipe-editor.test.ts`, `apps/server/test/stock/ledger.test.ts` |
| AT-64 | Takeaway cappuccino + oat milk + extra shot → 27 g, 157.5 ml, 1 cup; dine-in no cup | `apps/server/test/stock/math.test.ts`, `apps/server/test/stock/recipe-editor.test.ts`, `apps/server/test/acceptance/phase4-cycle.test.ts` (with the shipped template data) |
| AT-65 | Last units take the exact remaining reservation | `apps/server/test/stock/ledger.test.ts` |
| AT-66 | COST_VALUATION §10 fixture exact | `apps/server/test/stock/costing.test.ts`, `apps/server/test/stock/math.test.ts` |
| AT-67 | Pickup after a low count → found stock, then consumption, owner alert | `apps/server/test/stock/counts.test.ts`, `apps/server/test/stock/ledger.test.ts` |
| AT-68 | Supplier price correction split per §6; past unchanged | `apps/server/test/stock/costing.test.ts` |
| AT-82 | Template import: row errors, all or nothing, EX- refused, re-import updates, recipes as drafts | `apps/server/test/imports/import.test.ts`; on screen `apps/web/e2e/import.spec.ts` |
| AT-94 | Corrupted balance → `balance_mismatch`, nothing fixed; only the owner closes it | `apps/server/test/stock/ledger.test.ts`, `apps/server/test/stock/alerts.test.ts` |
| AT-102 | Stock at zero → unavailable on guest and staff menus; manual switch wins | `apps/server/test/stock/lots.test.ts`; end to end `apps/web/e2e/recipes.spec.ts` |
| AT-108 | Blind count; approval by someone else above the limits; posted as a delta | `apps/server/test/stock/counts.test.ts`; on screen `apps/web/e2e/counting.spec.ts` |
| AT-109 | Waste with lot and reason at the average | `apps/server/test/stock/waste-returns.test.ts`; on screen `apps/web/e2e/receiving.spec.ts` |
| AT-110 | Supplier return at the average; refund recorded | `apps/server/test/stock/waste-returns.test.ts`; on screen `apps/web/e2e/receiving.spec.ts`. The ledger cash-in is Phase 5 (P4-2) |
| AT-111 | Low, near-expiry, overstock alerts once, resolved when cleared | `apps/server/test/stock/alerts.test.ts` |
| AT-129 | FEFO: earliest-expiring lot first | `apps/server/test/stock/lots.test.ts` |
| UX-J7 | Scan and receive 3 items with lot and expiry in ≤ 90 s | `apps/web/e2e/receiving.spec.ts`: 12 actions, a few seconds by automation. ⏳ A person's timing with the real scanner at the shop (I-11) |
| PT-01…PT-04 | Property tests | `apps/server/test/stock/property.test.ts`, `math.test.ts`, `units.test.ts`, `apps/server/test/billing/compute.test.ts` |

## 4. The exit cycle on the sample data

`apps/server/test/acceptance/phase4-cycle.test.ts`, with the shipped templates (their example SKUs renamed):

1. Import all eight files through the import (items, packs and barcodes, opening stock, suppliers, menu, choices, recipes, choice rules).
2. Preview the Cappuccino Regular draft (27 g beans, 157.5 ml oat milk, a cup for takeaway with oat milk and an extra shot), activate it and switch the size to track stock.
3. Morning delivery: scan the milk carton barcode, receive 6 cartons with lot and expiry, paid in cash: 18,000 ml on hand.
4. Service: three cappuccinos at a table, one with oat milk and an extra shot, all picked up; whole milk, oat milk and beans go down by exactly the recipe, no cups for dine-in.
5. 200 ml of milk spilled; the dairy shelf counted per lot; the variance posted.
6. Night: the expiry scan, then the stock check: "every balance matches its movements", no balance mismatch, and each sold line has its frozen cost.

## 5. What is still open

| Item | Who | Without it |
|---|---|---|
| I-7…I-9: your items, packs, barcodes, opening stock and recipes in the templates | You | The software is ready; the exit demo "your real recipes loaded" waits |
| I-11 / HW-10: the Sonic SNC-930D on the counter PC, five real products scanned, the suffix checked (P4-4), J7 timed by a person | At the shop | Scanning is tested as keyboard input (code and Enter); the real scanner's behaviour is not claimed |
| I-10: your suppliers | You | Receipts work without a supplier |
| Phase 3 on-site items (printer HW-01…HW-04 and AT-85, golden review I-5, iMac dry run I-6) | At the shop / you | Unchanged by Phase 4 |
| Ledger entries for purchase payments and supplier refunds | Phase 5 (P4-2) | Recorded on receipts and returns now |
| COGS coverage on the sales report (AT-61's report part) | Phase 6 | The Recipes tab shows tracked sizes out of all |
