# Phase 5 — Finance & Oversight Build Plan

> **Approved 26 Oct 2026** with P5-1…P5-8 as recommended. Builds on the approved design (G1) and on Phases 3 and 4, whose software is complete and merged into `main` (`docs/phase-3/ACCEPTANCE.md`, `docs/phase-4/ACCEPTANCE.md`). Where the Phase 0 roadmap and later decisions differ, the decisions win (§3).

| | |
|---|---|
| Goal | Every rupee that moves is in one operational ledger with a link to where it came from: sales, refunds, purchases, supplier refunds, expenses, cash paid in and out, and owner adjustments. Refunds work as designed. Expenses and the asset register are kept in the system. The owner sees who did what (audit log), who may do what (users and roles), and what waits for a decision (approvals inbox) |
| Estimate | 3–4 weeks (roadmap §9: 2–3 weeks, plus the owner screens the roadmap counted elsewhere), in 7 steps, each ending with its tests green, verify and Windows CI green, and a commit |
| Entry | Phase 4 software complete (merged as PR #2). Its two open exit items (your data I-7…I-9; scanner and J7 timing at the shop, I-11) don't block Phase 5: **P5-1** proposes starting alongside them, as P4-1 did |
| Exit criteria | TEST_PLAN.md §4 (Phase 5 row): every Phase 5 test in §5 green; the ledger reconciles with its sources for every day (nightly check, like the stock check); the parts of earlier tests that waited for the ledger green (AT-110's supplier refund cash-in) |
| Exit demo | A month of simulated trading (sales, refunds, purchases paid now, supplier refunds, expenses, paid-ins and paid-outs, one owner adjustment): the ledger's running balance per channel equals the sum of its entries for any date range, every entry traces to its source, and the nightly ledger check reports nothing |

## 1. In and out of Phase 5

| In Phase 5 | Later or not at launch |
|---|---|
| Operational ledger: automatic entries from payments, refunds, method corrections, purchase payments, supplier refunds, cash paid in/out; manual owner entries and reversals (never edits, D-31); running balance per channel | KPIs, dashboards, sales and profit reports, exports, day-end PDF, scheduled e-mails: **Phase 6** |
| Ledger entries for everything already recorded since Phase 3 (P4-2), posted once by the migration (P5-2) | Depreciation, supplier payables, accrued wages: **not at launch** (D-19) |
| Refunds and payment-method corrections (ORDER_STATE_MACHINE.md P2): request, approval by someone else with step-up (D-13), to the original method, item-level refund lines, refund slip, cash refunds in the cash shift | COGS coverage % on sales (AT-61's report part): Phase 6 |
| Refund of a cancelled prepaid delivery (P3-1) through the same flow | Installer, backups and restore drills: Phase 7 |
| Expenses with categories and an attached bill (photo or PDF); void = reversal | |
| Asset register: assets, events (acquired, moved, condition, maintenance, value corrected, status, disposed), maintenance records | |
| Owner and manager screens: approvals inbox completed, audit log viewer, users and roles with effective permissions, the remaining owner settings | |
| Privacy: delivery customer details redacted after 12 months (D-25) | |
| RBAC hardening review (roadmap §9) | |

**Already in place** and reused: the audit writer and its append-only table (Phase 2), step-up approvals and the role/override model with the effective-permission service (Phase 2), payments, cash shifts and the expected-cash view (Phase 3), purchase receipts with payment channel and supplier returns with refund details (Phase 4, recorded for this phase), the manager's operations inbox (step 3.12).

## 2. Decisions this phase implements

D-13 refunds by the owner (a manager only if granted), with step-up approval, to the original method, requester ≠ approver · D-19 no depreciation, payables or accrued wages; "recorded operating result" wording · D-21 sales by settlement business date · D-25 keep transactions indefinitely, redact delivery customer details after 12 months · D-31 the ledger is never edited: reverse and post again; inventory "delete" = archive or reverse; "Resources Management" includes the asset register.

## 3. Changes from the Phase 0 roadmap

| Roadmap item | In this plan | Why |
|---|---|---|
| "Manager approvals inbox" as new | Completed, not new: the inbox exists since step 3.12; Phase 5 adds refund requests, stock-count approvals and critical stock alerts | Built early for the Phase 3 acceptance |
| Tests AT-18, AT-38, AT-39 | Their API parts pass since Phase 2; Phase 5 adds them on screen (users and roles) | The screens arrive now |
| Ledger postings from purchases | Also for the history since Phase 3 (P5-2) | P4-2 promised it |
| Phase 5 test list | Adds AT-36, AT-71, AT-90, AT-105…AT-107, AT-121 from TEST_PLAN.md and AT-110's ledger part | TEST_PLAN.md assigns them to Phase 5 |

## 4. Build order

Each step is a vertical slice: migration, API, screens and tests together. Every new route joins the route × role matrix; every money movement has a unique source key, so a retry can never post twice.

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 5.1 ✅ | **Operational ledger.** `ledger_entries` (append-only; numbered `LE-YYYY-NNNNNN`, P5-4) and the posting service; automatic entries in the same transaction as their source: payment received, cash paid in/out, purchase paid at receipt, supplier refund on a return; the migration posts the history once (P5-2). Owner manual entries with a reason, and reversals. Ledger screen: entries by date range and channel, running balance per channel, each entry linked to its source. Nightly ledger check: every source has exactly one entry, nothing extra, never fixed automatically | AT-71 (payments, purchases, supplier refunds, cash movements), AT-121, AT-96 (ledger part), AT-110 (ledger part), AT-18 (ledger API refused to a waiter) | Phases 3–4 |
| 5.2 ✅ | **Refunds and method corrections.** Request (cashier or manager, `payments.refund_request`) with lines and reason; approval by someone else with step-up (`payments.refund`, D-13); refund to the original method; `RF-YYYY-NNNNN`; never more than was paid; a cash refund needs an open shift and lowers expected cash; method correction = reversal + new entry; refund slip printed; the invoice itself never changes. A cancelled prepaid delivery's "refund due" opens a prefilled request and closes when refunded (P5-5) | AT-36, AT-90, AT-71 (refunds), AT-37 still green with refunds in the shift, CT: two refunds of one invoice at once ×100 | 5.1 |
| 5.3 ✅ | **Expenses.** Categories (owner settings); record with payee, reference, channel and an attached bill (P5-3); `EXP-YYYY-NNNNN`; a cash expense paid from the drawer during a shift is also a paid-out of that shift (P5-6); void with a reason = reversal entry, the original kept | AT-107, AT-23 (expense part), AT-71 (expenses) | 5.1 |
| 5.4 ✅ | **Asset register.** Assets with tag, category, location, condition, responsible person, supplier, purchase price; every change is an event in the history; maintenance records, optionally linked to an expense; disposal is a status, never a delete; template `09_assets.csv` through the step-4.9 importer (P5-7) | AT-106, AT-23 (asset part), AT-82 for the new template | 5.3 |
| 5.5 ✅ | **Oversight screens.** Approvals inbox completed (refund requests, count approvals, critical stock alerts, with links); audit log viewer (filter by person, action, record, date; before/after; reason; approver); Users & roles: users, roles, grants, overrides and the effective-permission preview with where each permission comes from (`roles.manage` stays owner-only) | AT-38 and AT-39 on screen, AT-95 (audit fields shown), UX checks (AT-86) for the new screens | 5.1–5.4 |
| 5.6 ✅ | **Settings, privacy and RBAC review.** Remaining owner settings (expense categories, asset categories and locations, refund reasons); nightly redaction of delivery customer details after `privacy.delivery_pii_retention_months` (D-25), transactions untouched; RBAC hardening review written up: every route's permission, every ○ grant, every step-up action, owner-only checks | AT-105, route × role matrix (SEC-ALL) re-run, review document | 5.1–5.5 |
| 5.7 | **Phase 5 acceptance.** The month-long simulated trading run; ledger property test (for random sequences of money events: one entry per source, balance per channel = Σ entries, reversals cancel exactly); races ×100; Windows CI; `docs/phase-5/ACCEPTANCE.md` | Phase 5 exit criteria | 5.1–5.6 |

## 5. What I need from you, and when

| # | Input | Needed by | Without it |
|---|---|---|---|
| I-12 | Your expense categories (rent, utilities, wages, repairs, supplies…) and usual payees | Step 5.3 | A starter list you can edit in Settings |
| I-13 | Your assets: espresso machine, grinders, fridges, furniture, POS hardware, with tags if you use them (template `09_assets.csv`) | Step 5.4; exit at the latest | Built and tested with sample assets |
| I-14 | Who approves refunds: you only (D-13 default), or also a named manager | Step 5.2 | Owner only |
| I-15 | Optional: what is in the cash box and bank on the day the ledger starts (P5-8) | Before go-live | Running balances start from zero on the first day |
| I-16 | How much disk space bills' photos may use on the counter PC, and confirmation that the backup drive rotation (D-23) includes them | Step 5.3 | 5 MB per file, kept with the database backups |

Still open and not blocking Phase 5: your Phase 4 data (I-7…I-11) and the Phase 3 on-site items (I-1, I-5, I-6).

## 6. Proposals that need your approval

| # | Proposal | Recommendation |
|---|---|---|
| P5-1 | Start Phase 5 before the Phase 4 exit items (your data, the scanner at the shop) are done | Yes: they need you and the shop, not code. Phase 4 stays formally open until they are recorded |
| P5-2 | The ledger starts with everything already recorded | The migration posts one entry per existing payment, paid receipt, supplier refund and cash paid in/out, on its own business date, so AT-71 holds for the whole history and the nightly check is meaningful from day one |
| P5-3 | Attached bills | Stored on the server's disk in the data folder (not inside the database), JPEG, PNG or PDF up to 5 MB, visible only to those who may read expenses, included in the nightly backup (D-23) |
| P5-4 | Document numbers | `LE-YYYY-NNNNNN` ledger entries, `RF-YYYY-NNNNN` refunds (already in DATABASE.md §16), `EXP-YYYY-NNNNN` expenses; asset tags you type, or `AST-NNNN` when left empty |
| P5-5 | Refund of a cancelled prepaid delivery (P3-1) | The "refund due" alert opens a refund request already filled in; it is approved like any refund and the alert closes when the refund is paid |
| P5-6 | Cash expenses paid from the drawer | Recorded once: the expense posts its ledger entry and also counts as a paid-out of the open shift, so expected cash stays right and nothing is posted twice |
| P5-7 | Assets template | Add `09_assets.csv` to the templates and import it through Inventory → Import, with the same all-or-nothing rules |
| P5-8 | Starting balances per channel | The owner may post one adjustment per channel on the first day ("cash in the box", "bank account"); optional, clearly labelled, never repeated |

## 7. Risks

| Risk | Mitigation |
|---|---|
| "Profit" expected beyond what is recorded (roadmap risk) | Ledger and expenses say "recorded"; no depreciation or payables (D-19); profit reports wait for Phase 6 with labelled definitions |
| A ledger entry missed or posted twice | Unique source keys, entries written in the same transaction as their source, the backfill run once, the nightly check comparing every source with its entry |
| Refunds abused | Step-up approval by someone else, never more than paid, audit with reason and approver, refunds visible in the inbox and the ledger |
| Attachments fill the disk | Size limit, the health page's disk warning (H-14), files in the backup set |
| Owner screens add work late in the phase | Screens are built inside each step, not at the end |

## 8. Working rules (unchanged)

- Every step ends with its tests passing, `corepack pnpm verify` green, Windows CI green and a commit pushed to `phase-5/finance-oversight` (branched from `main`); nothing is reported as done without test output.
- Migrations are forward-only and follow DATABASE.md; any deviation is recorded in DATABASE.md §15 in the same commit.
- No business data beyond samples until you send yours; no secrets in the repository.
- Hardware results are never claimed until tested on the real device.
