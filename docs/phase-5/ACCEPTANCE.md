# Phase 5 acceptance (step 5.7)

Status on 27 October 2026, branch `phase-5/finance-oversight`. Everything Phase 5 asks of the software is green. What is left needs you: your lists and assets (I-12, I-13), who may approve refunds (I-14), the starting balances on day one (I-15, optional) and the backup of attached bills (I-16). One open item stays from the RBAC review: a PDF bill cannot be opened in the counter app until Phase 6 (§5).

## 1. Exit criteria (PLAN.md, TEST_PLAN.md §4 Phase 5 row)

| Criterion | Status | Evidence |
|---|---|---|
| Every Phase 5 test in TEST_PLAN.md §5 green | ✅ | The 8 Phase 5 test IDs and the parts of earlier tests this phase completes, each mapped in §3. `corepack pnpm verify`: 582 tests green. E2E: 26 journeys green on installed Chrome |
| The ledger reconciles with its sources for every day (nightly check) | ✅ | `ledger:reconcile` (04:15) compares every payment, refund, correction, cash movement, purchase paid now (and its reversal), supplier refund and expense with exactly one entry, and every automatic entry with its source; it reports, never fixes. Clean after the month (§4) and after every step of the property test (§2) |
| AT-110's ledger part (supplier refund cash-in) | ✅ | `apps/server/test/ledger/ledger.test.ts` |
| Exit demo: a month of simulated trading whose running balance per channel equals the sum of its entries for any range, every entry traced to its source, the nightly check silent | ✅ | `apps/server/test/acceptance/phase5-month.test.ts` (§4) |
| Ledger property test, races ×100 | ✅ | §2 |
| RBAC hardening review | ✅ | `docs/phase-5/RBAC_REVIEW.md`: 5 findings fixed, 4 accepted with reasons, 1 open for Phase 6; its tables are generated from the code and checked by a test |
| Windows CI | ✅ | Every step's CI: Linux verify and the unattended Windows install, green |

## 2. Longer runs before the exit

| Run | Result |
|---|---|
| Property tests `CL_PROP_RUNS=100`, including the new **ledger property** (`apps/server/test/ledger/property.test.ts`): 100 sequences of 30 random money events through the real API (sales by every method and provider, refunds, method corrections, cash in and out, purchases paid now and reversed, supplier refunds, expenses from the bank or the till voided and corrected, owner entries reversed). After every step: each channel's ledger balance equals the shop's own model; every source has exactly its entry and every entry its source; every reversal cancels exactly what it reverses; the day's ledger read closes at those balances | all green; the whole server suite with `CL_PROP_RUNS=100 CL_RACE_RUNS=100`: 462 tests in 98 s (ledger property 85 s, PT-01 23 s) |
| Races `CL_RACE_RUNS=100`, including two refunds of one payment at once (never more paid out than the payment) | all green (the refund race 100 rounds in 7 s, every earlier race ×100 too) |
| The property's oracle catches a wrong ledger: with the model's refund bookkeeping deliberately broken, the property fails and names the seed to replay | checked once by hand |
| What the long run found | One sequence paid more cash out of the till than it should hold: a paid-out was refused (as designed), but a **cash refund** and an **expense from the till** were not checked the same way and could take expected cash below zero. **Fixed** in this step: both are refused like a paid-out ("Only Rs … should be in the till"), with tests in `refunds.test.ts` and `expenses.test.ts`; the seed replays green |

## 3. Phase 5 tests and where they run

| Test | What | Where |
|---|---|---|
| AT-23 | Asset or expense corrected → history; the original traceable | Expenses: `apps/server/test/expenses/expenses.test.ts` (void and record again, each naming the other, bill carried over); assets: `apps/server/test/assets/assets.test.ts` (value corrected with a reason, details before/after). On screen: `apps/web/e2e/expenses.spec.ts` |
| AT-36 | Refund of a settled invoice: invoice unchanged; refund and ledger entry; requester ≠ approver | `apps/server/test/billing/refunds.test.ts`; on screen `apps/web/e2e/refunds.spec.ts` |
| AT-71 | One ledger entry per payment, refund, purchase payment, supplier refund, expense, cash movement; a method correction = reversal + new entry | `apps/server/test/ledger/ledger.test.ts`, `refunds.test.ts`, `expenses.test.ts`, `apps/server/test/ledger/property.test.ts`, `apps/server/test/acceptance/phase5-month.test.ts` |
| AT-90 | Refund above what was paid → `REFUND_EXCEEDS_PAID` | `apps/server/test/billing/refunds.test.ts` (per payment and per line) |
| AT-105 | Delivery customer details older than the retention → removed; transactions intact | `apps/server/test/delivery/delivery.test.ts` (invoices, payments, ledger and stock compared before and after) |
| AT-106 | Asset acquired → moved → maintenance → disposed, all in its history | `apps/server/test/assets/assets.test.ts`; on screen `apps/web/e2e/assets.spec.ts` |
| AT-107 | Expense voided → reversal entry; the original kept | `apps/server/test/expenses/expenses.test.ts`; on screen `apps/web/e2e/expenses.spec.ts` |
| AT-121 | Running balance per channel = Σ entries for any range | `apps/server/test/ledger/ledger.test.ts` (four ranges), the property (after every step) and the month (every day and the whole month) |
| AT-18 (ledger) | A waiter is refused the ledger API | `apps/server/test/ledger/ledger.test.ts`; every Phase 5 route in SEC-ALL |
| AT-37 | Expected cash per formula, with refunds, corrections and till expenses in the shift | `apps/server/test/billing/shifts.test.ts`, `refunds.test.ts`, `expenses.test.ts` |
| AT-38, AT-39 | Override deny wins, preview matches; the last owner stays | `apps/server/test/identity/access.test.ts` (and Phase 2's `http.test.ts`); on screen `apps/web/e2e/oversight.spec.ts` |
| AT-82 (09_assets.csv) | Template import: row errors, all or nothing, re-import changes nothing | `apps/server/test/assets/assets.test.ts` |
| AT-86 | Accessibility scan of the new screens | `apps/web/e2e/ledger.spec.ts`, `refunds.spec.ts`, `expenses.spec.ts`, `assets.spec.ts`, `oversight.spec.ts` |
| AT-95 | Audit shows actor, device, before/after, reason, approver | `apps/server/test/identity/access.test.ts`; on screen `apps/web/e2e/oversight.spec.ts` |
| AT-96 (ledger) | Ledger entries, refunds, asset events and maintenance cannot be changed or deleted | `ledger.test.ts`, `expenses.test.ts`, `assets.test.ts` |
| AT-110 (ledger) | Supplier refund → cash in by its channel | `apps/server/test/ledger/ledger.test.ts` |
| CT (refunds) | Two refunds of one bill at once ×100 | `apps/server/test/billing/refunds.test.ts` |
| SEC-ALL | Every route × every role, re-run with the Phase 5 routes | `apps/server/test/identity/route-matrix.test.ts`; inventory in `docs/phase-5/RBAC_REVIEW.md` (`rbac-review.test.ts`) |
| P5-5, P5-6, P5-8 | Refund due → prefilled refund that closes it; cash expense from the till = the shift's paid-out, one entry; starting balances as owner entries | `delivery.test.ts`, `expenses.test.ts`, `phase5-month.test.ts` |

## 4. The month (exit demo)

`apps/server/test/acceptance/phase5-month.test.ts` trades 30 business days through the API with a clock the server reads its business dates from: one cash shift a day opened and closed with the counted cash, 4–8 sales a day by cash, card, JazzCash, Easypaisa and bank, a refund every third day, a method correction every fifth, paid-outs and paid-ins, weekly milk paid in cash, a delivery paid by transfer with a supplier refund, a receipt entered by mistake and reversed, rent from the bank, wages from the till every week, utilities entered twice and one voided, a repair corrected, the owner's starting balances and one wrong entry reversed. Then, for every day, each channel opens where the day before closed and closes at opening + in − out; the whole month closes at the shop's own model of each channel; every entry names its source (bills and expenses link to their page); and the nightly check reports nothing. Cash paid in and out takes its business date from the database clock, so in the simulation those entries fall on the last day; in the shop they fall on their own day.

## 5. Open items

| # | Item | Needs |
|---|---|---|
| I-12 | Your expense categories and usual payees | You: edit Expenses → Categories (a starter list is in place) |
| I-13 | Your assets | You: `docs/templates/09_assets.csv` → Inventory → Import (or Assets → Register) |
| I-14 | Who approves refunds | You: owner only (default), or grant `payments.refund` to a manager role on Users & roles → Roles |
| I-15 | What is in the cash box and the bank on day one (optional) | You, on the first day: Ledger → New manual entry, one per channel (P5-8) |
| I-16 | Space for bills' photos and their backup | You: confirm; the files live in `C:\ProgramData\CoffeeLounge\files` (`FILES_DIR`), which BACKUP_RECOVERY.md includes in the nightly backup |
| F-10 | A PDF bill cannot be opened in the counter app (it blocks downloads and new windows) | Phase 6: a reviewed download path with the exports. Photos show everywhere; PDFs open from a browser on another device |
| Phase 4 | Your data (I-7…I-9), the scanner and J7 timed at the shop (I-11) | Unchanged |
| Phase 3 | The printer on site (I-1), the golden ticket and receipt review (I-5, now also the refund slips), the iMac dry run (I-6) | Unchanged |
