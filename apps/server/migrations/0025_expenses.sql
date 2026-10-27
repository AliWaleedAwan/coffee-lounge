-- 0025 Expenses (DATABASE.md §10; FINANCE_REPORTING.md §3–4; Phase 5 step 5.3). Rent, wages,
-- repairs and the like, each with its category, payee, how it was paid and the bill's
-- photo or PDF (P5-3, kept on disk). A recorded expense never changes; it is voided with a
-- reason (a reversal in the ledger) and, to correct it, recorded again pointing at the one
-- it replaces (AT-23, AT-107). Cash taken from the till while a shift is open is also that
-- shift's paid-out (P5-6), with one ledger entry: the expense's.

CREATE TABLE cl.expense_categories (                           -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX expense_categories_name_key ON cl.expense_categories (lower(btrim(name)));
-- A starter list the owner edits (I-12).
INSERT INTO cl.expense_categories (name) VALUES
  ('Rent'), ('Utilities'), ('Wages'), ('Repairs & maintenance'), ('Supplies'), ('Cleaning'),
  ('Transport'), ('Marketing'), ('Bank charges'), ('Other');
GRANT UPDATE ON cl.expense_categories TO cl_app;

CREATE TABLE cl.expenses (                                     -- (M) void = reversal ledger entry
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_no          text   NOT NULL UNIQUE,                  -- 'EXP-2026-00012' (P5-4), gapless per year
  category_id         bigint NOT NULL REFERENCES cl.expense_categories,
  amount              cl.amount NOT NULL CHECK (amount > 0),
  payee               text   CHECK (length(btrim(payee)) BETWEEN 1 AND 80),
  reference           text   CHECK (length(btrim(reference)) BETWEEN 1 AND 40),
  note                text   CHECK (length(note) <= 300),
  business_date       date   NOT NULL,
  paid_via            text   NOT NULL CHECK (paid_via IN ('cash','card','transfer','other')),
  transfer_provider   text   CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  from_till           boolean NOT NULL DEFAULT false,         -- cash out of the open shift's drawer (P5-6)
  cash_shift_id       bigint REFERENCES cl.cash_shifts,
  replaces_expense_id bigint UNIQUE REFERENCES cl.expenses,     -- a correction: the voided one it replaces
  attachment_path     text,                                     -- relative to FILES_DIR
  attachment_type     text   CHECK (attachment_type IN ('image/jpeg','image/png','application/pdf')),
  attachment_size     int    CHECK (attachment_size BETWEEN 1 AND 5242880),
  attachment_sha256   text   CHECK (attachment_sha256 ~ '^[0-9a-f]{64}$'),
  status              text   NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','voided')),
  created_by          bigint NOT NULL REFERENCES cl.users,
  created_at          timestamptz NOT NULL DEFAULT now(),
  voided_by           bigint REFERENCES cl.users,
  voided_at           timestamptz,
  void_reason         text   CHECK (length(btrim(void_reason)) BETWEEN 3 AND 300),
  CHECK ((status = 'voided') = (voided_by IS NOT NULL AND void_reason IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK ((paid_via = 'transfer') = (transfer_provider IS NOT NULL)),
  CHECK (NOT from_till OR paid_via = 'cash'),
  CHECK (from_till = (cash_shift_id IS NOT NULL)),
  CHECK ((attachment_path IS NULL) = (attachment_type IS NULL)
     AND (attachment_path IS NULL) = (attachment_size IS NULL)
     AND (attachment_path IS NULL) = (attachment_sha256 IS NULL))
);
CREATE INDEX expenses_bdate_idx       ON cl.expenses (business_date);
CREATE INDEX expenses_category_idx    ON cl.expenses (category_id);
CREATE INDEX expenses_created_by_idx  ON cl.expenses (created_by);
CREATE INDEX expenses_voided_by_idx   ON cl.expenses (voided_by);
CREATE INDEX expenses_cash_shift_idx  ON cl.expenses (cash_shift_id);
GRANT UPDATE ON cl.expenses TO cl_app;
CREATE TRIGGER expenses_need_open_shift BEFORE INSERT ON cl.expenses
  FOR EACH ROW EXECUTE FUNCTION cl.needs_open_shift('cash_shift_id');

-- Recorded → voided, once; otherwise only the attached bill may be added or replaced.
CREATE FUNCTION cl.expense_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An expense is never deleted; void it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'A voided expense never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.expense_no, NEW.category_id, NEW.amount, NEW.payee, NEW.reference, NEW.note, NEW.business_date,
      NEW.paid_via, NEW.transfer_provider, NEW.from_till, NEW.cash_shift_id, NEW.replaces_expense_id,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.expense_no, OLD.category_id, OLD.amount, OLD.payee, OLD.reference, OLD.note, OLD.business_date,
      OLD.paid_via, OLD.transfer_provider, OLD.from_till, OLD.cash_shift_id, OLD.replaces_expense_id,
      OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A recorded expense never changes; void it and record it again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER expenses_guard BEFORE UPDATE OR DELETE ON cl.expenses
  FOR EACH ROW EXECUTE FUNCTION cl.expense_guard();

-- ---------------------------------------------------------------- the till (P5-6)

-- A paid-out or paid-in that belongs to an expense paid from (or voided back into) the till.
ALTER TABLE cl.cash_movements ADD COLUMN expense_id bigint REFERENCES cl.expenses;
CREATE UNIQUE INDEX cash_movements_expense_key ON cl.cash_movements (expense_id, kind);

-- Such a movement has no ledger entry of its own: the expense (or its void) carries it.
CREATE OR REPLACE FUNCTION cl.ledger_on_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.expense_id IS NULL THEN
    PERFORM cl.ledger_post(CASE NEW.kind WHEN 'paid_in' THEN 'cash_in' ELSE 'cash_out' END,
      CASE NEW.kind WHEN 'paid_in' THEN 'in' ELSE 'out' END, NEW.amount, 'cash', NULL,
      cl.shop_business_date(NEW.created_at), 'cash_movement', NEW.id, 'cash_movement:' || NEW.id, NEW.actor);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- ledger (0023)

ALTER TABLE cl.ledger_entries ADD CONSTRAINT ledger_entries_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES cl.expense_categories;

CREATE FUNCTION cl.ledger_on_expense() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  recorded bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider, category_id,
                                   business_date, source_type, source_id, source_key, created_by)
    VALUES ('pending', 'expense', 'out', NEW.amount, NEW.paid_via, NEW.transfer_provider, NEW.category_id,
            NEW.business_date, 'expense', NEW.id, 'expense:' || NEW.id, NEW.created_by)
    ON CONFLICT (source_key) DO NOTHING;
  ELSIF OLD.status = 'recorded' AND NEW.status = 'voided' THEN
    SELECT id INTO recorded FROM cl.ledger_entries WHERE source_key = 'expense:' || NEW.id;
    INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider, category_id,
                                   business_date, source_type, source_id, source_key, reverses_entry_id, memo,
                                   created_by)
    VALUES ('pending', 'reversal', 'in', NEW.amount, NEW.paid_via, NEW.transfer_provider, NEW.category_id,
            cl.shop_business_date(NEW.voided_at), 'expense', NEW.id, 'expense:' || NEW.id || ':void', recorded,
            NEW.void_reason, NEW.voided_by)
    ON CONFLICT (source_key) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER expenses_ledger AFTER INSERT OR UPDATE ON cl.expenses
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_expense();
