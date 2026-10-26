-- 0020 Supplier returns (RECIPE_INVENTORY.md §11; COST_VALUATION.md §4; Phase 4 step
-- 4.4). Unused stock goes back to the supplier against the receipt line it came on (and
-- its lot): a `supplier_return` movement at the current average. A refund, when the
-- supplier gives one, is recorded with its channel and reference; the ledger entry is
-- written in Phase 5 from these rows (P4-2). One row per returned line, never changed.

CREATE TABLE cl.supplier_returns (                             -- (A)
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_line_id   bigint NOT NULL REFERENCES cl.purchase_receipt_lines,
  item_id           bigint NOT NULL REFERENCES cl.inventory_items,
  lot_id            bigint REFERENCES cl.inventory_lots,
  qty_base          cl.qty NOT NULL CHECK (qty_base > 0),
  value             cl.stock_value NOT NULL CHECK (value >= 0), -- stock value out, at the average
  reason            text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
  refund_amount     cl.amount CHECK (refund_amount >= 0),
  refund_channel    text CHECK (refund_channel IN ('cash','card','transfer')),
  refund_reference  text CHECK (length(refund_reference) <= 60),
  movement_id       bigint NOT NULL UNIQUE REFERENCES cl.stock_movements,
  returned_by       bigint NOT NULL REFERENCES cl.users,
  business_date     date NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((refund_amount IS NULL) = (refund_channel IS NULL)),
  CHECK (refund_reference IS NULL OR refund_amount IS NOT NULL)
);
CREATE INDEX supplier_returns_line_idx ON cl.supplier_returns (receipt_line_id);
CREATE INDEX supplier_returns_item_idx ON cl.supplier_returns (item_id);
CREATE INDEX supplier_returns_lot_idx ON cl.supplier_returns (lot_id);
CREATE INDEX supplier_returns_by_idx ON cl.supplier_returns (returned_by);
CREATE INDEX supplier_returns_bdate_idx ON cl.supplier_returns (business_date);
CREATE TRIGGER supplier_returns_append_only BEFORE UPDATE OR DELETE ON cl.supplier_returns
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
