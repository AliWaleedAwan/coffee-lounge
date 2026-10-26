-- 0019 Lots and expiry (DATABASE.md §5, §8; RECIPE_INVENTORY.md §3, §5, §6 "FEFO";
-- Phase 4 step 4.3). Lot-tracked items keep their quantity in lots as well as in the
-- balance: Σ lots' remaining = on hand, always (the nightly check proves it). Value stays
-- per item (weighted average, D-04); lots carry quantity, expiry and where they came from.
-- Which lots a movement took from or added to is in stock_movement_lots, so one issue
-- keeps one movement and one line cost even when it spans two lots.

CREATE TABLE cl.inventory_lots (                               -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES cl.inventory_items,
  lot_code        text CHECK (length(btrim(lot_code)) BETWEEN 1 AND 40),
  received_at     timestamptz NOT NULL,
  expiry_date     date,
  qty_received    cl.qty NOT NULL CHECK (qty_received >= 0),
  qty_remaining   cl.qty NOT NULL CHECK (qty_remaining >= 0),
  receipt_line_id bigint REFERENCES cl.purchase_receipt_lines,
  origin          text NOT NULL CHECK (origin IN ('receipt','opening','found','count')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','depleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK ((status = 'depleted') = (qty_remaining = 0)),
  CHECK ((origin = 'receipt') = (receipt_line_id IS NOT NULL))
);
CREATE INDEX lots_fefo_idx ON cl.inventory_lots (item_id, expiry_date NULLS LAST, received_at, id)
  WHERE qty_remaining > 0;
CREATE INDEX lots_item_idx ON cl.inventory_lots (item_id);
CREATE UNIQUE INDEX lots_receipt_line_uq ON cl.inventory_lots (receipt_line_id);

-- Depleted follows the quantity: a lot at zero is depleted, a lot with stock is not.
CREATE FUNCTION cl.lot_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.qty_remaining = 0 THEN
    NEW.status := 'depleted';
  ELSIF NEW.status = 'depleted' THEN
    NEW.status := 'active';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.item_id <> OLD.item_id
     OR NEW.receipt_line_id IS DISTINCT FROM OLD.receipt_line_id OR NEW.origin <> OLD.origin
     OR NEW.received_at <> OLD.received_at) THEN
    RAISE EXCEPTION 'A lot keeps its item and where it came from' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_lots_status BEFORE INSERT OR UPDATE ON cl.inventory_lots
  FOR EACH ROW EXECUTE FUNCTION cl.lot_status();
CREATE TRIGGER inventory_lots_touch BEFORE UPDATE ON cl.inventory_lots FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

CREATE TABLE cl.stock_movement_lots (                          -- (A) a movement's share per lot
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  movement_id bigint NOT NULL REFERENCES cl.stock_movements,
  lot_id      bigint NOT NULL REFERENCES cl.inventory_lots,
  qty_delta   cl.qty NOT NULL CHECK (qty_delta <> 0),         -- signed like the movement
  expired     boolean NOT NULL DEFAULT false,                 -- taken from a lot past its expiry
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (movement_id, lot_id)
);
CREATE INDEX stock_movement_lots_lot_idx ON cl.stock_movement_lots (lot_id);
CREATE TRIGGER stock_movement_lots_append_only BEFORE UPDATE OR DELETE ON cl.stock_movement_lots
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- The lot columns 0008 left without a target.
ALTER TABLE cl.stock_movements ADD FOREIGN KEY (lot_id) REFERENCES cl.inventory_lots;
ALTER TABLE cl.wastage_records ADD FOREIGN KEY (lot_id) REFERENCES cl.inventory_lots;
ALTER TABLE cl.inventory_alerts ADD FOREIGN KEY (lot_id) REFERENCES cl.inventory_lots;
CREATE INDEX movements_lot_idx ON cl.stock_movements (lot_id);
CREATE INDEX wastage_lot_idx ON cl.wastage_records (lot_id);
CREATE INDEX inventory_alerts_lot_idx ON cl.inventory_alerts (lot_id);

-- Stock already on hand for lot-tracked items (P4-3): the newest receipts are assumed to
-- be what is left (older stock was used first), each as its own lot with the lot code and
-- expiry it was received with; anything not covered by receipts becomes one opening lot
-- with an unknown expiry.
WITH tracked AS (
  SELECT i.id, b.on_hand FROM cl.inventory_items i JOIN cl.inventory_balances b ON b.item_id = i.id
   WHERE i.track_lots AND b.on_hand > 0),
received AS (
  SELECT l.id, l.item_id, l.qty_base, l.lot_code, l.expiry_date, r.posted_at,
         sum(l.qty_base) OVER (PARTITION BY l.item_id ORDER BY r.posted_at DESC, l.id DESC) AS upto
    FROM cl.purchase_receipt_lines l JOIN cl.purchase_receipts r ON r.id = l.receipt_id
   WHERE r.status = 'posted' AND l.item_id IN (SELECT id FROM tracked))
INSERT INTO cl.inventory_lots (item_id, lot_code, received_at, expiry_date, qty_received, qty_remaining,
                               receipt_line_id, origin)
SELECT x.item_id, x.lot_code, x.posted_at, x.expiry_date, x.qty_base,
       LEAST(x.qty_base, t.on_hand - (x.upto - x.qty_base)), x.id, 'receipt'
  FROM received x JOIN tracked t ON t.id = x.item_id
 WHERE x.upto - x.qty_base < t.on_hand;

INSERT INTO cl.inventory_lots (item_id, received_at, qty_received, qty_remaining, origin)
SELECT b.item_id, now(), b.on_hand - COALESCE(l.q, 0), b.on_hand - COALESCE(l.q, 0), 'opening'
  FROM cl.inventory_balances b
  JOIN cl.inventory_items i ON i.id = b.item_id AND i.track_lots
  LEFT JOIN (SELECT item_id, sum(qty_remaining) AS q FROM cl.inventory_lots GROUP BY item_id) l
    ON l.item_id = b.item_id
 WHERE b.on_hand - COALESCE(l.q, 0) > 0;

GRANT UPDATE ON cl.inventory_lots TO cl_app;
