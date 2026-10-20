-- 0009 Tables, QR entry points, assignments, sessions and guest tokens
-- (DATABASE.md §6; Phase 3 step 3.3). Delivery orders and riders follow in step 3.10.
-- Deviations recorded in DATABASE.md §15: `signing_keys` (key for the signed entry
-- cookie, API.md §4) and `operational_alerts` (stale sessions now, uncollected items in
-- step 3.5), neither of which §6 gave a home.

CREATE TABLE cl.dining_tables (                                 -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9-]{1,12}$'),  -- 'T05'
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  area         text,
  seats        int  CHECK (seats > 0),
  layout_x     int,
  layout_y     int,
  availability text NOT NULL DEFAULT 'active' CHECK (availability IN ('active','blocked','maintenance')),
  sort         int  NOT NULL DEFAULT 0,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);

CREATE TABLE cl.qr_entry_points (                               -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text  NOT NULL CHECK (kind IN ('table','counter_takeaway')),
  table_id   bigint REFERENCES cl.dining_tables,
  label      text  NOT NULL,
  token_hash bytea NOT NULL UNIQUE,                             -- SHA-256 of the printed 128-bit token
  is_active  boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  CHECK ((kind = 'table') = (table_id IS NOT NULL)),
  CHECK (is_active = (revoked_at IS NULL))
);
CREATE UNIQUE INDEX qr_one_active_per_table ON cl.qr_entry_points (table_id) WHERE is_active AND kind = 'table';
CREATE INDEX qr_entry_points_table_idx ON cl.qr_entry_points (table_id);

CREATE TABLE cl.table_assignments (                             -- D-07
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id    bigint NOT NULL REFERENCES cl.dining_tables,
  user_id     bigint NOT NULL REFERENCES cl.users,
  assigned_by bigint NOT NULL REFERENCES cl.users,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  ended_by    bigint REFERENCES cl.users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at),
  CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
CREATE UNIQUE INDEX table_one_current_waiter ON cl.table_assignments (table_id) WHERE ended_at IS NULL;
CREATE INDEX table_assignments_user_idx ON cl.table_assignments (user_id) WHERE ended_at IS NULL;
CREATE INDEX table_assignments_user_all_idx ON cl.table_assignments (user_id);
CREATE INDEX table_assignments_assigned_by_idx ON cl.table_assignments (assigned_by);
CREATE INDEX table_assignments_ended_by_idx ON cl.table_assignments (ended_by);

-- Only ended_at/ended_by may change, once; rows are never deleted.
CREATE FUNCTION cl.assignment_end_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.table_id <> OLD.table_id OR NEW.user_id <> OLD.user_id OR NEW.assigned_by <> OLD.assigned_by
     OR NEW.assigned_at <> OLD.assigned_at OR NEW.created_at <> OLD.created_at
     OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'table assignment % can only be ended, once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER table_assignments_end_only BEFORE UPDATE ON cl.table_assignments
  FOR EACH ROW EXECUTE FUNCTION cl.assignment_end_only();

CREATE TABLE cl.dining_sessions (                               -- (M) one per visit/order, all order types
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_no            text NOT NULL UNIQUE,                  -- 'S-20261019-0031'
  order_type            text NOT NULL CHECK (order_type IN ('dine_in','takeaway','delivery')),
  table_id              bigint REFERENCES cl.dining_tables,
  entry_point_id        bigint REFERENCES cl.qr_entry_points,
  status                text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','checkout_requested','checkout_locked','settled','cancelled')),
  guest_count           int CHECK (guest_count > 0),
  customer_name         text,                                  -- all optional (D-05)
  customer_phone        text,
  customer_email        text,
  opened_via            text NOT NULL CHECK (opened_via IN ('qr','staff')),
  opened_by_user_id     bigint REFERENCES cl.users,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  checkout_requested_at timestamptz,
  locked_at             timestamptz,
  closed_at             timestamptz,
  close_reason          text,
  business_date         date NOT NULL,                         -- business date of opening
  pii_redacted_at       timestamptz,                           -- D-25
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 1,
  CHECK ((order_type = 'dine_in') = (table_id IS NOT NULL)),
  CHECK ((status IN ('settled','cancelled')) = (closed_at IS NOT NULL)),
  CHECK ((opened_via = 'staff') = (opened_by_user_id IS NOT NULL)),
  CHECK ((opened_via = 'qr') = (entry_point_id IS NOT NULL))
);
CREATE UNIQUE INDEX session_one_active_per_table ON cl.dining_sessions (table_id)
  WHERE status IN ('open','checkout_requested','checkout_locked');
CREATE INDEX sessions_active_idx ON cl.dining_sessions (status, opened_at)
  WHERE status IN ('open','checkout_requested','checkout_locked');
CREATE INDEX sessions_table_idx ON cl.dining_sessions (table_id);
CREATE INDEX sessions_entry_point_idx ON cl.dining_sessions (entry_point_id);
CREATE INDEX sessions_opened_by_idx ON cl.dining_sessions (opened_by_user_id);
CREATE INDEX sessions_bdate_idx ON cl.dining_sessions (business_date);

-- A closed session stays closed; its number, type and opening never change.
CREATE FUNCTION cl.session_closed_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.session_no <> OLD.session_no OR NEW.order_type <> OLD.order_type
     OR NEW.opened_at <> OLD.opened_at OR NEW.business_date <> OLD.business_date
     OR (OLD.status IN ('settled','cancelled') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'session % cannot change that (status %)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dining_sessions_final BEFORE UPDATE ON cl.dining_sessions
  FOR EACH ROW EXECUTE FUNCTION cl.session_closed_is_final();

CREATE TABLE cl.session_table_moves (                           -- (A) D-10 transfer
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    bigint NOT NULL REFERENCES cl.dining_sessions,
  from_table_id bigint NOT NULL REFERENCES cl.dining_tables,
  to_table_id   bigint NOT NULL REFERENCES cl.dining_tables,
  moved_by      bigint NOT NULL REFERENCES cl.users,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_table_id <> to_table_id)
);
CREATE INDEX session_moves_session_idx ON cl.session_table_moves (session_id);
CREATE INDEX session_moves_from_idx ON cl.session_table_moves (from_table_id);
CREATE INDEX session_moves_to_idx ON cl.session_table_moves (to_table_id);
CREATE INDEX session_moves_by_idx ON cl.session_table_moves (moved_by);

CREATE TABLE cl.session_guest_tokens (                          -- (M)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES cl.dining_sessions,
  entry_point_id bigint NOT NULL REFERENCES cl.qr_entry_points,
  token_hash     bytea  NOT NULL UNIQUE,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('session_closed','staff_reset','expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX guest_tokens_live_idx ON cl.session_guest_tokens (session_id) WHERE revoked_at IS NULL;
CREATE INDEX guest_tokens_session_idx ON cl.session_guest_tokens (session_id);
CREATE INDEX guest_tokens_entry_point_idx ON cl.session_guest_tokens (entry_point_id);

-- A revoked token stays revoked.
CREATE FUNCTION cl.guest_token_revocation_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.session_id <> OLD.session_id) THEN
    RAISE EXCEPTION 'guest token % is revoked', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_guest_tokens_final BEFORE UPDATE ON cl.session_guest_tokens
  FOR EACH ROW EXECUTE FUNCTION cl.guest_token_revocation_final();

-- HMAC keys the server creates on first use (entry cookie). Never shown to anyone;
-- replacing a key only makes guests scan their table's QR code again.
CREATE TABLE cl.signing_keys (
  purpose    text  PRIMARY KEY CHECK (purpose IN ('guest_entry')),
  key        bytea NOT NULL CHECK (length(key) >= 32),
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE SELECT ON cl.signing_keys FROM cl_readonly;

-- Alerts about service, not stock (those are cl.inventory_alerts): stale sessions (T1)
-- and, from step 3.5, items not picked up. One open alert per subject and kind.
CREATE TABLE cl.operational_alerts (                            -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text   NOT NULL CHECK (kind IN ('stale_session','uncollected_item')),
  entity_type text   NOT NULL,
  entity_id   bigint NOT NULL,
  state       text   NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  detail      jsonb,
  resolved_at timestamptz,
  resolved_by bigint REFERENCES cl.users,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1,
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX operational_alerts_one_open ON cl.operational_alerts (kind, entity_type, entity_id)
  WHERE state <> 'resolved';
CREATE INDEX operational_alerts_resolved_by_idx ON cl.operational_alerts (resolved_by);

CREATE TRIGGER dining_tables_touch BEFORE UPDATE ON cl.dining_tables FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER qr_entry_points_touch BEFORE UPDATE ON cl.qr_entry_points FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER dining_sessions_touch BEFORE UPDATE ON cl.dining_sessions FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER session_guest_tokens_touch BEFORE UPDATE ON cl.session_guest_tokens FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER operational_alerts_touch BEFORE UPDATE ON cl.operational_alerts FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER session_table_moves_append_only BEFORE UPDATE OR DELETE ON cl.session_table_moves
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

GRANT UPDATE ON cl.dining_tables, cl.qr_entry_points, cl.table_assignments, cl.dining_sessions,
                cl.session_guest_tokens, cl.operational_alerts
  TO cl_app;
