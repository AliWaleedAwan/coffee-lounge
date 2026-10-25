-- 0010 Rounds and lines (DATABASE.md §7; Phase 3 step 3.4). Kitchen stations, tickets
-- and templates follow in step 3.5, together with the station FKs.
-- Also adds the order-line FKs that 0008 left out (DATABASE.md §15).

CREATE TABLE cl.order_rounds (                                  -- (M) approval lifecycle only
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                  bigint NOT NULL REFERENCES cl.dining_sessions,
  round_no                    int    NOT NULL CHECK (round_no > 0),       -- within the session
  round_ref                   text   NOT NULL UNIQUE,                     -- 'R-1019-042' (daily counter)
  source                      text   NOT NULL CHECK (source IN ('qr','waiter','reception')),
  status                      text   NOT NULL
                              CHECK (status IN ('pending_approval','accepted','rejected','cancelled','expired')),
  submitted_at                timestamptz NOT NULL DEFAULT now(),
  submitted_by_user_id        bigint REFERENCES cl.users,
  submitted_by_guest_token_id bigint REFERENCES cl.session_guest_tokens,
  quoted_total                cl.amount NOT NULL CHECK (quoted_total >= 0),
  after_bill_request          boolean NOT NULL DEFAULT false,            -- D-12 flag
  escalated_at                timestamptz,                               -- D-36
  decided_at                  timestamptz,
  decided_by                  bigint REFERENCES cl.users,
  decision_reason             text CHECK (char_length(decision_reason) <= 200),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  version                     int NOT NULL DEFAULT 1,
  UNIQUE (session_id, round_no),
  CHECK (num_nonnulls(submitted_by_user_id, submitted_by_guest_token_id) = 1),
  CHECK ((source = 'qr') = (submitted_by_guest_token_id IS NOT NULL)),
  CHECK (status NOT IN ('accepted','rejected') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
CREATE INDEX rounds_pending_idx ON cl.order_rounds (submitted_at) WHERE status = 'pending_approval';
CREATE INDEX rounds_session_idx ON cl.order_rounds (session_id);
CREATE INDEX rounds_user_idx ON cl.order_rounds (submitted_by_user_id);
CREATE INDEX rounds_guest_idx ON cl.order_rounds (submitted_by_guest_token_id);
CREATE INDEX rounds_decided_by_idx ON cl.order_rounds (decided_by);

-- Only a pending round can be decided, once (exactly one R3/R4/R5/R6 succeeds).
CREATE FUNCTION cl.round_decided_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_id <> OLD.session_id OR NEW.round_no <> OLD.round_no OR NEW.round_ref <> OLD.round_ref
     OR NEW.source <> OLD.source OR NEW.submitted_at <> OLD.submitted_at OR NEW.quoted_total <> OLD.quoted_total
     OR (OLD.status <> 'pending_approval' AND NEW.status <> OLD.status)
     OR (OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS DISTINCT FROM OLD.escalated_at) THEN
    RAISE EXCEPTION 'round % (%) cannot change that', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_rounds_decided_once BEFORE UPDATE ON cl.order_rounds
  FOR EACH ROW EXECUTE FUNCTION cl.round_decided_once();

CREATE TABLE cl.order_lines (                                   -- (M) prices frozen once the round is accepted
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id                 bigint NOT NULL REFERENCES cl.order_rounds,
  session_id               bigint NOT NULL REFERENCES cl.dining_sessions,
  line_no                  int    NOT NULL CHECK (line_no > 0),
  variant_id               bigint NOT NULL REFERENCES cl.menu_variants,
  item_name_snap           text   NOT NULL,
  variant_name_snap        text   NOT NULL,
  qty                      int    NOT NULL CHECK (qty > 0),
  notes                    text   CHECK (char_length(notes) <= 120),
  unit_price_quoted        cl.amount NOT NULL CHECK (unit_price_quoted >= 0),  -- what was shown at submission
  catalog_unit_price       cl.amount,                            -- catalog price at acceptance
  unit_price               cl.amount,                            -- charged; = quoted if the price lock applied (D-08)
  price_locked             boolean NOT NULL DEFAULT false,
  modifiers_unit_total     cl.amount NOT NULL DEFAULT 0 CHECK (modifiers_unit_total >= 0),
  promotion_id             bigint REFERENCES cl.promotions,
  promotion_discount       cl.amount NOT NULL DEFAULT 0 CHECK (promotion_discount >= 0),
  line_gross               cl.amount,                            -- (unit_price + modifiers_unit_total) × qty
  stock_mode_snap          text CHECK (stock_mode_snap IN ('untracked','recipe')),
  recipe_version_id        bigint REFERENCES cl.recipe_versions,
  station_id               bigint,                               -- FK added with cl.stations (step 3.5)
  qty_picked_up            int NOT NULL DEFAULT 0,               -- = prepared = consumption (D-33)
  qty_served               int NOT NULL DEFAULT 0,
  qty_cancelled_unprepared int NOT NULL DEFAULT 0,
  qty_cancelled_prepared   int NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  int NOT NULL DEFAULT 1,
  UNIQUE (round_id, line_no),
  CHECK (qty_picked_up >= 0 AND qty_served >= 0 AND qty_cancelled_unprepared >= 0 AND qty_cancelled_prepared >= 0),
  CHECK (qty_picked_up + qty_cancelled_unprepared <= qty),
  CHECK (qty_served <= qty_picked_up),
  CHECK (qty_cancelled_prepared <= qty_picked_up),
  CHECK (unit_price IS NULL OR line_gross = (unit_price + modifiers_unit_total) * qty),
  CHECK (promotion_discount = 0 OR promotion_id IS NOT NULL),
  CHECK (line_gross IS NULL OR promotion_discount <= line_gross),
  CHECK (stock_mode_snap IS DISTINCT FROM 'recipe' OR recipe_version_id IS NOT NULL),
  CHECK ((unit_price IS NULL) = (stock_mode_snap IS NULL))       -- both are set at acceptance
);
CREATE INDEX order_lines_session_idx ON cl.order_lines (session_id);
CREATE INDEX order_lines_round_idx ON cl.order_lines (round_id);
CREATE INDEX order_lines_variant_idx ON cl.order_lines (variant_id);
CREATE INDEX order_lines_promotion_idx ON cl.order_lines (promotion_id);
CREATE INDEX order_lines_recipe_idx ON cl.order_lines (recipe_version_id);
CREATE INDEX order_lines_station_idx ON cl.order_lines (station_id);
CREATE INDEX order_lines_open_idx ON cl.order_lines (round_id)
  WHERE qty_picked_up + qty_cancelled_unprepared < qty;            -- uncollected items (D-33 alert)

-- What was ordered never changes; prices are set once, at acceptance; counters only grow.
CREATE FUNCTION cl.order_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.round_id <> OLD.round_id OR NEW.session_id <> OLD.session_id OR NEW.line_no <> OLD.line_no
     OR NEW.variant_id <> OLD.variant_id OR NEW.item_name_snap <> OLD.item_name_snap
     OR NEW.variant_name_snap <> OLD.variant_name_snap OR NEW.qty <> OLD.qty
     OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.unit_price_quoted <> OLD.unit_price_quoted
     OR NEW.modifiers_unit_total <> OLD.modifiers_unit_total
     OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id
     OR NEW.qty_picked_up < OLD.qty_picked_up OR NEW.qty_served < OLD.qty_served
     OR NEW.qty_cancelled_unprepared < OLD.qty_cancelled_unprepared
     OR NEW.qty_cancelled_prepared < OLD.qty_cancelled_prepared THEN
    RAISE EXCEPTION 'order line % cannot change that', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.unit_price IS NOT NULL AND (
       NEW.unit_price IS DISTINCT FROM OLD.unit_price OR NEW.catalog_unit_price IS DISTINCT FROM OLD.catalog_unit_price
       OR NEW.price_locked <> OLD.price_locked OR NEW.line_gross IS DISTINCT FROM OLD.line_gross
       OR NEW.promotion_discount <> OLD.promotion_discount
       OR NEW.stock_mode_snap IS DISTINCT FROM OLD.stock_mode_snap
       OR NEW.recipe_version_id IS DISTINCT FROM OLD.recipe_version_id) THEN
    RAISE EXCEPTION 'order line % prices are frozen once accepted', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_lines_guard BEFORE UPDATE ON cl.order_lines
  FOR EACH ROW EXECUTE FUNCTION cl.order_line_guard();

CREATE TABLE cl.order_line_modifiers (                          -- written with the line, never changed
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id            bigint    NOT NULL REFERENCES cl.order_lines,
  modifier_option_id bigint    NOT NULL REFERENCES cl.modifier_options,
  name_snap          text      NOT NULL,
  price_delta_snap   cl.amount NOT NULL CHECK (price_delta_snap >= 0),
  qty                int       NOT NULL DEFAULT 1 CHECK (qty > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_id, modifier_option_id)
);
CREATE INDEX order_line_modifiers_option_idx ON cl.order_line_modifiers (modifier_option_id);

CREATE TABLE cl.order_line_components (                         -- (A) frozen recipe explosion at acceptance
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id           bigint NOT NULL REFERENCES cl.order_lines,
  inventory_item_id bigint NOT NULL REFERENCES cl.inventory_items,
  qty_per_unit      cl.qty NOT NULL CHECK (qty_per_unit > 0),  -- includes waste factor and modifier rules
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_id, inventory_item_id)
);
CREATE INDEX order_line_components_item_idx ON cl.order_line_components (inventory_item_id);

CREATE TABLE cl.order_events (                                  -- (A) idempotency anchor for every transition
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id       bigint NOT NULL REFERENCES cl.order_rounds,
  line_id        bigint REFERENCES cl.order_lines,
  event_type     text   NOT NULL,                              -- ORDER_STATE_MACHINE.md §8
  qty            int    CHECK (qty > 0),
  actor_kind     text   NOT NULL CHECK (actor_kind IN ('user','guest','system')),
  actor_user_id  bigint REFERENCES cl.users,
  reason         text,
  data           jsonb,
  event_key      text   NOT NULL UNIQUE,
  correlation_id uuid   NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);
CREATE INDEX order_events_round_idx ON cl.order_events (round_id, occurred_at);
CREATE INDEX order_events_line_idx ON cl.order_events (line_id);
CREATE INDEX order_events_actor_idx ON cl.order_events (actor_user_id);

CREATE TRIGGER order_rounds_touch BEFORE UPDATE ON cl.order_rounds FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER order_lines_touch BEFORE UPDATE ON cl.order_lines FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER order_line_modifiers_append_only BEFORE UPDATE OR DELETE ON cl.order_line_modifiers
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER order_line_components_append_only BEFORE UPDATE OR DELETE ON cl.order_line_components
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON cl.order_events
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

GRANT UPDATE ON cl.order_rounds, cl.order_lines TO cl_app;

-- The FKs 0008 could not have yet.
ALTER TABLE cl.stock_reservations ADD CONSTRAINT stock_reservations_order_line_fk
  FOREIGN KEY (order_line_id) REFERENCES cl.order_lines;
ALTER TABLE cl.order_line_costs ADD CONSTRAINT order_line_costs_order_line_fk
  FOREIGN KEY (order_line_id) REFERENCES cl.order_lines;
ALTER TABLE cl.wastage_records ADD CONSTRAINT wastage_records_order_line_fk
  FOREIGN KEY (order_line_id) REFERENCES cl.order_lines;
