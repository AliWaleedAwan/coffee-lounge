-- 0024 Refunds and payment-method corrections (DATABASE.md §9; ORDER_STATE_MACHINE.md P2;
-- FINANCE_REPORTING.md §4–5; D-13; Phase 5 step 5.2). A refund pays money back to the
-- method of one payment of a settled invoice; a method correction says a payment was
-- really taken another way. Both need an approver other than the requester (step-up);
-- the invoice never changes. Ledger entries follow by trigger, as in 0023.

CREATE TABLE cl.refunds (                                       -- (A) refunds and method corrections
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_no         text   NOT NULL UNIQUE,                    -- 'RF-2026-00012', gapless per year
  kind              text   NOT NULL CHECK (kind IN ('refund','method_correction')),
  invoice_id        bigint NOT NULL REFERENCES cl.invoices,
  payment_id        bigint NOT NULL REFERENCES cl.payments,     -- to the original method: always one payment
  amount            cl.amount NOT NULL CHECK (amount > 0),
  -- refund: the method the money goes back by; correction: the method it was really taken by
  method            text   NOT NULL CHECK (method IN ('cash','card_manual','transfer')),
  transfer_provider text   CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  -- correction only: the method the payment showed before
  previous_method   text   CHECK (previous_method IN ('cash','card_manual','transfer')),
  previous_provider text   CHECK (previous_provider IN ('bank','jazzcash','easypaisa')),
  reference         text   CHECK (char_length(reference) BETWEEN 1 AND 32),
  reason            text   NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  requested_by      bigint NOT NULL REFERENCES cl.users,
  approved_by       bigint NOT NULL REFERENCES cl.users,
  step_up_id        bigint NOT NULL UNIQUE REFERENCES cl.step_up_approvals,
  cash_shift_id     bigint REFERENCES cl.cash_shifts,          -- whenever cash is paid out or moved
  idempotency_key   uuid   NOT NULL UNIQUE,
  business_date     date   NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by <> requested_by),
  CHECK ((method = 'transfer') = (transfer_provider IS NOT NULL)),
  CHECK ((kind = 'method_correction') = (previous_method IS NOT NULL)),
  CHECK (previous_method IS NULL OR (previous_method = 'transfer') = (previous_provider IS NOT NULL)),
  CHECK (previous_method IS NOT NULL OR previous_provider IS NULL),
  CHECK (previous_method IS NULL OR (previous_method, previous_provider) IS DISTINCT FROM (method, transfer_provider)),
  CHECK ((method = 'cash' OR previous_method IS NOT DISTINCT FROM 'cash') = (cash_shift_id IS NOT NULL))
);
CREATE INDEX refunds_invoice_idx      ON cl.refunds (invoice_id);
CREATE INDEX refunds_payment_idx      ON cl.refunds (payment_id);
CREATE INDEX refunds_requested_by_idx ON cl.refunds (requested_by);
CREATE INDEX refunds_approved_by_idx  ON cl.refunds (approved_by);
CREATE INDEX refunds_cash_shift_idx   ON cl.refunds (cash_shift_id);
CREATE INDEX refunds_bdate_idx        ON cl.refunds (business_date);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON cl.refunds
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER refunds_need_open_shift BEFORE INSERT ON cl.refunds
  FOR EACH ROW EXECUTE FUNCTION cl.needs_open_shift('cash_shift_id');

CREATE TABLE cl.refund_lines (                                  -- (A) item-level net sales
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id       bigint NOT NULL REFERENCES cl.refunds,
  invoice_line_id bigint NOT NULL REFERENCES cl.invoice_lines,
  qty             int    NOT NULL CHECK (qty > 0),
  amount          cl.amount NOT NULL CHECK (amount > 0),
  UNIQUE (refund_id, invoice_line_id)
);
CREATE INDEX refund_lines_invoice_line_idx ON cl.refund_lines (invoice_line_id);
CREATE TRIGGER refund_lines_append_only BEFORE UPDATE OR DELETE ON cl.refund_lines
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- ---------------------------------------------------------------- ledger (0023)

CREATE FUNCTION cl.ledger_channel(method text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE method WHEN 'card_manual' THEN 'card' ELSE method END
$$;

-- A refund: money out by its method. A correction: the payment's last entry is reversed and
-- the money comes in again by the right method, so each channel's balance is right.
CREATE FUNCTION cl.ledger_on_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous bigint;
BEGIN
  IF NEW.kind = 'refund' THEN
    PERFORM cl.ledger_post('refund', 'out', NEW.amount, cl.ledger_channel(NEW.method), NEW.transfer_provider,
      NEW.business_date, 'refund', NEW.id, 'refund:' || NEW.id, NEW.requested_by);
  ELSE
    SELECT e.id INTO previous FROM cl.ledger_entries e
     WHERE e.source_key = COALESCE(
             (SELECT 'refund:' || max(r.id) FROM cl.refunds r
               WHERE r.payment_id = NEW.payment_id AND r.kind = 'method_correction' AND r.id < NEW.id),
             'payment:' || NEW.payment_id);
    PERFORM cl.ledger_post('reversal', 'out', NEW.amount, cl.ledger_channel(NEW.previous_method), NEW.previous_provider,
      NEW.business_date, 'refund', NEW.id, 'refund:' || NEW.id || ':reversal', NEW.requested_by, previous);
    PERFORM cl.ledger_post('sale_receipt', 'in', NEW.amount, cl.ledger_channel(NEW.method), NEW.transfer_provider,
      NEW.business_date, 'refund', NEW.id, 'refund:' || NEW.id, NEW.requested_by);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER refunds_ledger AFTER INSERT ON cl.refunds
  FOR EACH ROW EXECUTE FUNCTION cl.ledger_on_refund();

-- ---------------------------------------------------------------- the cash shift (FINANCE_REPORTING.md §5)

-- Same columns as 0014. Cash refunds paid from the till now lower expected cash; a
-- correction moves its amount between cash sales and the card and transfer totals of the
-- shift it was made in (always the payment's own shift when cash is involved).
CREATE OR REPLACE VIEW cl.cash_shift_figures AS
SELECT s.id AS shift_id,
       s.opening_float,
       (coalesce(c.cash_sales, 0) + coalesce(r.to_cash, 0) - coalesce(r.from_cash, 0))::numeric(14,2) AS cash_sales,
       coalesce(c.cash_payments, 0)::int          AS cash_payments,
       coalesce(r.cash_refunds, 0)::numeric(14,2) AS cash_refunds,
       coalesce(m.paid_in, 0)::numeric(14,2)     AS paid_in,
       coalesce(m.paid_out, 0)::numeric(14,2)    AS paid_out,
       (s.opening_float + coalesce(c.cash_sales, 0) + coalesce(r.to_cash, 0) - coalesce(r.from_cash, 0)
          - coalesce(r.cash_refunds, 0) + coalesce(m.paid_in, 0) - coalesce(m.paid_out, 0))::numeric(14,2)
                                                  AS expected_cash,
       (coalesce(o.card, 0) + coalesce(w.card, 0))::numeric(14,2)           AS card,
       (coalesce(o.jazzcash, 0) + coalesce(w.jazzcash, 0))::numeric(14,2)   AS jazzcash,
       (coalesce(o.easypaisa, 0) + coalesce(w.easypaisa, 0))::numeric(14,2) AS easypaisa,
       (coalesce(o.bank, 0) + coalesce(w.bank, 0))::numeric(14,2)           AS bank
  FROM cl.cash_shifts s
  LEFT JOIN LATERAL (SELECT sum(p.amount) AS cash_sales, count(*) AS cash_payments
                       FROM cl.payments p WHERE p.cash_shift_id = s.id) c ON true
  LEFT JOIN LATERAL (SELECT sum(x.amount) FILTER (WHERE x.kind = 'refund' AND x.method = 'cash') AS cash_refunds,
                            sum(x.amount) FILTER (WHERE x.kind = 'method_correction' AND x.method = 'cash') AS to_cash,
                            sum(x.amount) FILTER (WHERE x.kind = 'method_correction' AND x.previous_method = 'cash') AS from_cash
                       FROM cl.refunds x WHERE x.cash_shift_id = s.id) r ON true
  LEFT JOIN LATERAL (SELECT sum(x.amount) FILTER (WHERE x.kind = 'paid_in') AS paid_in,
                            sum(x.amount) FILTER (WHERE x.kind = 'paid_out') AS paid_out
                       FROM cl.cash_movements x WHERE x.shift_id = s.id) m ON true
  LEFT JOIN LATERAL (SELECT sum(p.amount) FILTER (WHERE p.method = 'card_manual') AS card,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'jazzcash') AS jazzcash,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'easypaisa') AS easypaisa,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'bank') AS bank
                       FROM cl.payments p
                      WHERE p.method <> 'cash' AND p.created_at >= s.opened_at
                        AND (s.closed_at IS NULL OR p.created_at < s.closed_at)) o ON true
  -- Card and transfers refunded or corrected while the shift was open, signed.
  LEFT JOIN LATERAL (SELECT sum(y.signed) FILTER (WHERE y.method = 'card_manual') AS card,
                            sum(y.signed) FILTER (WHERE y.provider = 'jazzcash') AS jazzcash,
                            sum(y.signed) FILTER (WHERE y.provider = 'easypaisa') AS easypaisa,
                            sum(y.signed) FILTER (WHERE y.provider = 'bank') AS bank
                       FROM cl.refunds x
                       CROSS JOIN LATERAL (VALUES
                         (x.method, x.transfer_provider,
                          CASE x.kind WHEN 'refund' THEN -x.amount ELSE x.amount END),
                         (x.previous_method, x.previous_provider, -x.amount)) AS y(method, provider, signed)
                      WHERE y.method IS NOT NULL AND y.method <> 'cash'
                        AND x.created_at >= s.opened_at
                        AND (s.closed_at IS NULL OR x.created_at < s.closed_at)) w ON true;
