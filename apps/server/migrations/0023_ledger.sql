-- 0023 Operational ledger (DATABASE.md §10; FINANCE_REPORTING.md §4; Phase 5 step 5.1).
-- Every money movement has exactly one entry with a link to its source. Automatic entries
-- are written by triggers on the sources, in the same transaction, so no code path can
-- forget one; a unique source key means nothing posts twice. Entries are never changed:
-- a correction is a reversal plus a new entry (D-31). The history recorded since Phase 3
-- gets its entries here, once (P5-2, P4-2).

-- Business date of a moment, by the shop's own settings (D-22).
CREATE FUNCTION cl.shop_business_date(ts timestamptz) RETURNS date LANGUAGE sql STABLE AS $$
  SELECT cl.business_date(ts,
           (SELECT value #>> '{}' FROM cl.system_settings WHERE key = 'shop.timezone'),
           (SELECT (value #>> '{}')::time FROM cl.system_settings WHERE key = 'shop.business_day_cutoff'))
$$;

CREATE TABLE cl.ledger_entries (                               -- (A)
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_no          text   NOT NULL UNIQUE,                    -- 'LE-2026-000123' (P5-4), from the id
  entry_type        text   NOT NULL CHECK (entry_type IN ('sale_receipt','refund','purchase_payment','expense',
                                                           'cash_in','cash_out','adjustment','reversal')),
  direction         text   NOT NULL CHECK (direction IN ('in','out')),
  amount            cl.amount NOT NULL CHECK (amount > 0),
  channel           text   NOT NULL CHECK (channel IN ('cash','card','transfer','other')),
  transfer_provider text   CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  category_id       bigint,                                    -- expense category; FK with cl.expense_categories (step 5.3)
  business_date     date   NOT NULL,
  source_type       text   NOT NULL CHECK (source_type IN ('payment','cash_movement','purchase_receipt',
                                                            'supplier_return','refund','expense','adjustment')),
  source_id         bigint NOT NULL,
  source_key        text   NOT NULL UNIQUE,
  reverses_entry_id bigint UNIQUE REFERENCES cl.ledger_entries,  -- an entry is reversed at most once
  memo              text   CHECK (length(memo) <= 300),
  created_by        bigint REFERENCES cl.users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CHECK (transfer_provider IS NULL OR channel = 'transfer'),
  CHECK (entry_type <> 'adjustment' OR length(btrim(memo)) >= 3)
);
CREATE INDEX ledger_bdate_idx    ON cl.ledger_entries (business_date, id);
CREATE INDEX ledger_source_idx   ON cl.ledger_entries (source_type, source_id);
CREATE INDEX ledger_created_by_idx ON cl.ledger_entries (created_by);
CREATE INDEX ledger_category_idx ON cl.ledger_entries (category_id);

-- The number follows the id, so it needs no counter; manual entries are their own source.
CREATE FUNCTION cl.ledger_entry_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.entry_no := 'LE-' || to_char(NEW.business_date, 'YYYY') || '-' || lpad(NEW.id::text, 6, '0');
  IF NEW.source_type = 'adjustment' AND NEW.reverses_entry_id IS NULL THEN
    NEW.source_id := NEW.id;
    NEW.source_key := 'adjustment:' || NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entries_defaults BEFORE INSERT ON cl.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_entry_defaults();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON cl.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- ---------------------------------------------------------------- automatic entries

CREATE FUNCTION cl.ledger_post(
  p_type text, p_direction text, p_amount numeric, p_channel text, p_provider text,
  p_date date, p_source_type text, p_source_id bigint, p_key text, p_by bigint,
  p_reverses bigint DEFAULT NULL
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider,
                                 business_date, source_type, source_id, source_key, created_by, reverses_entry_id)
  VALUES ('pending', p_type, p_direction, p_amount, p_channel, p_provider, p_date, p_source_type, p_source_id,
          p_key, p_by, p_reverses)
  ON CONFLICT (source_key) DO NOTHING
$$;

-- A payment received (P1): sale receipt, in, by its method.
CREATE FUNCTION cl.ledger_on_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cl.ledger_post('sale_receipt', 'in', NEW.amount,
    CASE NEW.method WHEN 'card_manual' THEN 'card' ELSE NEW.method END, NEW.transfer_provider,
    NEW.business_date, 'payment', NEW.id, 'payment:' || NEW.id, NEW.received_by);
  RETURN NULL;
END $$;
CREATE TRIGGER payments_ledger AFTER INSERT ON cl.payments
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_payment();

-- Cash paid in or out of the drawer during a shift.
CREATE FUNCTION cl.ledger_on_cash_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cl.ledger_post(CASE NEW.kind WHEN 'paid_in' THEN 'cash_in' ELSE 'cash_out' END,
    CASE NEW.kind WHEN 'paid_in' THEN 'in' ELSE 'out' END, NEW.amount, 'cash', NULL,
    cl.shop_business_date(NEW.created_at), 'cash_movement', NEW.id, 'cash_movement:' || NEW.id, NEW.actor);
  RETURN NULL;
END $$;
CREATE TRIGGER cash_movements_ledger AFTER INSERT ON cl.cash_movements
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_cash_movement();

-- A receipt paid when posted; reversing that receipt reverses its payment (the corrected
-- receipt records the payment again).
CREATE FUNCTION cl.ledger_on_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  paid_entry bigint;
BEGIN
  IF NEW.paid_now AND OLD.status = 'draft' AND NEW.status = 'posted' THEN
    PERFORM cl.ledger_post('purchase_payment', 'out', NEW.total_cost, NEW.payment_channel, NULL,
      NEW.business_date, 'purchase_receipt', NEW.id, 'purchase_receipt:' || NEW.id, NEW.posted_by);
  ELSIF NEW.paid_now AND OLD.status = 'posted' AND NEW.status = 'reversed' AND NEW.total_cost > 0 THEN
    SELECT id INTO paid_entry FROM cl.ledger_entries WHERE source_key = 'purchase_receipt:' || NEW.id;
    PERFORM cl.ledger_post('reversal', 'in', NEW.total_cost, NEW.payment_channel, NULL,
      cl.shop_business_date(NEW.reversed_at), 'purchase_receipt', NEW.id, 'purchase_receipt:' || NEW.id || ':reversal',
      NEW.reversed_by, paid_entry);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER purchase_receipts_ledger AFTER UPDATE ON cl.purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_receipt();

-- A supplier refund for a return: cash in by the channel it came (FINANCE_REPORTING.md §4).
CREATE FUNCTION cl.ledger_on_supplier_return() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.refund_amount IS NOT NULL AND NEW.refund_amount > 0 THEN
    PERFORM cl.ledger_post('cash_in', 'in', NEW.refund_amount, NEW.refund_channel, NULL,
      NEW.business_date, 'supplier_return', NEW.id, 'supplier_return:' || NEW.id, NEW.returned_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER supplier_returns_ledger AFTER INSERT ON cl.supplier_returns
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_supplier_return();

-- ---------------------------------------------------------------- the history (P5-2)

INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, transfer_provider, business_date,
                               source_type, source_id, source_key, created_by)
SELECT 'pending', 'sale_receipt', 'in', p.amount, CASE p.method WHEN 'card_manual' THEN 'card' ELSE p.method END,
       p.transfer_provider, p.business_date, 'payment', p.id, 'payment:' || p.id, p.received_by
  FROM cl.payments p ORDER BY p.id
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, business_date,
                               source_type, source_id, source_key, created_by)
SELECT 'pending', CASE m.kind WHEN 'paid_in' THEN 'cash_in' ELSE 'cash_out' END,
       CASE m.kind WHEN 'paid_in' THEN 'in' ELSE 'out' END, m.amount, 'cash', cl.shop_business_date(m.created_at),
       'cash_movement', m.id, 'cash_movement:' || m.id, m.actor
  FROM cl.cash_movements m ORDER BY m.id
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, business_date,
                               source_type, source_id, source_key, created_by)
SELECT 'pending', 'purchase_payment', 'out', r.total_cost, r.payment_channel, r.business_date,
       'purchase_receipt', r.id, 'purchase_receipt:' || r.id, r.posted_by
  FROM cl.purchase_receipts r WHERE r.paid_now AND r.status IN ('posted','reversed') AND r.total_cost > 0
 ORDER BY r.id
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, business_date,
                               source_type, source_id, source_key, created_by, reverses_entry_id)
SELECT 'pending', 'reversal', 'in', r.total_cost, r.payment_channel, cl.shop_business_date(r.reversed_at),
       'purchase_receipt', r.id, 'purchase_receipt:' || r.id || ':reversal', r.reversed_by, e.id
  FROM cl.purchase_receipts r JOIN cl.ledger_entries e ON e.source_key = 'purchase_receipt:' || r.id
 WHERE r.paid_now AND r.status = 'reversed' ORDER BY r.id
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO cl.ledger_entries (entry_no, entry_type, direction, amount, channel, business_date,
                               source_type, source_id, source_key, created_by)
SELECT 'pending', 'cash_in', 'in', s.refund_amount, s.refund_channel, s.business_date,
       'supplier_return', s.id, 'supplier_return:' || s.id, s.returned_by
  FROM cl.supplier_returns s WHERE s.refund_amount > 0 ORDER BY s.id
ON CONFLICT (source_key) DO NOTHING;

-- A ledger that does not match its sources is the owner's to investigate (nightly check).
ALTER TABLE cl.operational_alerts DROP CONSTRAINT operational_alerts_kind_check;
ALTER TABLE cl.operational_alerts ADD CONSTRAINT operational_alerts_kind_check
  CHECK (kind IN ('stale_session','uncollected_item','failed_delivery','refund_due','ledger_mismatch'));
