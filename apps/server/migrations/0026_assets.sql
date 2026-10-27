-- 0026 Asset register (DATABASE.md §10; D-31 "Resources Management"; Phase 5 step 5.4).
-- The espresso machine, grinders, fridges, furniture, POS hardware: what the shop owns,
-- where it is, its condition, who looks after it. The row is the asset as it is now; every
-- change is also an event in its history (AT-106), so the original stays traceable (AT-23).
-- Disposal is a status, never a delete. No depreciation (D-19).

CREATE TABLE cl.assets (                                        -- (M) current state; history in asset_events
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_tag           text NOT NULL CHECK (asset_tag ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,29}$'),  -- typed, or AST-0001 (P5-4)
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  category            text NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 40),
  quantity            int  NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 9999),
  purchase_date       date,
  purchase_price      cl.amount CHECK (purchase_price >= 0),
  supplier_id         bigint REFERENCES cl.suppliers,
  location            text CHECK (length(btrim(location)) BETWEEN 1 AND 60),
  condition           text CHECK (condition IN ('new','good','fair','poor')),
  responsible_user_id bigint REFERENCES cl.users,
  status              text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use','in_repair','retired','disposed')),
  notes               text CHECK (length(notes) <= 500),
  created_by          bigint NOT NULL REFERENCES cl.users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX assets_tag_key ON cl.assets (upper(asset_tag));
CREATE INDEX assets_supplier_idx    ON cl.assets (supplier_id);
CREATE INDEX assets_responsible_idx ON cl.assets (responsible_user_id);
CREATE INDEX assets_created_by_idx  ON cl.assets (created_by);
GRANT UPDATE ON cl.assets TO cl_app;

-- Never deleted; a disposed asset never changes again.
CREATE FUNCTION cl.asset_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An asset is never deleted; dispose of it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'disposed' THEN
    RAISE EXCEPTION 'A disposed asset never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Who registered an asset and when never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_guard BEFORE UPDATE OR DELETE ON cl.assets
  FOR EACH ROW EXECUTE FUNCTION cl.asset_guard();

CREATE TABLE cl.asset_events (                                  -- (A)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id   bigint NOT NULL REFERENCES cl.assets,
  event_type text   NOT NULL CHECK (event_type IN ('acquired','moved','condition_changed','maintenance',
                                                   'value_corrected','status_changed','details_changed',
                                                   'disposed')),
  data       jsonb  NOT NULL,                                   -- {before, after} or the record
  actor      bigint NOT NULL REFERENCES cl.users,
  reason     text   CHECK (length(reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type NOT IN ('value_corrected','disposed') OR length(btrim(reason)) >= 3)
);
CREATE INDEX asset_events_asset_idx ON cl.asset_events (asset_id, id);
CREATE INDEX asset_events_actor_idx ON cl.asset_events (actor);
CREATE TRIGGER asset_events_append_only BEFORE UPDATE OR DELETE ON cl.asset_events
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

CREATE TABLE cl.asset_maintenance (                             -- (A) a correction is a new record
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id     bigint NOT NULL REFERENCES cl.assets,
  performed_on date   NOT NULL,
  vendor       text   CHECK (length(btrim(vendor)) BETWEEN 1 AND 80),
  cost         cl.amount CHECK (cost >= 0),
  description  text   NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 300),
  next_due     date,
  expense_id   bigint UNIQUE REFERENCES cl.expenses,             -- what was paid for it (step 5.3), at most once
  created_by   bigint NOT NULL REFERENCES cl.users,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (next_due IS NULL OR next_due > performed_on)
);
CREATE INDEX asset_maintenance_asset_idx      ON cl.asset_maintenance (asset_id, performed_on);
CREATE INDEX asset_maintenance_created_by_idx ON cl.asset_maintenance (created_by);
CREATE INDEX asset_maintenance_next_due_idx   ON cl.asset_maintenance (next_due);
CREATE TRIGGER asset_maintenance_append_only BEFORE UPDATE OR DELETE ON cl.asset_maintenance
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
