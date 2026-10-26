# Coffee Lounge — Stock Costing Rules (Phase 1, package 1D)

> Design specification for review R4. **Method approved by the owner (D-04): perpetual weighted-average cost (WAC) with FEFO physical picking.** Comparison and worked examples: `docs/phase-0/05-inventory-costing.md`. Tables: DATABASE.md §5, §8.

## 1. Principles

1. Every item has one running **quantity (Q)** and **value (V)** in `inventory_balances`. Average cost **A = V ÷ Q**.
2. Value changes **only** together with a stock movement, in the same transaction, under the item's row lock.
3. Costs are applied in **posting order**. Nothing is ever recalculated backwards. Corrections post in the current period.
4. Each sold line's cost is **frozen** at consumption (`order_line_costs`). Later receipts or corrections never change past margins.
5. Values are kept to **4 decimal places** internally; reports round only for display.

## 2. Notation

`Q` on hand (base units) · `V` stock value (PKR) · `A = V/Q` (8 dp, null when Q = 0) · `L` last unit cost = unit cost of the most recent receipt or issue (kept even when Q = 0) · `q` movement quantity · `round4()` half-up to 4 dp.

## 3. Receipts (purchases, opening balances)

```text
unit_cost  = line_cost / q          (8 dp)
Q := Q + q
V := V + line_cost
L := unit_cost
movement: qty_delta = +q, unit_cost, value_delta = +line_cost
```

Opening balance: the clerk enters quantity and **unit cost** (or total value) per item/lot. It's posted as an `opening` movement with the same formulas.

**Reversing a receipt** (added in Phase 4 step 4.2; allowed only while its quantity is still available): when nothing else has moved the item since the receipt, the reversal takes out exactly `q` and `line_cost` and restores `L` to its value before the receipt, so the item is exactly as it was. Otherwise `q` leaves like an issue (§4) at the current average, flagged `at_average`: the receipt's cost stays blended into what remains, and value can never go negative. Either way it is one `reversal` movement per line pointing at the receipt's movement.

## 4. Issues (consumption, waste, negative count adjustment, supplier return)

```text
if q = Q:  value = V                 -- "drain rule": the last units take all remaining value
else:      value = round4(q × V / Q)
Q := Q − q
V := V − value
movement: qty_delta = −q, unit_cost = A (before), value_delta = −value
```

The drain rule means **no rounding residue can ever remain** when stock reaches zero. The `rounding` movement type exists only as a safety valve and is not expected to be used.

## 5. Positive adjustments (count found more, "found stock")

```text
unit_cost = A if Q > 0, else L, else (no history) → the approver must enter a unit cost
value     = round4(q × unit_cost)
Q := Q + q ; V := V + value
```

**Pickup needing more than the system's on-hand** (only possible after a count recorded too little, e.g. shortfall alert open): the kitchen physically used stock the system didn't know about. The pickup is never blocked. The system first posts an automatic positive adjustment for the missing quantity (valued as above, flagged `auto_found_stock`, raising an owner alert), then posts the consumption. The owner sees exactly where the count was wrong.

## 6. Supplier price corrections (cost adjustments)

A receipt line of quantity `q_r` turns out to have cost Δ more (or less) than recorded:

```text
share_to_stock   = Δ × min(1, Q / q_r)      -- portion assumed still on hand
share_to_variance = Δ − share_to_stock      -- portion already used → purchase price variance (cost of goods) today
V := V + share_to_stock
```

Under WAC we can't know which physical units remain, so the proportion of current stock to the received quantity is used. This is a documented approximation that keeps past periods unchanged. Posted as a `cost_adjustment` movement (quantity 0) plus a `cost_adjustments` record. Requires `inventory.cost_adjust` (owner).

If Δ is negative and `share_to_stock` would make V negative, the excess goes to variance as well.

**As built (Phase 4 step 4.6):** the owner enters what the line really cost; Δ is taken against the cost on record (the line cost plus earlier corrections), so a second correction corrects the first. `Q` is the item's on-hand at the moment of the correction (later receipts count). With nothing on hand all of Δ is variance (V must stay 0 at Q = 0). A corrected receipt is no longer reversed; returns stay possible.

## 7. Cost of a sold line (COGS)

```text
line_consumption_cost = Σ order_line_costs.value  (all ingredients, all pickups of the line)
cost_per_unit         = line_consumption_cost / qty_picked_up
cost_of_waste_units   = cost_per_unit × qty_cancelled_prepared        → reported as waste cost
cost_of_billable_units = line_consumption_cost − cost_of_waste_units   → reported as COGS (comped units included)
```

Untracked lines (no recipe yet, D-29) have **no** COGS and are counted in "COGS coverage" (FINANCE_REPORTING.md §3).

## 8. Waste and variance valuation

| Event | Value |
|---|---|
| Ingredient / expired-lot waste | Issue at current average (§4) |
| Prepared-item waste (voided after pickup, failed delivery) | That line's per-unit consumption cost (§7). No new movement. |
| Count variance (negative) | Issue at current average (§4) → **stock variance** |
| Count variance (positive) | §5 → **stock variance** (reduces cost) |
| Purchase price correction | §6 variance share → **purchase price variance** |

## 9. What is not allowed

- Editing a movement's cost, or the stock value directly.
- Back-dating receipts to change past averages. The supplier invoice date is stored for reference only; costing uses posting time.
- Recalculating historical COGS after a recipe, price or cost change.
- Negative on-hand quantity or negative stock value (database constraints).

## 10. Worked example: drain rule and found stock

| # | Event | Q (ml) | V (Rs) | A (Rs/ml) | Movement value |
|---|---|---|---|---|---|
| 1 | Receipt 3,000 ml for Rs 805 | 3,000 | 805.0000 | 0.26833333 | +805.0000 |
| 2 | Consume 157.5 ml | 2,842.5 | 762.7375 | 0.26833333 | −42.2625 |
| 3 | Consume 157.5 ml | 2,685 | 720.4750 | 0.26833333 | −42.2625 |
| 4 | Count: counted 2,600 (variance −85) | 2,600 | 697.6667 | 0.26833335 | −22.8083 |
| 5 | Waste 2,600 ml (spoiled) — **drain rule** | 0 | 0.0000 | — (L = 0.26833335) | −697.6667 |
| 6 | Count finds 500 ml (Q = 0, uses L) | 500 | 134.1667 | 0.26833340 | +134.1667 |

Step 4: `85 × 720.4750 / 2685 = 22.8083`; the average drifts in the 8th decimal because value is held at 4 dp, which is expected and harmless. Step 5 takes the full remaining value, so V is exactly 0 with no residue. Step 6 uses the last unit cost because Q was 0 (500 × 0.26833335 = 134.1667). Figures verified with exact decimal arithmetic.

## 11. Reconciliation (nightly job and restore integrity check)

For every item:
1. `Q = Σ qty_delta` and `V = Σ value_delta` over all its movements.
2. `Q ≥ 0`, `V ≥ 0`, and `V = 0` whenever `Q = 0`.
3. For every consumption movement linked to an order line there is exactly one `order_line_costs` row with the same value.

Any mismatch raises a critical `balance_mismatch` alert. Nothing is corrected automatically.
