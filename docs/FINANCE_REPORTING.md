# Coffee Lounge — Finance & Reporting Definitions (Phase 1, package 1D)

> Design specification for review R4. Provisional defaults D-19, D-20, D-21, D-22 apply (DECISIONS.md). This is an **operational** ledger and reporting system, not statutory accounting (DEC-10, FIN-002). No report is labelled "balance sheet", "P&L statement" or "net profit".

## 1. Time rules

| Rule | Definition |
|---|---|
| Shop timezone | Asia/Karachi (PROVISIONAL D-22) |
| Business day | 04:00 to 03:59:59 next calendar day. A sale settled at 00:30 belongs to the previous business date. |
| Business date stored | On every invoice, payment, refund, movement, ledger entry and expense, computed when written, never recomputed |
| Period filters | Hour, day, week (Mon–Sun), month, year, custom range: always on **business dates**; hourly charts use local clock hours within those dates |

## 2. Which events count when (PROVISIONAL D-21)

| Figure | Counted on | Source |
|---|---|---|
| Sales | **Settlement** business date of the invoice | `invoices` (settled), `invoice_lines` |
| Refunds | **Refund** business date | `refunds`, `refund_lines` |
| Payments collected | Payment business date | `payments` |
| COGS shown next to sales (margins) | The **invoice's settlement date**, using each line's frozen cost | `order_line_costs` via `invoice_lines` |
| Inventory usage, waste, variance | Movement business date | `stock_movements`, `wastage_records` |
| Expenses | Expense business date | `expenses` (status recorded) |
| Open (unsettled) bills | Not in sales until settled; shown separately as **"Open bills"** | `invoices` open/locked |

## 3. KPI definitions

All amounts in PKR, computed at full precision and rounded to 2 dp for display. Totals are **sums of rows, then rounded** (never sums of rounded figures).

| KPI | Formula | Notes |
|---|---|---|
| **Gross sales** | Σ `invoice_lines.gross` | Before any discount; includes comped items at menu price |
| **Promotions** | Σ `promotion_discount` | Scheduled promotions |
| **Manual discounts** | Σ `manual_discount` on lines where `is_comp = false` + Σ `discount_alloc` | Line and bill discounts |
| **Comps** | Σ `manual_discount` on lines where `is_comp = true` | Shown separately so free items are visible |
| **Discounts (total)** | Promotions + manual discounts + comps | |
| **Refunds** | Σ `refunds.amount` (kind = refund) | Method corrections excluded (no net effect) |
| **Net sales** | Gross sales − Discounts − Refunds | Tax = 0 (DEC-13); rounding excluded |
| **Cash rounding** | Σ `invoices.rounding_adjustment` | Reported separately (PROVISIONAL D-16) |
| **Collected** | Σ payments − Σ refunds paid out | Should equal Net sales + Cash rounding for fully settled periods; difference = refunds of earlier-period sales |
| **Orders** | Count of settled invoices | One per visit/takeaway/delivery |
| **Average order value (AOV)** | Net sales before refunds ÷ Orders | Orders > 0 |
| **Items sold** | Σ `billable_qty` | By item, category, order type |
| **COGS (sold items)** | Σ cost of billable units (COST_VALUATION.md §7) for invoices in the period | Includes comped units |
| **COGS coverage %** | Net sales of recipe-tracked lines ÷ Net sales × 100 | Below 100 % → all margin figures carry a warning: "Costs incomplete: X % of sales have no recipe yet" (D-29) |
| **Gross profit (sales)** | Net sales − COGS (sold items) | Item-level margins use this |
| **Waste cost** | Σ `wastage_records.cost_value` | Ingredient, expired, prepared-item, failed-delivery |
| **Stock variance** | −Σ `value_delta` of `count_adjustment` movements (including those flagged `auto_found_stock`) | Positive = shrinkage cost; found stock reduces it |
| **Purchase price variance** | Σ `cost_adjustments.to_variance` | |
| **Gross profit (after waste)** | Gross profit (sales) − Waste cost − Stock variance − Purchase price variance | **Headline figure** on the owner dashboard (PROVISIONAL D-21) |
| **Gross margin %** | Gross profit (after waste) ÷ Net sales × 100, computed over **recipe-tracked lines only** while COGS coverage < 100 % | Untracked lines have no cost, so including them would overstate the margin. Hidden when Net sales = 0 |
| **Recorded expenses** | Σ `expenses.amount` (recorded, not voided) | Ingredient purchases are **not** expenses: they become stock and reach the figures as COGS |
| **Recorded operating result** | Gross profit (after waste) − Recorded expenses. **Shown only when COGS coverage ≥ 95 %** for the period; otherwise displays "Needs recipes" (with no figure), because missing costs would overstate it | Always labelled **"Recorded operating result: based only on expenses entered; excludes unrecorded costs such as unpaid wages or depreciation"** (D-19) |
| **Payment mix** | Σ payments by method (cash, card, bank, JazzCash, Easypaisa) | |
| **Outstanding COD** | Σ total of delivery invoices locked at dispatch and not yet settled, by rider | Live and on day-end |
| **Table utilisation** | Occupied minutes ÷ (tables × open minutes) per period | Dine-in sessions only |
| **Average table turn time** | Mean (closed_at − opened_at) for settled dine-in sessions | |
| **Approval time** | Median (decided_at − submitted_at) for QR rounds | Staff responsiveness |
| **Pickup time** | Median (first pickup − acceptance) per line | Proxy for kitchen speed (no kitchen screen, D-33) |

**Discount allocation (PROVISIONAL D-21):** a bill-level discount is split across the invoice's lines in proportion to each line's net-before-bill-discount. The last line takes the rounding remainder so the shares add up exactly to the discount.

**As built (Phase 6 step 6.1):** a period's figures are the sums of its business days, and ratios are worked out from those sums. *COGS coverage* compares line net sales (after discounts, before refunds) of recipe-tracked lines with all lines; a line is recipe-tracked when its size was sold with stock mode "recipe". *Gross margin %* while coverage is below 100 % is (recipe lines' net − COGS − waste − stock variance − purchase price variance) ÷ recipe lines' net. Refunds by item count only refunds recorded with their items. Waste, stock variance, purchase price variance, expenses and cash rounding belong to the whole shop and are left out when a report is filtered by order type, category or item.

## 4. Operational ledger posting rules

The ledger records **money movements** with a link to their source. Every row has a unique `source_key`, so a retry can never post twice.

| Business event | Ledger entry | Direction | Channel |
|---|---|---|---|
| Payment received | `sale_receipt` | in | cash / card / transfer (+ provider) |
| Refund paid | `refund` | out | method used |
| Payment method correction | `reversal` of the original + new `sale_receipt` | out / in | both |
| Purchase receipt paid at receipt | `purchase_payment` | out | channel chosen |
| Expense recorded | `expense` | out | `paid_via` |
| Expense voided | `reversal` | in | same |
| Cash paid-in / paid-out (shift) | `cash_in` / `cash_out` | in / out | cash |
| Supplier refund for a return | `cash_in` | in | channel |
| Manual entry (owner) | `adjustment` | in / out | chosen; reason required |

Ledger entries are never edited. Owners "edit" by posting a reversal and a new entry (D-31). The ledger view shows a running balance **per channel** (cash, card, transfer by provider) for any date range.

## 5. Cash shift reconciliation

```text
Expected cash = opening float
              + cash payments received in this shift (incl. COD handed over)
              − cash refunds paid in this shift
              + paid-in − paid-out
Variance      = counted cash − expected cash
```

Card and transfer totals are shown for checking against the HBL terminal settlement slip and bank/wallet apps, but they're not part of drawer cash. Variances need approval by someone other than the cashier (RBAC §5).

## 6. Report catalog

| Report | Main filters | Permission | Exports |
|---|---|---|---|
| Owner overview (dashboard) | Period + comparison period | `reports.sales` (+ `reports.profit` for margin tiles) | PDF |
| Sales summary | Period, order type, category, item, staff, payment method | `reports.sales` | CSV, PDF |
| Sales by item / category | Same | `reports.sales` | CSV, PDF |
| Sales by hour / day | Same | `reports.sales` | CSV, PDF |
| Item popularity × margin (menu engineering) | Period, category | `reports.profit` | CSV, PDF |
| Gross profit & margin | Period, order type, category | `reports.profit` | CSV, PDF |
| Discounts, comps & refunds | Period, staff, reason | `reports.sales` | CSV, PDF |
| Payment mix & collections | Period, method, provider | `reports.sales` | CSV, PDF |
| Day-end report | Business date | `reports.sales` | PDF (printable 80 mm summary too) |
| Cash shift report | Shift | `cash_shifts.operate` (own) / `reports.sales` | PDF, 80 mm print |
| Delivery report | Period, rider, outcome | `reports.sales` | CSV, PDF |
| Inventory usage | Period, item, category | `reports.inventory` | CSV, PDF |
| Waste & expiry | Period, kind, reason, item | `reports.inventory` | CSV, PDF |
| Stock on hand & valuation | As of now | `reports.inventory` + `inventory.cost_view` for values | CSV, PDF |
| Stock counts & variances | Count | `reports.inventory` | CSV, PDF |
| Purchases (receipts) | Period, supplier, item | `reports.inventory` | CSV, PDF |
| Expenses | Period, category | `expenses.read` | CSV, PDF |
| Recorded operating result | Period | `reports.profit` | PDF |
| Ledger | Period, type, channel | `ledger.read` | CSV, PDF |
| Staff activity | Period, user | `reports.staff` | CSV, PDF |
| Audit log | Period, user, entity | `audit.read` | CSV |

**Every report footer** states: period and business-day rule, filters applied, the formula of each total, COGS coverage when costs appear, and the generation time.

**Reconciliation guarantee (AC-RPT-1):** every dashboard tile and chart total equals the sum of its drill-down rows and of its CSV/PDF export for the same filters. Each report is built from **one** query definition shared by screen, CSV and PDF.

## 7. Day-end report (content)

Business date · gross sales, discounts (promotions / manual / comps), refunds, net sales, cash rounding · orders, AOV, by order type · payment mix (cash, card, each transfer provider) · open bills still unsettled (count and value) · outstanding COD by rider · cash shifts with variances · voids and waste (count, cost) · top 10 items · COGS coverage and gross margin (if permitted) · alerts open at day end (stock, backups).

## 8. Exports and scheduled e-mails (PROVISIONAL D-20)

- **CSV:** UTF-8 with BOM (opens correctly in Excel), comma-separated, ISO dates, amounts as plain decimals without thousands separators, one header row, filter summary in the file name.
- **PDF:** branded header (logo + shop name), A4 portrait (landscape for wide tables), page numbers, footer as in §6, generated on the server without internet.
- **Schedules:** owner sets report type, filters, recipients, frequency (daily/weekly/monthly) and send time. The worker generates the PDF for the **completed** period after the business day ends, then queues one e-mail per recipient.
- **Offline:** e-mails stay **queued** with visible status and are retried with backoff when the internet returns. Delivery is at-least-once (a rare duplicate is possible); a stable Message-ID helps mail clients de-duplicate.
- Exports and schedule changes are permission-checked and audited.

## 9. Open points for review R4

1. Headline margin = **Gross profit after waste** (rather than sales-only gross profit). Agree?
2. Staff meals: record as **waste** with reason "staff meal", or as a **comp** on a staff bill? Proposed: waste with reason.
3. Weekly reports run Monday–Sunday. Agree?
4. Should **cashiers** see their own shift's sales total on screen? Proposed: yes, own shift only.
