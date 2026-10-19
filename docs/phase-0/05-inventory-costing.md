# 05 — Inventory Costing: Weighted-Average vs FIFO

> Phase 0 · **Decision D-04 approved by the owner on 19 Oct 2026: perpetual weighted-average cost with FEFO physical picking** (§5.7). FIFO structures will not be built. All prices below are **illustrative examples**, not Coffee Lounge data.

## 5.1 Three concepts that must not be confused

| Concept | Question it answers | Applies to |
|---|---|---|
| **Reservation** | "Is enough stock set aside for accepted orders?" | Quantity only, at acceptance |
| **FEFO picking** (First-Expiry-First-Out) | "Which physical batch should the barista use?" | Physical lots with expiry dates |
| **Cost valuation** (WAC or FIFO) | "What did the ingredients in this cup cost us?" | Money: COGS, stock value, margin |

FEFO is an operational rule, not a costing method. FIFO costing does **not** mean the physical milk carton used was the oldest one.

## 5.2 Worked example — whole milk (base unit: ml)

**Events:**

| # | Date | Event | Qty (ml) | Unit cost (PKR/ml) |
|---|---|---|---|---|
| 1 | 1 Oct | Receipt R1 (20 L @ Rs 250/L) | +20,000 | 0.25 |
| 2 | 2 Oct | Consumption (80 cappuccinos × 150 ml) | −12,000 | |
| 3 | 3 Oct | Receipt R2 (30 L @ Rs 270/L) | +30,000 | 0.27 |
| 4 | 4 Oct | Consumption | −25,000 | |
| 5 | 5 Oct | Waste: spoiled carton | −1,000 | |
| 6 | 5 Oct | Stock count: book 12,000, counted 11,500 | −500 | |
| 7 | 6 Oct | Receipt R3 (20 L @ Rs 300/L) | +20,000 | 0.30 |
| 8 | 7 Oct | Consumption (100 cappuccinos × 150 ml) | −15,000 | |

### Weighted-average (perpetual / moving average)

The average is recomputed on each receipt; every issue uses the current average.

| # | Event | Issue cost | Qty after | Value after | Avg cost/ml after |
|---|---|---|---|---|---|
| 1 | R1 | — | 20,000 | 5,000.00 | 0.25000000 |
| 2 | Consume 12,000 | **3,000.00** | 8,000 | 2,000.00 | 0.25000000 |
| 3 | R2 +8,100.00 | — | 38,000 | 10,100.00 | 0.26578947 |
| 4 | Consume 25,000 | **6,644.74** | 13,000 | 3,455.26 | 0.26578947 |
| 5 | Waste 1,000 | **265.79** | 12,000 | 3,189.47 | 0.26578947 |
| 6 | Count −500 | **132.89** | 11,500 | 3,056.58 | 0.26578947 |
| 7 | R3 +6,000.00 | — | 31,500 | 9,056.58 | 0.28751048 |
| 8 | Consume 15,000 | **4,312.66** | 16,500 | 4,743.92 | 0.28751048 |

### FIFO (cost layers)

Each receipt creates a cost layer; issues draw from the oldest remaining layer.

| # | Event | Layers drawn | Issue cost | Remaining layers |
|---|---|---|---|---|
| 2 | Consume 12,000 | 12,000 @ 0.25 (L1) | **3,000.00** | L1 8,000 |
| 4 | Consume 25,000 | 8,000 @ 0.25 (L1) + 17,000 @ 0.27 (L2) | **6,590.00** | L2 13,000 |
| 5 | Waste 1,000 | 1,000 @ 0.27 (L2) | **270.00** | L2 12,000 |
| 6 | Count −500 | 500 @ 0.27 (L2) | **135.00** | L2 11,500 |
| 8 | Consume 15,000 | 11,500 @ 0.27 (L2) + 3,500 @ 0.30 (L3) | **4,155.00** | L3 16,500 |

### Side-by-side result (total purchases Rs 19,100.00)

| Measure | WAC | FIFO | Difference |
|---|---|---|---|
| COGS (sales consumption) | 13,957.40 | 13,745.00 | WAC +212.40 |
| Waste cost | 265.79 | 270.00 | FIFO +4.21 |
| Count shrinkage | 132.89 | 135.00 | FIFO +2.11 |
| **Total cost out** | **14,356.08** | **14,150.00** | WAC +206.08 |
| Closing stock value (16,500 ml) | 4,743.92 | 4,950.00 | FIFO +206.08 |

Both methods reconcile: cost out + closing value = Rs 19,100.00. When prices are rising, FIFO reports lower COGS (higher profit) and a higher closing stock value, because the cheaper old layers are expensed first. WAC sits between old and new prices.

### What one cappuccino's milk costs on 7 Oct

| Cup # on 7 Oct | WAC | FIFO |
|---|---|---|
| 1 – 76 | 43.13 | 40.50 (all from L2) |
| 77 | 43.13 | 42.00 (100 ml L2 + 50 ml L3) |
| 78 – 100 | 43.13 | 45.00 (all from L3) |

Under FIFO, identical drinks made on the same afternoon carry three different costs. The ordering of concurrent "Ready" taps on the KDS decides which cup gets the cheaper layer. Under WAC every cup made between two receipts costs the same.

## 5.3 Recipe cost & margin (illustrative)

**Cappuccino — Regular, version 3** (example recipe, not a production recipe):

| Component | Qty | Unit cost (WAC, 7 Oct) | Cost |
|---|---|---|---|
| Espresso beans | 18 g | Rs 6.00/g (Rs 6,000/kg) | 108.00 |
| Whole milk | 150 ml | Rs 0.28751/ml | 43.13 |
| Takeaway cup + lid (takeaway only) | 1 pcs | Rs 35.00 | 35.00 |
| **Dine-in cost** | | | **151.13** |
| **Takeaway cost** | | | **186.13** |

At an illustrative price of Rs 650: dine-in gross profit Rs 498.87 (**76.75 %**); takeaway Rs 463.87 (**71.36 %**).

Modifier example: "Oat milk" (+Rs 150) **replaces** 150 ml whole milk with 150 ml oat milk @ Rs 1.20/ml → cost 108.00 + 180.00 = 288.00 on price 800 → **64.00 %**.

**Two recipe-cost figures exist and both are shown in the UI:**

1. **Standard (theoretical) recipe cost:** current recipe × current average cost. Used for menu pricing decisions on the Recipes screen. Changes as costs change.
2. **Actual line COGS:** the value posted at consumption and stored against the order line (`order_line_costs`). Used for all historical margin reports. **Never changes** after posting.

The gap between theoretical usage and actual usage (counts, waste) is reported as **usage variance**.

## 5.4 Historical margins — no retroactive drift

| Rule | WAC | FIFO |
|---|---|---|
| Cost posted at consumption is frozen on the line | ✔ | ✔ (via layer allocations) |
| Later receipts don't change earlier issues | ✔ | ✔ |
| **Back-dated receipts** (entered today, dated last week) | Costing uses **posting order**, not document date. The document date is kept for reference. No recomputation of past issues. | Same rule required; otherwise past layer allocations would have to be rewritten |
| **Supplier price correction** (e.g., R2 was really Rs 0.28/ml, +Rs 300, found on 8 Oct) | Post a `cost_adjustment` in the current period. The share for quantity still on hand goes to stock value; the share for quantity already consumed goes to a "purchase price variance" COGS line on 8 Oct | Adjust the remaining R2 layer (here 0 ml left), so the whole +Rs 300 goes to price variance on 8 Oct |
| Refund of a sold drink | Revenue refunded; COGS unchanged (ingredients were used) | Same |
| Return to supplier | Valued at current average | Valued at the original layer cost (must locate the layer) |

## 5.5 Expiry, FEFO and costing interaction

Example: lot A (received 1 Oct, expires 10 Oct) and lot B (received 3 Oct, expires **8 Oct**, short-dated). FEFO says use **B first**.

- **WAC:** physical picking (B first) and costing are independent. Every ml costs the current average. If lot A later expires, the write-off is valued at the average. Simple and consistent.
- **FIFO:** accounting expenses A's cost first while the barista physically uses B. If A then expires, its physical write-off is costed from whatever layer is oldest *now*, which may not be A's purchase price. "Cost of expired stock" becomes hard to explain to the owner.
- **Option C: specific-lot costing** (cost follows the physical lot picked by FEFO). It is accurate for lot-tracked items, but most items (sugar, cups, syrups) won't be lot-tracked. That creates two costing behaviours in one system. **Not recommended.**

## 5.6 Implementation complexity

| Aspect | WAC | FIFO |
|---|---|---|
| Lock scope at consumption | Balance row only (already locked for reservation) | Balance row + layer rows; allocation loop across layers |
| Rows per consumption | 1 movement per ingredient | 1 movement + 1..n layer allocations |
| Concurrency risk | Low | Medium: concurrent issues must serialise per item (they do via the balance lock), but layer splitting adds edge cases |
| Corrections/reversals | Revalue at current average | Must restore quantity to the correct historical layer |
| Rounding | A single running value; residual cleared to a rounding movement when quantity reaches 0 | Per-layer rounding; residuals per layer |
| Explainability to owner | "Average price we've been paying" | "Oldest purchase price still on the books" |
| Reporting queries | Sum of `value_delta` | Sum of allocations |
| Accounting acceptability | Both are permitted cost formulas under IAS 2 (LIFO is not). Confirm with the shop's accountant if statements are prepared externally. | Same |
| Testing effort | Moderate | Higher (layer-splitting property tests, reversal tests) |

## 5.7 Recommendation (for approval, not implemented)

**RECOMMENDED: perpetual weighted-average cost (WAC)**, with:

- **FEFO** for physical lot depletion and expiry handling on lot-tracked items only.
- **Posting-order costing**: no retroactive restatement; corrections post in the current period as cost adjustments/price variance.
- Average stored as `inventory_value / on_hand` with `inventory_value` at 4 dp. Issue value = `round(qty × value / on_hand, 4)`. When quantity reaches zero, any residual value is cleared by an explicit rounding movement.
- Actual cost frozen per order line at consumption (`order_line_costs`); standard recipe cost shown separately for pricing.

**Why:** coffee-shop consumption is many tiny draws (ml, g) on a few fast-moving items. WAC gives stable per-cup costs, a simple and auditable trail, no conflict with FEFO, lower implementation risk, and figures the owner can reason about. FIFO's main advantage (layer-level purchase traceability) adds little value for perishable, fast-turnover ingredients. Purchase-price history is still fully visible in receipt records under WAC.

**When FIFO would be the better choice:** if the owner needs closing stock valued at the most recent purchase prices for external reporting, or the accountant requires FIFO. In that case the schema adds `cost_layers` and `cost_layer_allocations`, with an estimated **+15–25 %** effort on the inventory phase and its tests.

## 5.8 Data structures per method

```text
WAC:
  inventory_balances(item_id PK, on_hand, reserved, inventory_value, avg_unit_cost, version)
  stock_movements(..., qty_delta, unit_cost, value_delta, source_key UNIQUE)
  order_line_costs(order_line_id, item_id, qty_base, value)       -- frozen actual COGS
  cost_adjustments(item_id, reason, amount, to_inventory, to_variance, source receipt line)

FIFO (only if chosen):
  cost_layers(id, item_id, receipt_line_id, layer_seq, qty_in, qty_remaining, unit_cost)
  cost_layer_allocations(movement_id, layer_id, qty, unit_cost, value)
  -- plus the same order_line_costs projection
```
