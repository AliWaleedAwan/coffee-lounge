-- 0018 Suppliers and purchase receipts (DATABASE.md §5; RECIPE_INVENTORY.md §7;
-- COST_VALUATION.md §3; Phase 4 step 4.2). A receipt is written as a draft, its lines
-- added, then posted in the same transaction with its GRN number; a posted receipt never
-- changes except to be reversed as a whole, and its lines never change at all. Payment is
-- recorded (channel and reference) for the ledger of Phase 5 (P4-2).

CREATE TABLE cl.suppliers (                                    -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  phone      text CHECK (length(phone) <= 30),
  email      text CHECK (length(email) <= 120),
  address    text CHECK (length(address) <= 200),
  notes      text CHECK (length(notes) <= 500),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX suppliers_active_name_uq ON cl.suppliers (lower(btrim(name))) WHERE is_active;

CREATE TABLE cl.purchase_receipts (                            -- (M) lines frozen once posted
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no           text UNIQUE CHECK (receipt_no ~ '^GRN-\d{4}-\d{5,}$'),
  supplier_id          bigint REFERENCES cl.suppliers,
  supplier_invoice_ref text CHECK (length(supplier_invoice_ref) <= 60),
  received_at          timestamptz NOT NULL DEFAULT now(),
  business_date        date,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  total_cost           cl.amount CHECK (total_cost >= 0),
  paid_now             boolean NOT NULL DEFAULT false,
  payment_channel      text CHECK (payment_channel IN ('cash','card','transfer')),
  payment_reference    text CHECK (length(payment_reference) <= 60),
  note                 text CHECK (length(note) <= 200),
  created_by           bigint NOT NULL REFERENCES cl.users,
  posted_by            bigint REFERENCES cl.users,
  posted_at            timestamptz,
  reversed_by          bigint REFERENCES cl.users,
  reversed_at          timestamptz,
  reversal_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              int NOT NULL DEFAULT 1,
  CHECK (status = 'draft' OR (receipt_no IS NOT NULL AND posted_at IS NOT NULL
                              AND posted_by IS NOT NULL AND business_date IS NOT NULL
                              AND total_cost IS NOT NULL)),
  CHECK (paid_now = (payment_channel IS NOT NULL)),
  CHECK (payment_reference IS NULL OR paid_now),
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL)),
  CHECK ((status = 'reversed') = (reversed_by IS NOT NULL)),
  CHECK ((status = 'reversed') = (coalesce(length(btrim(reversal_reason)), 0) >= 3))
);
CREATE INDEX purchase_receipts_supplier_idx ON cl.purchase_receipts (supplier_id);
CREATE INDEX purchase_receipts_bdate_idx ON cl.purchase_receipts (business_date);
CREATE INDEX purchase_receipts_created_by_idx ON cl.purchase_receipts (created_by);
CREATE INDEX purchase_receipts_posted_by_idx ON cl.purchase_receipts (posted_by);
CREATE INDEX purchase_receipts_reversed_by_idx ON cl.purchase_receipts (reversed_by);

-- draft → posted → reversed, each once; a posted receipt changes only by being reversed.
CREATE FUNCTION cl.purchase_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A purchase receipt is never deleted; reverse it' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'reversed'
     OR (OLD.status = 'posted' AND NEW.status NOT IN ('posted','reversed'))
     OR (OLD.status = 'draft' AND NEW.status = 'reversed') THEN
    RAISE EXCEPTION 'purchase receipt % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'posted' AND (
       NEW.receipt_no IS DISTINCT FROM OLD.receipt_no OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.supplier_invoice_ref IS DISTINCT FROM OLD.supplier_invoice_ref
    OR NEW.received_at <> OLD.received_at OR NEW.business_date <> OLD.business_date
    OR NEW.total_cost <> OLD.total_cost OR NEW.paid_now <> OLD.paid_now
    OR NEW.payment_channel IS DISTINCT FROM OLD.payment_channel
    OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
    OR NEW.note IS DISTINCT FROM OLD.note OR NEW.posted_by <> OLD.posted_by
    OR NEW.posted_at <> OLD.posted_at OR NEW.created_by <> OLD.created_by) THEN
    RAISE EXCEPTION 'A posted purchase receipt never changes; reverse it and post a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipts_guard BEFORE UPDATE OR DELETE ON cl.purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION cl.purchase_receipt_guard();

CREATE TABLE cl.purchase_receipt_lines (                       -- (D) only while the receipt is a draft
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id     bigint NOT NULL REFERENCES cl.purchase_receipts,
  item_id        bigint NOT NULL REFERENCES cl.inventory_items,
  pack_size_id   bigint,
  pack_qty       numeric(12,3) CHECK (pack_qty > 0),
  qty_base       cl.qty       NOT NULL CHECK (qty_base > 0),
  line_cost      cl.amount    NOT NULL CHECK (line_cost >= 0),
  unit_cost_base cl.unit_cost NOT NULL CHECK (unit_cost_base >= 0), -- = round(line_cost / qty_base, 8)
  lot_code       text CHECK (length(btrim(lot_code)) BETWEEN 1 AND 40),
  expiry_date    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((pack_size_id IS NULL) = (pack_qty IS NULL)),
  FOREIGN KEY (pack_size_id, item_id) REFERENCES cl.item_pack_sizes (id, item_id)
);
CREATE INDEX purchase_receipt_lines_receipt_idx ON cl.purchase_receipt_lines (receipt_id);
CREATE INDEX purchase_receipt_lines_item_idx ON cl.purchase_receipt_lines (item_id);
CREATE INDEX purchase_receipt_lines_pack_idx ON cl.purchase_receipt_lines (pack_size_id, item_id);

CREATE FUNCTION cl.purchase_receipt_lines_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM cl.purchase_receipts
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.receipt_id ELSE NEW.receipt_id END;
  IF parent_status <> 'draft' OR (TG_OP = 'UPDATE' AND OLD.receipt_id <> NEW.receipt_id) THEN
    RAISE EXCEPTION 'receipt lines can change only while the receipt is a draft'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER purchase_receipt_lines_frozen BEFORE INSERT OR UPDATE OR DELETE ON cl.purchase_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION cl.purchase_receipt_lines_draft_only();

CREATE TRIGGER suppliers_touch BEFORE UPDATE ON cl.suppliers FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER purchase_receipts_touch BEFORE UPDATE ON cl.purchase_receipts FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

GRANT UPDATE ON cl.suppliers, cl.purchase_receipts TO cl_app;
