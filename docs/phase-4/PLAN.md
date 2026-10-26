# Phase 4 — Recipe-to-Stock Build Plan

> **Approved 26 Oct 2026** with P4-1…P4-5 as recommended. Builds on the approved design (G1) and on Phase 3, whose software is complete and merged (`docs/phase-3/ACCEPTANCE.md`). Where the Phase 0 roadmap and later decisions differ, the decisions win (§3).

| | |
|---|---|
| Goal | The clerk receives stock by scanning, with pack sizes, lots and expiry dates; every sale consumes the right ingredients, earliest-expiring lot first; waste, counts and supplier corrections keep stock and cost true; the owner sees what is low, expiring or wrong. Real recipes are loaded from your data. |
| Estimate | 4–5 weeks (roadmap §9), in 10 steps, each ending with its tests green, verify and Windows CI green, and a commit |
| Entry | Phase 3 exit (TEST_PLAN.md §4). Its software is done; three on-site items are still open (HW-01…HW-04 with AT-85, your golden-layout review I-5, the iMac dry run I-6). **P4-1** proposes starting Phase 4 alongside them |
| Exit criteria | TEST_PLAN.md §4 (Phase 4 row): every Phase 4 test in §5 green; property tests PT-01…PT-04 green on a long run; costing fixtures exact (AT-33, AT-66) |
| Exit demo | Roadmap §9: **your real recipes loaded**, and a full cycle (receive → sell → waste → count) that the nightly check reconciles with nothing to report |

## 1. In and out of Phase 4

| In Phase 4 | Later |
|---|---|
| Units and conversions (kg ↔ g, l ↔ ml; never mass ↔ volume), pack sizes, barcodes with the scanner | Purchase orders and supplier payables: not at launch (D-19) |
| Suppliers; purchase receipts (`GRN-YYYY-NNNNN`) with line cost, lots and expiry; reversal of a receipt still on hand | Ledger entries for purchase payments and supplier refunds: **Phase 5** (P4-2) |
| Lots and expiry; FEFO consumption; expired lots excluded from availability | Reports and exports (stock valuation, waste, usage): **Phase 6** |
| Ingredient waste with lot and reason; supplier returns | Depreciation, assets: Phase 5 / not at launch (D-19) |
| Blind stock counts, approval above 2 % or Rs 1,000 (D-18), delta posting, shortfall blocking | |
| Supplier price corrections (COST_VALUATION.md §6) | |
| All inventory alerts (low, zero, near expiry, expired, overstock, reservation shortfall) | |
| Recipe editor: drafts, activation, versions, modifier recipe rules | |
| Template import of your data (`docs/templates/01…08`) | |
| Inventory screens for the clerk (UI_UX.md §6, Clerk prototype) and movement history | |

**Already built in Phase 3 (step 3.2)** and reused: weighted-average costing with the drain rule and found stock, recipe explosion with modifier rules, reservations and consumption, ingredient and prepared-item waste, opening balances, the low alert, availability from stock, and the nightly balance check. Several Phase 4 tests already pass against that code but are not yet labelled with their IDs (AT-33, AT-61, AT-63, AT-64, AT-65, AT-66, AT-67, AT-94); Phase 4 labels them and fills the gaps, so the traceability map stays honest.

## 2. Decisions this phase implements

D-04 perpetual weighted-average cost with FEFO physical picking · D-18 count variance over 2 % or Rs 1,000 needs approval by someone else; a count below reserved records the truth, raises a shortfall alert and blocks new acceptances for that item · D-19 no supplier payables at launch · D-27 Unicode item names (Urdu allowed on screen, English on tickets) · D-29 the clerk enters data weekly and items come online gradually · D-31 inventory "delete" = archive or reverse · D-38 the clerk works on the counter PC off-peak.

## 3. Changes from the Phase 0 roadmap

| Roadmap item | In this plan | Why |
|---|---|---|
| "Approved valuation (WAC or FIFO)" | WAC only, already built | D-04 confirmed WAC; FIFO is not offered |
| Several costing pieces listed as Phase 4 | Built in Phase 3 step 3.2; Phase 4 completes and labels them | Acceptance needed reservations and consumption (roadmap §9.1) |
| Receipt payment → ledger entry; supplier refund → ledger cash-in (AT-110) | Recorded on the receipt or return; ledger entries are written in Phase 5 from these records | The ledger is Phase 5 (P4-2) |

## 4. Build order

Each step is a vertical slice: migration, API, screens and tests together. Screens follow UI_UX.md and the Clerk prototype; every new route joins the route × role matrix.

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 4.1 ✅ | **Items, units, pack sizes, barcodes.** Item editor (SKU, base unit, settings from RECIPE_INVENTORY.md §3: lots, expiry, low and overstock thresholds, near-expiry days), pack sizes with their base quantity, barcodes (one active owner per code), conversion rules. Scanner input on screen as keyboard entry ending in Enter (P4-4). Inventory area opens for the clerk | AT-31, AT-32, AT-14 (API part), PT-04 | Phase 3 |
| 4.2 | **Suppliers and receiving.** Suppliers; purchase receipts: scan or search, packs → base quantity shown, line cost → unit cost to 8 dp, post with a gapless `GRN` number, stock and average cost updated, availability refreshed; reversal of a receipt whose stock is still on hand; payment channel and reference recorded (P4-2). **Receive stock** screen as prototyped, with "Link to item" for an unknown barcode | AT-31, AT-14 (E2E), UX-J7 (3 items in ≤ 90 s), CT: receipt posting vs acceptance of the same item | 4.1 |
| 4.3 | **Lots, expiry, FEFO.** Receipts create lots; consumption, waste and returns take lots earliest-expiry first; expired lots stop counting as available; a lot that expires between acceptance and pickup still posts, flagged `expired_lot_used`. Existing stock when lot tracking is switched on (P4-3). Nightly expiry scan at 04:05 | AT-13, AT-30, AT-129, AT-102 (with E2E on guest and staff menus) | 4.2 |
| 4.4 | **Waste and supplier returns.** Waste screen (ingredient and expired lot, with lot and reason; prepared-item waste stays with voids); supplier return against the receipt line and lot at current average (COST_VALUATION.md §4) | AT-109, AT-110 (stock and value; the ledger part in Phase 5) | 4.3 |
| 4.5 | **Stock counts.** Scope (all, category, list), blind by default, book quantity snapshotted per line as it is entered, per-lot lines for lot-tracked items, submit, approval by someone other than the submitter above the thresholds, send back for recount, post as deltas. Count below reserved: post, shortfall alert, block new acceptances for that item until resolved | AT-108, AT-29, AT-67 (with counts), CT: count posting vs pickup of the same item | 4.3 |
| 4.6 | **Cost corrections and valuation checks.** Supplier price correction split between stock and variance (owner only, `inventory.cost_adjust`); past periods untouched; the costing fixtures as exact tests | AT-68, AT-33, AT-66, AT-19, PT-02 | 4.2 |
| 4.7 | **Alerts and overview.** Every alert kind of RECIPE_INVENTORY.md §10, once per item and kind, resolving when the condition clears (balance mismatch only by the owner); Inventory overview (what is low, expiring, expired, short); movement history per item with filters | AT-111, AT-94 (labelled), AT-102 | 4.3–4.5 |
| 4.8 | **Recipe editor.** Draft versions, components with waste factor and order-type rules, modifier recipe rules (add, remove, replace), activation only when every ingredient is stock-controlled, previous version kept for old sales, variant switch from untracked to recipe; preview of the explosion for a chosen size, order type and choices | AT-63, AT-64, AT-65, AT-61, AT-19 (recipe part) | 4.1 |
| 4.9 | **Template import.** Upload of templates 01–08 (items, packs and barcodes, opening stock, menu, modifiers, recipes, modifier rules, suppliers): preview with every row error listed; any error saves nothing; `EX-` example SKUs refused; a re-import updates instead of duplicating; imported recipes arrive as drafts | AT-82 (with E2E) | 4.1, 4.2, 4.8 |
| 4.10 | **Phase 4 acceptance.** PT-01 in full (receipts and counts added to the random sequences), PT-01…PT-04 long run (PT-03, discount allocation, already runs since Phase 3); the new races ×100; your data loaded through 4.9; the exit cycle (receive, sell through the day, waste, count) with a clean nightly check; Windows CI | Phase 4 exit criteria | 4.1–4.9, your data |

## 5. What I need from you, and when

| # | Input | Needed by | Without it |
|---|---|---|---|
| I-7 | Your inventory items with pack sizes and barcodes (templates 01, 02) | Step 4.2 for real scanning; exit at the latest | Built and tested with the sample shop (P3-5) |
| I-8 | Opening stock: quantity and cost per item (template 03), counted on one day | Before the exit demo | The demo runs on sample stock only |
| I-9 | Recipes and modifier rules for the best-selling drinks first (templates 06, 07) | Step 4.8; exit | **Exit criterion stays open**: the roadmap asks for real recipes |
| I-10 | Suppliers (template 08) | Step 4.2 | Receipts without a supplier name (it is optional) |
| I-11 | The scanner (Sonic SNC-930D) connected to the counter PC, and five real products to scan (HW-10) | Step 4.2 on site, or the dry run | Scanning tested as keyboard input; the real scanner's suffix and symbologies wait |
| I-4 | Your menu (carried from Phase 3) | Step 4.9 | Sample menu used |

Still open from Phase 3 and not blocking Phase 4: the printer details (I-1), the golden review (I-5) and the iMac dry run (I-6).

## 6. Proposals that need your approval

| # | Proposal | Recommendation |
|---|---|---|
| P4-1 | Start Phase 4 before the Phase 3 on-site items (printer HW-01…HW-04 and AT-85, golden review, iMac dry run) are done | Yes: they need the shop and you, not code. Phase 3 stays formally open until they are recorded; nothing in Phase 4 depends on the printer |
| P4-2 | Purchase payments and supplier refunds touch the ledger, which is Phase 5 | Phase 4 records the payment channel and reference on the receipt or return; Phase 5 writes the ledger entries from those records, including the past ones. AT-110's ledger assertion moves to Phase 5 |
| P4-3 | An item already holding stock is switched to lot tracking | Its current on-hand becomes one opening lot whose expiry the clerk enters (or "unknown" for non-expiry items); from then on receipts create lots |
| P4-4 | Barcode scanner | Use it as a keyboard (USB HID) ending each scan with Enter, as wired scanners usually do (not yet checked on the SNC-930D); no driver and no special code path. If it sends something else, the suffix is set from its programming sheet. HW-10 confirms it on site |
| P4-5 | Counts during service | Allowed: posting a delta keeps sales made during the count. Recommend counting perishables before opening anyway |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Your recipe and item data arrive late or incomplete (roadmap risk) | Weekly, incremental entry (D-29); untracked variants keep selling; COGS coverage shows what is missing; the import refuses bad rows instead of guessing |
| Local products share or reuse barcodes, or carry weight-embedded codes | One active owner per barcode, refused duplicates showing the owner, "Link to item" for unknown codes; weight codes handled when we see real ones (I-11) |
| Lot tracking is a burden on a busy clerk | Recommended only for perishables (milk, cream, bakery); everything else without lots |
| Counts and pickups at the same moment | Lock order from DATABASE.md §14; races for count vs pickup and receipt vs acceptance ×100 |
| Rounding drift in averages | Already guarded by PT-02 and the drain rule; Phase 4 adds the exact fixtures and the full PT-01 |

## 8. Working rules (unchanged)

- Every step ends with its tests passing, `corepack pnpm verify` green, Windows CI green and a commit pushed to `phase-4/recipe-to-stock` (branched from `main`); nothing is reported as done without test output.
- Migrations are forward-only and follow DATABASE.md; any deviation is recorded in DATABASE.md §15 in the same commit.
- No business data beyond samples until you send yours; no secrets in the repository.
- Hardware results (scanner, printer) are never claimed until tested on the real device.
