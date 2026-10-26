-- 0021 Stock counts (DATABASE.md §8; RECIPE_INVENTORY.md §9; D-18; P4-5; Phase 4 step
-- 4.5). A count covers a scope (everything, a category or a list), is blind by default,
-- snapshots the book quantity of each line when it is entered, and posts each line's
-- variance as a delta, so sales during the count are kept. Variances over the D-18
-- thresholds need approval by someone other than the submitter.

CREATE TABLE cl.stock_counts (                                 -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_no        text NOT NULL UNIQUE CHECK (count_no ~ '^CNT-\d{4}-\d{5,}$'),
  kind            text NOT NULL DEFAULT 'periodic' CHECK (kind IN ('opening','periodic','spot')),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','posted','cancelled')),
  blind           boolean NOT NULL DEFAULT true,
  scope_kind      text NOT NULL CHECK (scope_kind IN ('all','category','items')),
  scope_category  text,
  scope_item_ids  bigint[],
  note            text CHECK (length(note) <= 200),
  started_by      bigint NOT NULL REFERENCES cl.users,
  started_at      timestamptz NOT NULL DEFAULT now(),
  submitted_by    bigint REFERENCES cl.users,
  submitted_at    timestamptz,
  approved_by     bigint REFERENCES cl.users,
  posted_at       timestamptz,
  business_date   date,
  sent_back_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK ((scope_kind = 'category') = (scope_category IS NOT NULL)),
  CHECK ((scope_kind = 'items') = (scope_item_ids IS NOT NULL AND cardinality(scope_item_ids) > 0)),
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),  -- D-18 segregation
  CHECK ((status IN ('submitted','posted')) = (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_at IS NOT NULL AND business_date IS NOT NULL))
);
CREATE INDEX stock_counts_started_by_idx ON cl.stock_counts (started_by);
CREATE INDEX stock_counts_submitted_by_idx ON cl.stock_counts (submitted_by);
CREATE INDEX stock_counts_approved_by_idx ON cl.stock_counts (approved_by);
CREATE INDEX stock_counts_status_idx ON cl.stock_counts (status);

-- draft ⇄ submitted (sent back for recount) → posted; draft → cancelled. Posted and
-- cancelled are final.
CREATE FUNCTION cl.stock_count_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted','cancelled')
     OR (OLD.status = 'draft' AND NEW.status NOT IN ('draft','submitted','posted','cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status NOT IN ('submitted','draft','posted')) THEN
    RAISE EXCEPTION 'stock count % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.count_no <> OLD.count_no OR NEW.scope_kind <> OLD.scope_kind
     OR NEW.started_by <> OLD.started_by OR NEW.blind <> OLD.blind THEN
    RAISE EXCEPTION 'A count keeps its number, scope and starter' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_counts_guard BEFORE UPDATE ON cl.stock_counts
  FOR EACH ROW EXECUTE FUNCTION cl.stock_count_guard();
CREATE TRIGGER stock_counts_touch BEFORE UPDATE ON cl.stock_counts FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

CREATE TABLE cl.stock_count_lines (                            -- (D) while the count is a draft
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id       bigint NOT NULL REFERENCES cl.stock_counts,
  item_id        bigint NOT NULL REFERENCES cl.inventory_items,
  lot_id         bigint REFERENCES cl.inventory_lots,         -- NULL: the item, or for a lot-tracked item stock in no known lot
  book_qty_snap  cl.qty NOT NULL CHECK (book_qty_snap >= 0),
  counted_qty    cl.qty NOT NULL CHECK (counted_qty >= 0),
  unit_cost_snap cl.unit_cost,
  variance_qty   cl.qty NOT NULL,
  variance_value cl.stock_value NOT NULL,
  needs_approval boolean NOT NULL DEFAULT false,
  new_lot_expiry date,                                         -- stock found in no known lot
  entered_by     bigint NOT NULL REFERENCES cl.users,
  entered_at     timestamptz NOT NULL DEFAULT now(),
  posted_qty     cl.qty,                                       -- the delta actually posted
  movement_id    bigint REFERENCES cl.stock_movements,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (variance_qty = counted_qty - book_qty_snap),
  CHECK (new_lot_expiry IS NULL OR lot_id IS NULL)
);
CREATE UNIQUE INDEX stock_count_lines_uq ON cl.stock_count_lines (count_id, item_id, lot_id) NULLS NOT DISTINCT;
CREATE INDEX stock_count_lines_item_idx ON cl.stock_count_lines (item_id);
CREATE INDEX stock_count_lines_lot_idx ON cl.stock_count_lines (lot_id);
CREATE INDEX stock_count_lines_entered_by_idx ON cl.stock_count_lines (entered_by);
CREATE INDEX stock_count_lines_movement_idx ON cl.stock_count_lines (movement_id);

-- Lines change while the count is a draft; when it posts only the result is written.
CREATE FUNCTION cl.stock_count_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM cl.stock_counts
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.count_id ELSE NEW.count_id END;
  IF parent_status = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF parent_status = 'submitted' AND TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'posted_qty' - 'movement_id') = (to_jsonb(OLD) - 'posted_qty' - 'movement_id') THEN
    RETURN NEW;
  END IF;
  IF parent_status = 'submitted' AND TG_OP = 'DELETE' THEN
    RETURN OLD;  -- sent back for recount
  END IF;
  RAISE EXCEPTION 'count lines change only while the count is a draft' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER stock_count_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON cl.stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION cl.stock_count_lines_guard();

GRANT UPDATE ON cl.stock_counts TO cl_app;
GRANT UPDATE, DELETE ON cl.stock_count_lines TO cl_app;
