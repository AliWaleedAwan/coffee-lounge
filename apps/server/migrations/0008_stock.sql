-- 0008 Minimal ingredient model (DATABASE.md §5, §8; Phase 3 step 3.2).
-- Only what acceptance and pickup need: units, ingredients with balances, recipes and
-- modifier rules, reservations, the stock ledger, line costs, ingredient waste, alerts.
-- Purchasing, lots, pack sizes, barcodes and counts arrive in Phase 4.
-- Deviations recorded in DATABASE.md §15: order_line_id columns get their FK with
-- cl.order_lines (step 3.4) and lot_id columns with cl.inventory_lots (Phase 4);
-- inventory_alerts has the extra kind 'found_stock' (COST_VALUATION.md §5's owner alert).

CREATE TABLE cl.uoms (
  code           text PRIMARY KEY,                             -- g, kg, ml, l, pcs
  dimension      text NOT NULL CHECK (dimension IN ('mass','volume','count')),
  base_code      text NOT NULL REFERENCES cl.uoms,
  factor_to_base numeric(18,6) NOT NULL CHECK (factor_to_base > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uoms_base_code_idx ON cl.uoms (base_code);
INSERT INTO cl.uoms (code, dimension, base_code, factor_to_base) VALUES
  ('g',   'mass',   'g',   1),
  ('ml',  'volume', 'ml',  1),
  ('pcs', 'count',  'pcs', 1);
INSERT INTO cl.uoms (code, dimension, base_code, factor_to_base) VALUES
  ('kg', 'mass',   'g',  1000),
  ('l',  'volume', 'ml', 1000);

CREATE TABLE cl.inventory_items (                               -- (M)
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku                  text NOT NULL UNIQUE,
  name                 text NOT NULL,
  category             text,
  base_uom             text NOT NULL REFERENCES cl.uoms CHECK (base_uom IN ('g','ml','pcs')),
  track_lots           boolean NOT NULL DEFAULT false,
  track_expiry         boolean NOT NULL DEFAULT false,
  low_threshold        cl.qty CHECK (low_threshold >= 0),
  overstock_threshold  cl.qty CHECK (overstock_threshold >= 0),
  near_expiry_days     int    CHECK (near_expiry_days >= 0),
  stock_control_active boolean NOT NULL DEFAULT false,         -- D-29: switched on by its opening balance
  is_active            boolean NOT NULL DEFAULT true,
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  CHECK (NOT track_expiry OR track_lots)
);
CREATE INDEX inventory_items_base_uom_idx ON cl.inventory_items (base_uom);
CREATE INDEX inventory_items_name_trgm ON cl.inventory_items USING gin (name gin_trgm_ops);

-- Projection kept in the same transaction as every movement and reservation. The row
-- lock on this table serialises all stock operations per item (lock order: ascending item_id).
CREATE TABLE cl.inventory_balances (                            -- (M)
  item_id         bigint PRIMARY KEY REFERENCES cl.inventory_items,
  on_hand         cl.qty         NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved        cl.qty         NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  inventory_value cl.stock_value NOT NULL DEFAULT 0 CHECK (inventory_value >= 0),
  avg_unit_cost   cl.unit_cost GENERATED ALWAYS AS
                  (CASE WHEN on_hand > 0 THEN round(inventory_value / on_hand, 8) END) STORED,
  last_unit_cost  cl.unit_cost,                                -- kept when on_hand = 0 (COST_VALUATION.md §5)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK (on_hand > 0 OR inventory_value = 0)                   -- the drain rule (COST_VALUATION.md §4)
);

-- Every item has exactly one balance row, from the moment it exists.
CREATE FUNCTION cl.create_inventory_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cl.inventory_balances (item_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_items_balance AFTER INSERT ON cl.inventory_items
  FOR EACH ROW EXECUTE FUNCTION cl.create_inventory_balance();

CREATE TABLE cl.recipe_versions (                               -- (M) components frozen once active
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id        bigint NOT NULL REFERENCES cl.menu_variants,
  version_no        int    NOT NULL CHECK (version_no > 0),
  status            text   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  prep_instructions text,
  activated_by      bigint REFERENCES cl.users,
  activated_at      timestamptz,
  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1,
  UNIQUE (variant_id, version_no),
  CHECK (status = 'draft' OR activated_at IS NOT NULL),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX recipe_one_active ON cl.recipe_versions (variant_id) WHERE status = 'active';
CREATE INDEX recipe_versions_activated_by_idx ON cl.recipe_versions (activated_by);

-- A version only moves forward (draft → active → retired) and never changes owner.
CREATE FUNCTION cl.recipe_version_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.variant_id <> OLD.variant_id OR NEW.version_no <> OLD.version_no THEN
    RAISE EXCEPTION 'recipe version % cannot move to another variant or number', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.status = 'active' AND NEW.status = 'draft') OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
    RAISE EXCEPTION 'recipe version % cannot go from % back to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipe_versions_forward_only BEFORE UPDATE ON cl.recipe_versions
  FOR EACH ROW EXECUTE FUNCTION cl.recipe_version_forward_only();

CREATE TABLE cl.recipe_components (                             -- (D) editable only while the version is draft
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_version_id bigint NOT NULL REFERENCES cl.recipe_versions,
  inventory_item_id bigint NOT NULL REFERENCES cl.inventory_items,
  qty_base          cl.qty NOT NULL CHECK (qty_base > 0),
  waste_factor      numeric(6,4) NOT NULL DEFAULT 0 CHECK (waste_factor >= 0 AND waste_factor < 1),
  for_dine_in       boolean NOT NULL DEFAULT true,
  for_takeaway      boolean NOT NULL DEFAULT true,             -- e.g. cup + lid: takeaway/delivery only
  for_delivery      boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (for_dine_in OR for_takeaway OR for_delivery)
);
CREATE INDEX recipe_components_version_idx ON cl.recipe_components (recipe_version_id);
CREATE INDEX recipe_components_item_idx ON cl.recipe_components (inventory_item_id);

CREATE FUNCTION cl.recipe_components_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM cl.recipe_versions
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.recipe_version_id ELSE NEW.recipe_version_id END;
  IF parent_status <> 'draft'
     OR (TG_OP = 'UPDATE' AND OLD.recipe_version_id <> NEW.recipe_version_id) THEN
    RAISE EXCEPTION 'recipe components can change only while their version is a draft'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO parent_status FROM cl.recipe_versions WHERE id = OLD.recipe_version_id;
    IF parent_status <> 'draft' THEN
      RAISE EXCEPTION 'recipe components can change only while their version is a draft'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER recipe_components_frozen BEFORE INSERT OR UPDATE OR DELETE ON cl.recipe_components
  FOR EACH ROW EXECUTE FUNCTION cl.recipe_components_draft_only();

CREATE TABLE cl.modifier_recipe_rules (                         -- (M) effective-dated; accepted lines snapshot results
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  modifier_option_id  bigint NOT NULL REFERENCES cl.modifier_options,
  variant_id          bigint REFERENCES cl.menu_variants,      -- NULL = every variant of the item
  action              text   NOT NULL CHECK (action IN ('add','remove','replace','scale')),
  inventory_item_id   bigint NOT NULL REFERENCES cl.inventory_items,
  replacement_item_id bigint REFERENCES cl.inventory_items,
  qty_base            cl.qty,
  scale_factor        numeric(8,4),
  effective_from      timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1,
  CHECK (action <> 'add'     OR (qty_base > 0 AND replacement_item_id IS NULL)),
  CHECK (action <> 'replace' OR (replacement_item_id IS NOT NULL AND replacement_item_id <> inventory_item_id)),
  CHECK (action <> 'scale'   OR scale_factor > 0),
  CHECK (retired_at IS NULL OR retired_at > effective_from)
);
CREATE INDEX modifier_recipe_rules_option_idx ON cl.modifier_recipe_rules (modifier_option_id);
CREATE INDEX modifier_recipe_rules_variant_idx ON cl.modifier_recipe_rules (variant_id);
CREATE INDEX modifier_recipe_rules_item_idx ON cl.modifier_recipe_rules (inventory_item_id);
CREATE INDEX modifier_recipe_rules_replacement_idx ON cl.modifier_recipe_rules (replacement_item_id);

CREATE TABLE cl.stock_reservations (                            -- (M) counters only move forward
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id bigint NOT NULL,                               -- FK added with cl.order_lines (step 3.4)
  item_id       bigint NOT NULL REFERENCES cl.inventory_items,
  qty_reserved  cl.qty NOT NULL CHECK (qty_reserved > 0),
  qty_consumed  cl.qty NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  qty_released  cl.qty NOT NULL DEFAULT 0 CHECK (qty_released >= 0),
  status        text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  UNIQUE (order_line_id, item_id),
  CHECK (qty_consumed + qty_released <= qty_reserved),
  CHECK ((status = 'closed') = (qty_consumed + qty_released = qty_reserved))
);
CREATE INDEX reservations_active_idx ON cl.stock_reservations (item_id) WHERE status = 'active';
CREATE INDEX reservations_item_idx ON cl.stock_reservations (item_id);

CREATE FUNCTION cl.reservation_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_line_id <> OLD.order_line_id OR NEW.item_id <> OLD.item_id
     OR NEW.qty_reserved <> OLD.qty_reserved
     OR NEW.qty_consumed < OLD.qty_consumed OR NEW.qty_released < OLD.qty_released
     OR (OLD.status = 'closed' AND NEW.status <> 'closed') THEN
    RAISE EXCEPTION 'reservation % counters only move forward', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_reservations_forward_only BEFORE UPDATE ON cl.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION cl.reservation_forward_only();

CREATE TABLE cl.stock_movements (                               -- (A) the stock ledger
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id              bigint NOT NULL REFERENCES cl.inventory_items,
  lot_id               bigint,                                 -- FK added with cl.inventory_lots (Phase 4)
  movement_type        text   NOT NULL CHECK (movement_type IN (
                         'opening','receipt','consumption','waste','count_adjustment',
                         'supplier_return','cost_adjustment','rounding','reversal')),
  qty_delta            cl.qty NOT NULL,                        -- signed, base unit
  unit_cost            cl.unit_cost,                           -- receipt: purchase cost; issues: average at posting
  value_delta          cl.stock_value NOT NULL,                -- signed
  source_type          text   NOT NULL,
  source_id            bigint NOT NULL,
  source_key           text   NOT NULL UNIQUE,                 -- e.g. 'consume:evt:<key>:item:44:lot:0'
  reason_code          text,
  flags                text[] NOT NULL DEFAULT '{}',           -- 'expired_lot_used', 'manual_back_entry', 'auto_found_stock'
  reverses_movement_id bigint REFERENCES cl.stock_movements,
  actor_user_id        bigint REFERENCES cl.users,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  business_date        date   NOT NULL,
  note                 text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_delta <> 0 OR movement_type IN ('cost_adjustment','rounding')),
  CHECK (movement_type <> 'reversal' OR reverses_movement_id IS NOT NULL),
  CHECK (sign(value_delta) * sign(qty_delta) >= 0)             -- value never moves against quantity
);
CREATE INDEX movements_item_time_idx ON cl.stock_movements (item_id, occurred_at);
CREATE INDEX movements_source_idx    ON cl.stock_movements (source_type, source_id);
CREATE INDEX movements_bdate_idx     ON cl.stock_movements (business_date);
CREATE INDEX movements_reverses_idx  ON cl.stock_movements (reverses_movement_id);
CREATE INDEX movements_actor_idx     ON cl.stock_movements (actor_user_id);

CREATE TABLE cl.order_line_costs (                              -- (A) frozen actual COGS (WAC at consumption)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id bigint NOT NULL,                               -- FK added with cl.order_lines (step 3.4)
  item_id       bigint NOT NULL REFERENCES cl.inventory_items,
  movement_id   bigint NOT NULL UNIQUE REFERENCES cl.stock_movements,
  qty_base      cl.qty NOT NULL CHECK (qty_base > 0),
  value         cl.stock_value NOT NULL CHECK (value >= 0),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX line_costs_line_idx ON cl.order_line_costs (order_line_id);
CREATE INDEX line_costs_item_idx ON cl.order_line_costs (item_id);

CREATE TABLE cl.wastage_records (                               -- (A)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('ingredient','prepared_item','expired_lot','failed_delivery')),
  item_id       bigint REFERENCES cl.inventory_items,
  lot_id        bigint,                                        -- FK added with cl.inventory_lots (Phase 4)
  order_line_id bigint,                                        -- FK added with cl.order_lines (step 3.4)
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),        -- base units, or sellable units for prepared items
  reason_code   text NOT NULL,
  cost_value    cl.stock_value NOT NULL CHECK (cost_value >= 0),
  movement_id   bigint REFERENCES cl.stock_movements,          -- set for ingredient/expired_lot
  recorded_by   bigint NOT NULL REFERENCES cl.users,
  business_date date NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('prepared_item','failed_delivery')) = (order_line_id IS NOT NULL)),
  CHECK ((kind IN ('ingredient','expired_lot')) = (movement_id IS NOT NULL)),
  CHECK (reason_code <> 'other' OR (note IS NOT NULL AND length(trim(note)) > 0))
);
CREATE INDEX wastage_item_idx      ON cl.wastage_records (item_id);
CREATE INDEX wastage_line_idx      ON cl.wastage_records (order_line_id);
CREATE INDEX wastage_movement_idx  ON cl.wastage_records (movement_id);
CREATE INDEX wastage_recorded_idx  ON cl.wastage_records (recorded_by);
CREATE INDEX wastage_bdate_idx     ON cl.wastage_records (business_date);

CREATE TABLE cl.inventory_alerts (                              -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     bigint REFERENCES cl.inventory_items,
  lot_id      bigint,                                          -- FK added with cl.inventory_lots (Phase 4)
  kind        text NOT NULL CHECK (kind IN ('low','zero','near_expiry','expired','overstock',
                                            'reservation_shortfall','stale_reservation',
                                            'balance_mismatch','found_stock')),
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  detail      jsonb,
  resolved_at timestamptz,
  resolved_by bigint REFERENCES cl.users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX alerts_one_open ON cl.inventory_alerts (kind, item_id, lot_id) NULLS NOT DISTINCT
  WHERE state <> 'resolved';
CREATE INDEX inventory_alerts_item_idx ON cl.inventory_alerts (item_id);
CREATE INDEX inventory_alerts_resolved_by_idx ON cl.inventory_alerts (resolved_by);

-- Version bumps on every update; the ledger, line costs and waste are append-only.
CREATE TRIGGER inventory_items_touch BEFORE UPDATE ON cl.inventory_items FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER inventory_balances_touch BEFORE UPDATE ON cl.inventory_balances FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER recipe_versions_touch BEFORE UPDATE ON cl.recipe_versions FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER modifier_recipe_rules_touch BEFORE UPDATE ON cl.modifier_recipe_rules FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER stock_reservations_touch BEFORE UPDATE ON cl.stock_reservations FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER inventory_alerts_touch BEFORE UPDATE ON cl.inventory_alerts FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON cl.stock_movements
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER order_line_costs_append_only BEFORE UPDATE OR DELETE ON cl.order_line_costs
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER wastage_records_append_only BEFORE UPDATE OR DELETE ON cl.wastage_records
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- Default privileges give cl_app SELECT/INSERT; mutable tables also need UPDATE.
GRANT UPDATE ON cl.inventory_items, cl.inventory_balances, cl.recipe_versions, cl.recipe_components,
                cl.modifier_recipe_rules, cl.stock_reservations, cl.inventory_alerts
  TO cl_app;
GRANT DELETE ON cl.recipe_components TO cl_app;
