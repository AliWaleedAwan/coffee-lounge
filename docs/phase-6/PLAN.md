# Phase 6 — Reports & Exports Build Plan

> **Approved 27 Oct 2026** with P6-1…P6-9 as recommended. Builds on the approved design (G1) and on Phases 3–5, whose software is complete and merged into `main` (`docs/phase-3/ACCEPTANCE.md`, `docs/phase-4/ACCEPTANCE.md`, `docs/phase-5/ACCEPTANCE.md`). Where the Phase 0 roadmap and later decisions differ, the decisions win (§3).

| | |
|---|---|
| Goal | You see how the shop is doing without adding anything up yourself: an owner overview with the headline figures, a library of reports that drill down to the rows behind every total, CSV and branded PDF exports that match the screen to the rupee, the day-end report, and the reports you choose e-mailed to you on schedule, queued while the internet is down |
| Estimate | 3–4 weeks (roadmap §9: 3–4 weeks), in 7 steps, each ending with its tests green, verify and Windows CI green, and a commit |
| Entry | Phase 5 software complete (merged as PR #3). Its open items (your inputs I-12…I-16; PDF bills in the counter app, which step 6.5 closes) don't block Phase 6: **P6-1** proposes starting alongside them |
| Exit criteria | TEST_PLAN.md §4 (Phase 6 row): every KPI reconciles to its detail rows and to its exports (AT-20, AC-RPT-1); the scheduled e-mail queue tests green (AT-21, AT-104); every Phase 6 test in §5 green |
| Exit demo | A year of synthetic trading on the sample menu: the owner overview for a month in at most 3 seconds on the development PC (AC-PERF-4; the counter iMac is measured at the Phase 7 dry run), each tile opened down to its rows and exported to CSV and PDF with the same totals, and the day-end PDF queued while "offline" and sent to a test mailbox once the connection returns |

## 1. In and out of Phase 6

| In Phase 6 | Later or not at launch |
|---|---|
| KPI definitions of FINANCE_REPORTING.md §3, in one module used by every screen and export | Statutory accounts, tax returns, balance sheet, "net profit" (DEC-10, D-19) |
| Owner overview: Net sales · Orders · AOV · Gross margin % (after waste) · Waste cost · Recorded operating result, each against the same weekday(s) last week (UI_UX.md §5); sales by hour and by day; top items; open alerts. A manager's view of the same with only what their permissions allow | Forecasting, budgets, targets, loyalty or customer analytics |
| The report catalogue of FINANCE_REPORTING.md §6, with filters and drill-down to rows | New reports beyond the catalogue: noted as backlog, not built (roadmap risk "scope creep") |
| CSV (UTF-8 BOM, ISO dates, plain decimals) and branded A4 PDF exports, footer with period, business-day rule, filters, formulas, COGS coverage and generation time (AT-103) | Excel files (.xlsx), PDF editing, report designer |
| Day-end report for a business date: PDF and an 80 mm printed summary (AT-122) | Installer, backups and restore drills: **Phase 7** |
| Scheduled e-mails over your own mailbox (D-20): daily day-end PDF and weekly summary by default, queue with retries while offline, stable Message-ID, status visible (AT-21, AT-104) | SMS or WhatsApp delivery |
| The counter app may save the app's own exports and attached bills (closes Phase 5's F-10) | Any other download in the counter app |
| A synthetic year of data for the performance check (AC-PERF-4) | Measuring on the counter iMac: **Phase 7** dry run (I-6) |

**Already in place** and reused: business dates on every money and stock row (D-21, D-22), frozen costs per sold line (Phase 4), the ledger, refunds and expenses (Phase 5), the live operations figures and the shift report (Phase 3), the 80 mm printer path and golden files (Phase 3), shop name and colour in branding (step 3.12), the worker with its nightly schedule, permissions `reports.sales`, `reports.profit`, `reports.inventory`, `reports.staff`, `reports.export`, `reports.schedule` (seeded since Phase 2, no route uses them yet).

## 2. Decisions this phase implements

D-19 recorded operating result only, labelled, no depreciation or payables · D-20 the owner's own SMTP mailbox; daily day-end PDF and weekly summary · D-21 sales by settlement business date, COGS on the invoice's date, discount allocation · D-22 Asia/Karachi, business day from 04:00 · D-29 COGS coverage shown whenever costs appear; "Needs recipes" below 95 %.

## 3. Changes from the Phase 0 roadmap

| Roadmap item | In this plan | Why |
|---|---|---|
| "Report library" as one deliverable | Two steps: money and sales (6.3), stock, purchases and people (6.4) | The catalogue has 21 reports; each step ends with all of its reports reconciled |
| Tests AT-20, AT-21, AT-44, AC-RPT-1, AC-PERF-4 | Adds AT-70, AT-103, AT-104, AT-122 from TEST_PLAN.md, and J8 (owner to top items by margin in ≤ 3 clicks) | TEST_PLAN.md assigns them to Phase 6 |
| AC-PERF-4 "on the counter iMac" | Measured on the development PC and Windows CI with a synthetic year; the iMac at the Phase 7 dry run | The iMac is reached at I-6; nothing about its speed is claimed before it is measured |
| — | The counter app's download path (F-10 from the Phase 5 RBAC review) | Exports need it anyway; one reviewed path for both |

## 4. Build order

Each step is a vertical slice: queries, API, screens and tests together. Every report is **one query definition** shared by the screen, the CSV and the PDF (FINANCE_REPORTING.md §6), so a total cannot differ between them; every new route joins the route × role matrix.

| Step | Work | Tests that must pass | Depends on |
|---|---|---|---|
| 6.1 ✅ | **KPI module and report engine.** The KPIs of FINANCE_REPORTING.md §3 as tested functions over business dates; a report definition = filters + one query returning rows and totals computed from those rows; period helpers (day, week Mon–Sun, month, custom, comparison period, P6-8); COGS coverage and the "costs incomplete" and "Needs recipes" rules; a reconciliation harness that, for any report and filters, checks tile = Σ rows = CSV = PDF text | AT-70, AT-44 (reports side), AC-RPT-1 harness on the first reports, KPI unit tests against hand-worked fixtures | Phase 5 |
| 6.2 ✅ | **Owner overview.** Headline tiles with comparison, sales by hour and by day as simple charts with a table beside each (P6-5), top items by sales and by margin, open alerts; every tile opens its report; margin tiles only with `reports.profit`; a manager sees what their permissions allow; live refresh on new sales | AT-20 (dashboard part), J8, UX accessibility checks (AT-86) | 6.1 |
| 6.3 ✅ | **Money and sales reports.** Sales summary; by item and category; by hour and day; menu engineering (popularity × margin); gross profit & margin; discounts, comps & refunds; payment mix & collections; delivery report; recorded operating result; ledger and expenses as reports. Filters (period, order type, category, item, staff, method), drill-down to invoices and lines | AT-20 (each report), AC-RPT-1 for every KPI in them | 6.1 |
| 6.4 ✅ | **Stock, purchases and people reports.** Inventory usage; waste & expiry; stock on hand & valuation (values only with `inventory.cost_view`); counts & variances; purchases; staff activity; audit log as a report (its CSV comes with the 6.5 exports) | AT-20, AC-RPT-1 for each | 6.1 |
| 6.5 ✅ | **Exports and day-end.** CSV and branded A4 PDF for every report (P6-3), file names with the filters, exports audited and needing `reports.export` plus the report's own permission; the day-end report for a business date (PDF, and the 80 mm summary through the existing printer path), generated after the cutoff (P6-9); the counter app saves the app's own exports and attached bills into Downloads with a save dialog, nothing else (P6-7) | AT-103, AT-122, golden files for the 80 mm day-end and for PDF text, Electron e2e of the save path | 6.3, 6.4 |
| 6.6 | **Scheduled e-mails.** Mailbox settings entered by you on the owner screen (P6-4; the password is never shown again), a "send a test" button; schedules (report, filters, recipients, daily/weekly/monthly, time); the worker generates each completed period once, queues one e-mail per recipient, retries with backoff while offline, keeps the Message-ID across retries; status, errors and resend on screen | AT-21, AT-104, a local test mail server (no internet in tests), CT: two workers on one due schedule ×100 → one run | 6.5 |
| 6.7 | **Phase 6 acceptance.** Synthetic year generator on the sample menu; AC-PERF-4 measured (month-range owner reports ≤ 3 s) and recorded; AC-RPT-1 across every report and KPI; property test (random sales, refunds and expenses: every KPI = Σ its rows, exports equal); races ×100; Windows CI; `docs/phase-6/ACCEPTANCE.md` | Phase 6 exit criteria | 6.1–6.6 |

## 5. What I need from you, and when

| # | Input | Needed by | Without it |
|---|---|---|---|
| I-17 | Your mailbox for sending (provider such as Gmail or Outlook, and an **app password** you create there). **You type it into the owner screen yourself**; I never see or handle it | Step 6.6 | Tested against a local test mail server; nothing is sent until you enter it |
| I-18 | Who receives which report, and when (D-20 default: day-end PDF daily at 08:00 to you; weekly summary on Monday) | Step 6.6 | The default above, to your address only |
| I-19 | Your logo (PNG or SVG) for the PDF header, if you want one | Step 6.5 | The shop name in your brand colour, as on receipts |
| I-20 | Whether the counter PC may reach your mail provider over the internet (outbound port 587). If your router blocks it, a **blurred screenshot** of its firewall page, never its password | Before go-live | E-mails stay queued and visible as "waiting for internet" |

Still open and not blocking Phase 6: your Phase 5 inputs (I-12…I-16), your Phase 4 data (I-7…I-11) and the Phase 3 on-site items (I-1, I-5, I-6).

## 6. Proposals that need your approval

| # | Proposal | Recommendation |
|---|---|---|
| P6-1 | Start Phase 6 before your Phase 5 inputs are in | Yes: they are data and choices, not code. Phase 5 stays formally open until they are recorded |
| P6-2 | One query definition per report for screen, CSV and PDF | Yes: totals are computed once from the same rows, so AC-RPT-1 holds by construction and is still checked by tests |
| P6-3 | PDFs made on the server, offline, with **pdfkit** (open source, MIT, plain JavaScript, no internet, no browser) | Adds one dependency, pinned and audited in CI. The alternative, a headless browser on the counter PC, is heavy for a 2011 iMac |
| P6-4 | E-mail through your mailbox with **nodemailer** (open source, MIT, plain JavaScript), TLS required; the mailbox password stored encrypted with a key kept in the protected config folder, never sent back to any screen, never in logs or backups unencrypted | Adds one dependency. You enter and change the password yourself |
| P6-5 | Charts as simple drawings made by the app (bars and lines) with the numbers in a table beside each | No chart library: lighter, prints well, readable by screen readers |
| P6-6 | Reports read the live tables over business dates; pre-computed daily summaries only if AC-PERF-4 fails on the synthetic year | Simpler and always current; if summaries are needed, they are rebuilt nightly and checked against the live tables by a test |
| P6-7 | The counter app saves files only from the app's own export and bill addresses, into the Counter user's Downloads with a save dialog | Closes F-10 without opening the counter PC to other downloads |
| P6-8 | Comparison on the overview: the same weekday(s) last week; on reports: the previous period of the same length | As UI_UX.md §5 asks; a custom comparison stays possible on reports |
| P6-9 | The day-end report is generated by the worker after the 04:00 cutoff for the completed business day, kept with the backups, printable on 80 mm on request | One fixed day-end per business date: the same numbers on screen, on paper and in your e-mail |

## 7. Risks

| Risk | Mitigation |
|---|---|
| Report scope grows (roadmap risk) | The catalogue of FINANCE_REPORTING.md §6 is the scope; new ideas go to a backlog list in ACCEPTANCE.md |
| PDF layout differs from what you expect (roadmap risk) | Text of each PDF pinned by golden files; samples sent to you for review with the branding (R5, I-19) |
| Margins read as complete while recipes are missing | COGS coverage on every report with costs; "Needs recipes" for the operating result below 95 % (AT-70) |
| Month reports slow on the 2011 iMac | Indexed business-date queries, measured on a synthetic year now; on the iMac at the Phase 7 dry run, with P6-6 summaries ready if needed |
| E-mail blocked or mailbox password changes | Test-send button with the provider's error shown; queue keeps everything until it works; nothing is lost while offline |
| Mailbox password exposure on an unpatched Windows PC (SR-1) | Encrypted at rest, ACL-protected key, never displayed or logged, outbound SMTP over TLS only |

## 8. Working rules (unchanged)

- Every step ends with its tests passing, `corepack pnpm verify` green, Windows CI green and a commit pushed to `phase-6/reports` (branched from `main`); nothing is reported as done without test output.
- Migrations are forward-only and follow DATABASE.md; any deviation is recorded in DATABASE.md §15 in the same commit.
- No business data beyond samples until you send yours; no secrets in the repository; the mailbox password is entered only by you, on screen.
- Hardware and performance on the shop's own PC are never claimed until measured there.
