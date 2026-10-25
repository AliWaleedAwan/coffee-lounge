-- 0013 Bills, discounts, payments and the till (DATABASE.md §9; ORDER_STATE_MACHINE.md §6;
-- Phase 3 step 3.7). Refunds and the operational ledger follow in Phase 5; paid-in/out,
-- shift close and variance in step 3.8. Deviations recorded in DATABASE.md §15: the
-- standard columns on every (M) table, `created_at` on the (A) ones, `tills.receipt_printer_id`
-- (where receipts print), `payments.collected_by_rider_id` without its FK until riders exist
-- (step 3.10), and the seeded receipt template that carries the shop's receipt wording.

CREATE TABLE cl.tills (                                         -- (M) logical till; one 'Counter' till (no drawer)
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  is_active          boolean NOT NULL DEFAULT true,
  receipt_printer_id bigint REFERENCES cl.printers,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1
);
CREATE INDEX tills_printer_idx ON cl.tills (receipt_printer_id);
INSERT INTO cl.tills (name) VALUES ('Counter');

CREATE TABLE cl.cash_shifts (                                   -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  till_id         bigint    NOT NULL REFERENCES cl.tills,
  cashier_user_id bigint    NOT NULL REFERENCES cl.users,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_float   cl.amount NOT NULL CHECK (opening_float >= 0),
  closed_at       timestamptz,
  counted_cash    cl.amount CHECK (counted_cash >= 0),
  expected_cash   cl.amount,
  variance        cl.amount,
  variance_reason text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','approved')),
  approved_by     bigint REFERENCES cl.users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> cashier_user_id)
);
CREATE UNIQUE INDEX shift_one_open_per_till ON cl.cash_shifts (till_id) WHERE status = 'open';
CREATE INDEX cash_shifts_cashier_idx ON cl.cash_shifts (cashier_user_id);
CREATE INDEX cash_shifts_approved_by_idx ON cl.cash_shifts (approved_by);

CREATE TABLE cl.cash_movements (                                -- (A) paid-in / paid-out (step 3.8)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id    bigint    NOT NULL REFERENCES cl.cash_shifts,
  kind        text      NOT NULL CHECK (kind IN ('paid_in','paid_out')),
  amount      cl.amount NOT NULL CHECK (amount > 0),
  reason      text      NOT NULL,
  actor       bigint    NOT NULL REFERENCES cl.users,
  approved_by bigint    REFERENCES cl.users,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_movements_shift_idx ON cl.cash_movements (shift_id);
CREATE INDEX cash_movements_actor_idx ON cl.cash_movements (actor);
CREATE INDEX cash_movements_approved_by_idx ON cl.cash_movements (approved_by);

CREATE TABLE cl.invoices (                                      -- (M) frozen once settled (trigger)
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id          bigint NOT NULL UNIQUE REFERENCES cl.dining_sessions,   -- one bill per session
  invoice_no          text UNIQUE,                             -- 'INV-2026-000123', assigned at settlement
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','settled')),
  lock_version        int  NOT NULL DEFAULT 0,
  subtotal            cl.amount NOT NULL DEFAULT 0,            -- Σ line gross − promotion discounts
  discount_total      cl.amount NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total           cl.amount NOT NULL DEFAULT 0 CHECK (tax_total = 0),     -- DEC-13; changing needs a migration
  rounding_adjustment cl.amount NOT NULL DEFAULT 0,            -- D-16
  total               cl.amount NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid_total          cl.amount NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  locked_at           timestamptz,
  locked_by           bigint REFERENCES cl.users,
  settled_at          timestamptz,
  settled_by          bigint REFERENCES cl.users,
  business_date       date,                                    -- settlement business date (D-21)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1,
  CHECK (total = subtotal - discount_total + tax_total + rounding_adjustment),
  CHECK (paid_total <= total),
  CHECK (status = 'open' OR (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status <> 'settled' OR (invoice_no IS NOT NULL AND paid_total = total AND business_date IS NOT NULL)),
  CHECK (invoice_no IS NULL OR status = 'settled')
);
CREATE INDEX invoices_unsettled_idx ON cl.invoices (status) WHERE status <> 'settled';
CREATE INDEX invoices_bdate_idx ON cl.invoices (business_date);
CREATE INDEX invoices_locked_by_idx ON cl.invoices (locked_by);
CREATE INDEX invoices_settled_by_idx ON cl.invoices (settled_by);

-- Every session has its bill from the start (S1); sessions opened before this migration too.
INSERT INTO cl.invoices (session_id) SELECT id FROM cl.dining_sessions ORDER BY dining_sessions.id;

CREATE TABLE cl.invoice_lines (                                 -- (D) rebuilt on lock, frozen on settlement
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id           bigint NOT NULL REFERENCES cl.invoices,
  order_line_id        bigint NOT NULL UNIQUE REFERENCES cl.order_lines,
  description_snap     text   NOT NULL,
  billable_qty         int    NOT NULL CHECK (billable_qty >= 0),
  unit_price           cl.amount NOT NULL,
  modifiers_unit_total cl.amount NOT NULL,
  gross                cl.amount NOT NULL,
  promotion_discount   cl.amount NOT NULL DEFAULT 0 CHECK (promotion_discount >= 0),
  manual_discount      cl.amount NOT NULL DEFAULT 0 CHECK (manual_discount >= 0),
  discount_alloc       cl.amount NOT NULL DEFAULT 0 CHECK (discount_alloc >= 0),   -- pro-rata share of bill discounts (D-21)
  net                  cl.amount NOT NULL,
  is_comp              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (gross = (unit_price + modifiers_unit_total) * billable_qty),
  CHECK (net = gross - promotion_discount - manual_discount - discount_alloc),
  CHECK (net >= 0),
  CHECK (NOT is_comp OR net = 0)
);
CREATE INDEX invoice_lines_invoice_idx ON cl.invoice_lines (invoice_id);

CREATE TABLE cl.discount_applications (                         -- (M) voidable before settlement only
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id    bigint NOT NULL REFERENCES cl.invoices,
  order_line_id bigint REFERENCES cl.order_lines,               -- NULL = bill-level
  kind          text   NOT NULL CHECK (kind IN ('percent','fixed','comp')),
  value         numeric(14,2) NOT NULL CHECK (value >= 0),
  amount        cl.amount NOT NULL CHECK (amount >= 0),         -- what it took off when the bill was last worked out
  reason        text   NOT NULL CHECK (length(reason) BETWEEN 3 AND 120),
  applied_by    bigint NOT NULL REFERENCES cl.users,
  step_up_id    bigint REFERENCES cl.step_up_approvals,         -- required above the role limit
  voided_at     timestamptz,
  voided_by     bigint REFERENCES cl.users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (kind <> 'comp' OR (order_line_id IS NOT NULL AND value = 100)),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);
CREATE INDEX discounts_invoice_idx ON cl.discount_applications (invoice_id);
CREATE INDEX discounts_line_idx ON cl.discount_applications (order_line_id);
CREATE INDEX discounts_applied_by_idx ON cl.discount_applications (applied_by);
CREATE INDEX discounts_step_up_idx ON cl.discount_applications (step_up_id);
CREATE INDEX discounts_voided_by_idx ON cl.discount_applications (voided_by);

CREATE TABLE cl.payments (                                      -- (A)
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id            bigint    NOT NULL REFERENCES cl.invoices,
  method                text      NOT NULL CHECK (method IN ('cash','card_manual','transfer')),
  transfer_provider     text      CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  amount                cl.amount NOT NULL CHECK (amount > 0),   -- applied to the invoice
  tendered              cl.amount,
  change_due            cl.amount,
  reference             text      CHECK (char_length(reference) BETWEEN 1 AND 32),
  confirmed_by          bigint    REFERENCES cl.users,           -- transfer seen in the shop's account/app
  collected_by_rider_id bigint,                                  -- COD / card on delivery; FK with riders (step 3.10)
  received_by           bigint    NOT NULL REFERENCES cl.users,
  cash_shift_id         bigint    REFERENCES cl.cash_shifts,
  idempotency_key       uuid      NOT NULL UNIQUE,
  business_date         date      NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((method = 'transfer') = (transfer_provider IS NOT NULL)),
  CHECK (method <> 'transfer' OR (reference IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((method = 'cash') = (tendered IS NOT NULL)),
  CHECK (method <> 'cash' OR (tendered >= amount AND change_due = tendered - amount)),
  CHECK (method = 'cash' OR change_due IS NULL),
  CHECK (method <> 'cash' OR cash_shift_id IS NOT NULL)
);
CREATE INDEX payments_invoice_idx ON cl.payments (invoice_id);
CREATE INDEX payments_bdate_idx   ON cl.payments (business_date, method);
CREATE INDEX payments_shift_idx   ON cl.payments (cash_shift_id);
CREATE INDEX payments_confirmed_by_idx ON cl.payments (confirmed_by);
CREATE INDEX payments_received_by_idx ON cl.payments (received_by);
-- Service rule: a reference must not look like a card number (13–19 digits passing Luhn).

-- AT-97: a settled invoice, its lines and its discounts never change again. Corrections
-- are refunds (Phase 5), which leave the invoice as it is. Invoices are never deleted.
CREATE FUNCTION cl.invoice_settled_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'settled' OR NEW.session_id <> OLD.session_id OR NEW.lock_version < OLD.lock_version
     OR NEW.paid_total < OLD.paid_total THEN
    RAISE EXCEPTION 'invoice % cannot change that (status %)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_settled_is_final BEFORE UPDATE OR DELETE ON cl.invoices
  FOR EACH ROW EXECUTE FUNCTION cl.invoice_settled_is_final();

-- Lines and discounts of a settled invoice: no insert, update or delete.
CREATE FUNCTION cl.invoice_child_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION '% row % cannot move to another invoice', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM cl.invoices WHERE id = inv AND status = 'settled') THEN
    RAISE EXCEPTION 'invoice % is settled: % cannot change', inv, TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER invoice_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON cl.invoice_lines
  FOR EACH ROW EXECUTE FUNCTION cl.invoice_child_frozen();
CREATE TRIGGER discount_applications_frozen BEFORE INSERT OR UPDATE OR DELETE ON cl.discount_applications
  FOR EACH ROW EXECUTE FUNCTION cl.invoice_child_frozen();

-- A payment lands only on a locked invoice (P1); the payment that settles it comes first.
CREATE FUNCTION cl.payment_needs_locked_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cl.invoices WHERE id = NEW.invoice_id AND status = 'locked') THEN
    RAISE EXCEPTION 'invoice % is not locked for payment', NEW.invoice_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_need_locked_invoice BEFORE INSERT ON cl.payments
  FOR EACH ROW EXECUTE FUNCTION cl.payment_needs_locked_invoice();

CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON cl.payments
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cl.cash_movements
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

CREATE TRIGGER tills_touch BEFORE UPDATE ON cl.tills FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER cash_shifts_touch BEFORE UPDATE ON cl.cash_shifts FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER invoices_touch BEFORE UPDATE ON cl.invoices FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER discount_applications_touch BEFORE UPDATE ON cl.discount_applications
  FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

-- The receipt's wording (PRINTING_HARDWARE.md §4); the owner confirms it at design review R5.
INSERT INTO cl.ticket_templates (kind, name, definition, is_active) VALUES
  ('receipt', 'Customer receipt (80 mm)',
   '{"widthMm": 80, "shopName": "Coffee Lounge", "addressLine": null, "phone": null, "footer": "Thank you — see you again!"}',
   true);

GRANT UPDATE ON cl.tills, cl.cash_shifts, cl.invoices, cl.discount_applications TO cl_app;
GRANT DELETE ON cl.invoice_lines TO cl_app;
