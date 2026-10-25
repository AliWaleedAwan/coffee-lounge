-- 0015 Delivery: riders and delivery orders (DATABASE.md §6; ORDER_STATE_MACHINE.md §7;
-- D-05, D-41; Phase 3 step 3.10). Deviations recorded in DATABASE.md §15: the standard
-- columns; `delivery_orders.attempt` (each dispatch prints its own rider receipt),
-- `refund_due` (P3-1: a cancelled prepaid delivery is marked for refund, recorded in Phase
-- 5); `created_by`; transition and final-state guards; the payments rider FK that 0013
-- left out; two more operational alert kinds; delivery sessions are opened by staff only.

CREATE TABLE cl.staff_profiles (                                -- (M) riders: no login (D-41)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  kind         text NOT NULL DEFAULT 'rider' CHECK (kind IN ('rider')),
  phone        text CHECK (phone IS NULL OR length(phone) <= 20),
  user_id      bigint REFERENCES cl.users,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX staff_profiles_active_name ON cl.staff_profiles (lower(display_name)) WHERE is_active;
CREATE INDEX staff_profiles_user_idx ON cl.staff_profiles (user_id);

ALTER TABLE cl.payments
  ADD CONSTRAINT payments_rider_fk FOREIGN KEY (collected_by_rider_id) REFERENCES cl.staff_profiles;
CREATE INDEX payments_rider_idx ON cl.payments (collected_by_rider_id);

-- A delivery is always entered by staff (phone, WhatsApp, walk-in); there is no delivery QR.
ALTER TABLE cl.dining_sessions
  ADD CONSTRAINT session_delivery_by_staff CHECK (order_type <> 'delivery' OR opened_via = 'staff');

CREATE TABLE cl.delivery_orders (                               -- (M) D-05
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint NOT NULL UNIQUE REFERENCES cl.dining_sessions,
  channel        text NOT NULL CHECK (channel IN ('phone','whatsapp','walk_in')),
  address        text CHECK (length(address) <= 300),          -- optional (D-05)
  landmark       text CHECK (length(landmark) <= 120),
  notes          text CHECK (length(notes) <= 200),
  payment_mode   text NOT NULL CHECK (payment_mode IN ('prepaid','cod_cash','card_on_delivery')),
  status         text NOT NULL DEFAULT 'pending_dispatch'
                 CHECK (status IN ('pending_dispatch','out_for_delivery','delivered','failed',
                                   'cancelled','converted_to_pickup')),
  rider_id       bigint REFERENCES cl.staff_profiles,
  attempt        int  NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  dispatched_at  timestamptz,
  delivered_at   timestamptz,
  failed_at      timestamptz,
  failure_reason text,
  resolved_by    bigint REFERENCES cl.users,
  refund_due     cl.amount NOT NULL DEFAULT 0 CHECK (refund_due >= 0),
  created_by     bigint NOT NULL REFERENCES cl.users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('out_for_delivery','delivered','failed') OR (rider_id IS NOT NULL AND dispatched_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL),
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK (refund_due = 0 OR (status = 'cancelled' AND payment_mode = 'prepaid')),
  CHECK (status = 'pending_dispatch' OR attempt > 0 OR status IN ('cancelled','converted_to_pickup'))
);
CREATE INDEX delivery_open_idx ON cl.delivery_orders (status)
  WHERE status IN ('pending_dispatch','out_for_delivery','failed');
CREATE INDEX delivery_rider_idx ON cl.delivery_orders (rider_id);
CREATE INDEX delivery_resolved_by_idx ON cl.delivery_orders (resolved_by);
CREATE INDEX delivery_created_by_idx ON cl.delivery_orders (created_by);

-- ORDER_STATE_MACHINE.md §7: only these moves; delivered, cancelled and converted are final.
CREATE FUNCTION cl.delivery_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivery % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.session_id <> OLD.session_id OR NEW.payment_mode <> OLD.payment_mode OR NEW.attempt < OLD.attempt
     OR (NEW.status <> OLD.status AND NOT (
          (OLD.status = 'pending_dispatch' AND NEW.status IN ('out_for_delivery','cancelled')) OR
          (OLD.status = 'out_for_delivery' AND NEW.status IN ('delivered','failed')) OR
          (OLD.status = 'failed' AND NEW.status IN ('out_for_delivery','converted_to_pickup','cancelled'))))
     OR (OLD.status IN ('delivered','cancelled','converted_to_pickup')
         AND (NEW.status, NEW.rider_id, NEW.refund_due, NEW.delivered_at, NEW.dispatched_at)
             IS DISTINCT FROM (OLD.status, OLD.rider_id, OLD.refund_due, OLD.delivered_at, OLD.dispatched_at)) THEN
    RAISE EXCEPTION 'delivery % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_orders_transition BEFORE UPDATE OR DELETE ON cl.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION cl.delivery_transition();

CREATE TABLE cl.delivery_events (                               -- (A) who did what, with which rider
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_order_id bigint NOT NULL REFERENCES cl.delivery_orders,
  from_status       text,
  to_status         text   NOT NULL,
  actor_user_id     bigint NOT NULL REFERENCES cl.users,
  rider_id          bigint REFERENCES cl.staff_profiles,
  reason            text,
  event_key         text   NOT NULL UNIQUE,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_events_order_idx ON cl.delivery_events (delivery_order_id);
CREATE INDEX delivery_events_actor_idx ON cl.delivery_events (actor_user_id);
CREATE INDEX delivery_events_rider_idx ON cl.delivery_events (rider_id);
CREATE TRIGGER delivery_events_append_only BEFORE UPDATE OR DELETE ON cl.delivery_events
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- A failed delivery waits for a manager; a cancelled prepaid one is a refund due (P3-1).
ALTER TABLE cl.operational_alerts DROP CONSTRAINT operational_alerts_kind_check;
ALTER TABLE cl.operational_alerts ADD CONSTRAINT operational_alerts_kind_check
  CHECK (kind IN ('stale_session','uncollected_item','failed_delivery','refund_due'));

CREATE TRIGGER staff_profiles_touch BEFORE UPDATE ON cl.staff_profiles FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER delivery_orders_touch BEFORE UPDATE ON cl.delivery_orders FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

GRANT UPDATE ON cl.staff_profiles, cl.delivery_orders TO cl_app;
