# Phase 6 acceptance (step 6.7)

Status on 31 October 2026, branch `phase-6/reports`. Everything Phase 6 asks of the software is green. What is left needs you or the shop's own PC: your mailbox and its app password, typed by you (I-17); who gets which report (I-18); your logo, if you want one on the PDFs (I-19); whether the counter PC may reach your mail provider (I-20); and AC-PERF-4 measured again on the counter iMac at the Phase 7 dry run (§2).

## 1. Exit criteria (PLAN.md, TEST_PLAN.md §4 Phase 6 row)

| Criterion | Status | Evidence |
|---|---|---|
| Every KPI reconciles to its detail rows and to its exports (AT-20, AC-RPT-1) | ✅ | One oracle (`apps/server/test/support/report-checks.ts`): for a period, every report's totals are the sums of its rows, its CSV has the same rows and totals, the reports that count the same money agree (bills, items and categories with the day; collected with the payment mix; staff takings with it; stock used with COGS; waste; expenses; refunds), and the overview's tiles are the totals of the reports they open. It runs on a year of synthetic trading, for the year and for each of its 13 months (§3), and after every sequence of the property test (§2). PDFs: same report object, golden text (`pdf.test.ts`) |
| The scheduled e-mail queue tests green (AT-21, AT-104) | ✅ | `apps/server/test/mail/mail.test.ts` against a local test mail server over STARTTLS (no internet) |
| Every Phase 6 test in TEST_PLAN.md §5 green | ✅ | §4. `corepack pnpm verify`: 643 tests green. E2E: 27 web journeys on installed Chrome, 7 counter-app tests in Electron |
| Exit demo | ✅ | A year of synthetic trading on the sample menu (§3): the owner overview for a month in 52 ms on the development Mac; every report opened for every month and exported to CSV with the same totals; the day-end PDF queued while the mail server was unreachable and sent once it was back, with its Message-ID (`mail.test.ts`, AT-21) |
| AC-PERF-4: month-range owner reports ≤ 3 s with a year of data | ✅ on the development Mac; counter iMac at the Phase 7 dry run | §3: the slowest month-range report took 81 ms |
| Property test; races ×100; Windows CI | ✅ | §2; every step's CI (Linux verify with the dependency audit, unattended Windows install) green |

## 2. Longer runs

| Run | Result |
|---|---|
| **Reports property** (`apps/server/test/reports/property.test.ts`), `CL_PROP_RUNS=100`: 100 sequences of 5–15 random events through the API (sales by every method and provider, some at 5, 10 or 25 % off; refunds of 30, 50 or 100 %; method corrections; paid-ins and paid-outs; milk received paid or on credit; expenses by cash, card or bank; waste), then the whole oracle | all green, 100 sequences in 28 s |
| The oracle catches a wrong report: with the payment mix's "collected" deliberately left without refunds, the property fails at once and names the seed to replay | checked once by hand |
| Races `CL_RACE_RUNS=100`, including two workers making one due schedule (one run, one e-mail per recipient) | all green; the schedule race 100 rounds in 1.5 s |
| The whole server suite with `CL_PROP_RUNS=100 CL_RACE_RUNS=100` | all green: 521 tests in 106 s (ledger property 87 s, reports property 28 s, PT-01 14 s) |
| What the long run found | The Phase 5 **ledger property** reached a shift whose expected cash was below zero, so it could not be closed: a payment taken as cash was **corrected to card after the cash had been paid out**, and a correction out of cash was not checked against the till the way a cash refund, an expense from the till and a paid-out are. **Fixed** in this step: it is refused like them ("Only Rs … should be in the till"), with a test in `refunds.test.ts` that fails without the fix. PT-01 also ran past the default 20 s under the full suite's load and now has the 300 s limit the other long tests have |

## 3. The year (AC-PERF-4, AC-RPT-1)

`apps/server/test/acceptance/phase6-reports.test.ts` with `CL_SYNTH_DAYS=365 CL_SYNTH_BILLS=60` (test/support/synthetic.ts): the sample menu, 12 tables, and each business day from 31 October 2025 to 29 October 2026 traded through the API on a clock the server reads its business dates from: a cash shift from 10:00 to midnight closed with the counted cash; 42–78 bills a day at tables and at the counter, busier at lunch and in the evening, of 1–3 menu sizes with their required choices, picked up so their stock is used, 5 % of them at 10 % off, half paid in cash, a quarter by card, a quarter by JazzCash, Easypaisa or bank; 1 % half refunded; milk received and beans wasted every Monday with the week's supplies; the rent on the 1st. **21,886 bills** in 365 days, made in 12.5 minutes.

Then every report for the year and for each month passed the oracle, the last 7 days' stored day-ends matched their days, and each report for September 2026 (a full month) was timed, slowest of three warm runs, through the API on the development Mac (Apple silicon, PostgreSQL 17 local):

| Report (one month) | Time |
|---|---|
| Owner overview | 52 ms |
| Sales by day | 16 ms |
| Bills | 31 ms |
| Sales by item | 13 ms |
| Sales by category | 11 ms |
| Sales by hour | 8 ms |
| Menu engineering | 10 ms |
| Discounts, comps & refunds | 5 ms |
| Payment mix | 2 ms |
| Deliveries | 1 ms |
| Recorded operating result | 16 ms |
| Ledger | 46 ms |
| Expenses | 2 ms |
| Inventory usage | 3 ms |
| Waste & expiry | 1 ms |
| Stock on hand | 1 ms |
| Stock counts | 1 ms |
| Purchases | 1 ms |
| Staff activity | 81 ms |
| Audit log | 7 ms |
| Sales by day as a PDF | 36 ms |

The limit is 3 s. The counter iMac (2011) is far slower than this Mac; the same test is to be run there at the Phase 7 dry run (it takes about 15 minutes to make the year), and its numbers recorded here. Without `CL_SYNTH_DAYS` the test trades 10 days of 12 bills, so every commit runs the generator and the oracle.

## 4. Phase 6 tests and where they run

| Test | What | Where |
|---|---|---|
| AT-20 | Overview with date, staff and order-type filters = detail rows = exports | `apps/server/test/reports/kpi.test.ts` (filters, a hand-worked day), `money.test.ts`, `stock.test.ts`, `exports.test.ts`, the year (§3) and the property (§2); on screen `apps/web/e2e/reports.spec.ts` |
| AC-RPT-1 | Every KPI = drill-down = export, to the rupee | The oracle (§1) over the year and the property; drill-downs (day → bills → lines, item → days) `money.test.ts` and `reports.spec.ts` |
| AT-70 | Coverage < 100 %: margin over recipe items only; < 95 %: "Needs recipes" | `apps/server/test/reports/kpi.test.ts` |
| AT-103 | CSV: BOM, ISO dates, plain decimals; PDF footer states formulas and filters | `apps/server/test/reports/exports.test.ts`, `pdf.test.ts` (golden PDF text in `test/reports/golden`) |
| AT-122 | The day-end agrees with payments, refunds, shifts and open bills | `apps/server/test/reports/exports.test.ts`; the 80 mm slip `apps/server/test/printing/render.test.ts` (golden `day-end.txt`) |
| AT-21 | A scheduled report due while offline waits, goes when the server is back, status visible | `apps/server/test/mail/mail.test.ts` |
| AT-104 | Retried after a failure with the same Message-ID; statuses and errors visible | `apps/server/test/mail/mail.test.ts` (a 451 retried; a 550 refused, retried by hand) |
| CT (schedules) | Two workers on one due schedule ×100 → one run | `apps/server/test/mail/mail.test.ts` |
| J8 | The owner reaches the top items by margin in ≤ 3 clicks | `apps/web/e2e/reports.spec.ts` (on the overview, one click from the menu) |
| AT-44 (reports) | A sale at 00:30 counts on the previous business date | Phase 3 (`billing.test.ts`); the reports use the same dates, and step 6.6 fixed three places that did not (§5) |
| AT-86 | Accessibility of the new screens | `apps/web/e2e/reports.spec.ts` (overview, a report, bill lines, stock on hand, day-end, scheduled e-mails, mailbox settings) |
| P6-7 / F-10 | The counter app saves only the app's own exports and attached bills | `apps/desktop/test/desktop.test.ts` (policy), `apps/desktop/e2e/desktop.spec.ts` (an export saved, any other download refused) |
| P6-4 | Mailbox password sealed, never shown, never logged | `apps/server/test/mail/mail.test.ts`; the key file's rights on Windows: the CI install check |
| SEC-ALL | Every route × every role, with the Phase 6 routes (an export needs its report's permission and `reports.export`) | `apps/server/test/identity/route-matrix.test.ts`; `docs/phase-5/RBAC_REVIEW.md` regenerated |

## 5. What the phase found and fixed

| Found | Fixed in |
|---|---|
| Between midnight and the 04:00 cutoff, the Reports screen's "Today" was the PC's calendar date, so it showed an empty day | 6.6: `GET /reports` returns the business date and the screen uses it |
| The audit-log report cut its days at midnight instead of 04:00 | 6.6: business-day bounds; a test pins 03:59 and 04:00 |
| After midnight, an asset's maintenance done "today" was refused as being in the future | 6.6: dates people write down are checked against the shop's calendar date |
| nodemailer before 10.1.4 had address-parser advisories | 6.6: 10.1.7, and recipients are plain addresses only |
| A payment corrected from cash to card after its cash had left the till took expected cash below zero | 6.7: refused like a cash refund (§2) |

## 6. Open items

| # | Item | Needs |
|---|---|---|
| I-17 | Your mailbox and app password | You: Settings → E-mail, then "Send a test". Nothing is sent before |
| I-18 | Who receives which report, and when | You: Reports → E-mails (suggested: the day-end daily at 08:00 to you; sales by day weekly on Monday) |
| I-19 | Your logo for the PDFs | You, if wanted; until then the shop name in the brand colour |
| I-20 | Outbound port 587 from the counter PC | At the dry run; until then e-mails wait, shown as "Cannot reach the mail server" |
| AC-PERF-4 on the iMac | §3's test on the counter iMac | Phase 7 dry run |
| Not tried here | The Windows save dialog of the counter app (tested on macOS with the test folder override); a real provider's mail server (tested against a local one) | The dry run, with your mailbox |
| Earlier phases | Phase 3 on-site items (I-1, I-5, I-6), Phase 4 data (I-7…I-11), Phase 5 lists (I-12…I-16) | Unchanged |
