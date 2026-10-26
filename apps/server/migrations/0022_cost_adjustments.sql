-- 0022 Supplier price corrections (DATABASE.md §8 `cost_adjustments`; COST_VALUATION.md §6;
-- Phase 4 step 4.6). A receipt line turns out to have cost Δ more or less than recorded:
-- the share still assumed on hand goes into stock value now (a `cost_adjustment` movement
-- with quantity 0), the rest is purchase price variance of today. Nothing posted before is
-- changed, so past averages, line costs and margins stay as they were (AT-19, AT-68).

CREATE TABLE cl.cost_adjustments (                             -- (A)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES cl.inventory_items,
  receipt_line_id bigint NOT NULL REFERENCES cl.purchase_receipt_lines,
  amount          cl.amount NOT NULL CHECK (amount <> 0),     -- signed total correction Δ
  to_inventory    cl.stock_value NOT NULL,
  to_variance     cl.stock_value NOT NULL,
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
  movement_id     bigint NOT NULL UNIQUE REFERENCES cl.stock_movements,
  actor_user_id   bigint NOT NULL REFERENCES cl.users,
  business_date   date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (to_inventory + to_variance = amount),
  CHECK (sign(to_inventory) * sign(amount) >= 0 AND sign(to_variance) * sign(amount) >= 0)
);
CREATE INDEX cost_adjustments_item_idx ON cl.cost_adjustments (item_id);
CREATE INDEX cost_adjustments_line_idx ON cl.cost_adjustments (receipt_line_id);
CREATE INDEX cost_adjustments_actor_idx ON cl.cost_adjustments (actor_user_id);
CREATE INDEX cost_adjustments_bdate_idx ON cl.cost_adjustments (business_date);
CREATE TRIGGER cost_adjustments_append_only BEFORE UPDATE OR DELETE ON cl.cost_adjustments
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
