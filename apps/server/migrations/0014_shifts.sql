-- 0014 Cash shift rules (DATABASE.md §9; FINANCE_REPORTING.md §5; RBAC.md §1.4; Phase 3
-- step 3.8). Deviations recorded in DATABASE.md §15: `closed_by` (a manager may close a
-- cashier's shift) and `approved_at`; CHECKs for the variance formula and its approval;
-- a guard that keeps a closed shift's count final; movements and cash payments only on
-- an open shift.

ALTER TABLE cl.cash_shifts
  ADD COLUMN closed_by   bigint REFERENCES cl.users,
  ADD COLUMN approved_at timestamptz,
  ADD CONSTRAINT shift_closed_by_set CHECK (status = 'open' OR closed_by IS NOT NULL),
  ADD CONSTRAINT shift_variance_formula CHECK (status = 'open' OR variance = counted_cash - expected_cash),
  ADD CONSTRAINT shift_variance_explained CHECK (status = 'open' OR variance = 0 OR length(variance_reason) >= 3),
  -- A shift that balances needs nobody's approval; any other is approved by a person.
  ADD CONSTRAINT shift_variance_approved CHECK (status <> 'approved' OR variance = 0 OR approved_by IS NOT NULL),
  ADD CONSTRAINT shift_approved_at_set CHECK ((status = 'approved') = (approved_at IS NOT NULL));
CREATE INDEX cash_shifts_closed_by_idx ON cl.cash_shifts (closed_by);

-- open → closed → approved, or open → approved; the count and the figures never change
-- once the shift is closed.
CREATE FUNCTION cl.cash_shift_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash shift % cannot be deleted', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.till_id <> OLD.till_id OR NEW.cashier_user_id <> OLD.cashier_user_id
     OR NEW.opened_at <> OLD.opened_at OR NEW.opening_float <> OLD.opening_float
     OR OLD.status = 'approved'
     OR (OLD.status = 'closed' AND (NEW.status <> 'approved'
         OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
         OR NEW.variance IS DISTINCT FROM OLD.variance OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
         OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
         OR NEW.variance_reason IS DISTINCT FROM OLD.variance_reason)) THEN
    RAISE EXCEPTION 'cash shift % cannot change that (status %)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_shifts_guard BEFORE UPDATE OR DELETE ON cl.cash_shifts
  FOR EACH ROW EXECUTE FUNCTION cl.cash_shift_guard();

-- Cash moves only through an open shift: paid-in/out and cash payments alike.
CREATE FUNCTION cl.needs_open_shift() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  shift bigint := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;   -- the row's shift column
BEGIN
  IF shift IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cl.cash_shifts WHERE id = shift AND status = 'open') THEN
    RAISE EXCEPTION 'cash shift % is not open', shift USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cash_movements_need_open_shift BEFORE INSERT ON cl.cash_movements
  FOR EACH ROW EXECUTE FUNCTION cl.needs_open_shift('shift_id');
CREATE TRIGGER payments_need_open_shift BEFORE INSERT ON cl.payments
  FOR EACH ROW EXECUTE FUNCTION cl.needs_open_shift('cash_shift_id');

-- FINANCE_REPORTING.md §5, defined once for the screen, the close and the printed report:
--   expected cash = opening float + cash payments − cash refunds + paid-in − paid-out
-- Cash refunds arrive with refunds in Phase 5 (0 until then); COD handed over in step 3.10.
-- Card and transfers taken while the shift was open are shown for checking against the
-- terminal slip and the bank and wallet apps; they are not cash in the till.
CREATE VIEW cl.cash_shift_figures AS
SELECT s.id AS shift_id,
       s.opening_float,
       coalesce(c.cash_sales, 0)::numeric(14,2)  AS cash_sales,
       coalesce(c.cash_payments, 0)::int          AS cash_payments,
       0::numeric(14,2)                           AS cash_refunds,
       coalesce(m.paid_in, 0)::numeric(14,2)     AS paid_in,
       coalesce(m.paid_out, 0)::numeric(14,2)    AS paid_out,
       (s.opening_float + coalesce(c.cash_sales, 0) + coalesce(m.paid_in, 0) - coalesce(m.paid_out, 0))::numeric(14,2)
                                                  AS expected_cash,
       coalesce(o.card, 0)::numeric(14,2)        AS card,
       coalesce(o.jazzcash, 0)::numeric(14,2)    AS jazzcash,
       coalesce(o.easypaisa, 0)::numeric(14,2)   AS easypaisa,
       coalesce(o.bank, 0)::numeric(14,2)        AS bank
  FROM cl.cash_shifts s
  LEFT JOIN LATERAL (SELECT sum(p.amount) AS cash_sales, count(*) AS cash_payments
                       FROM cl.payments p WHERE p.cash_shift_id = s.id) c ON true
  LEFT JOIN LATERAL (SELECT sum(x.amount) FILTER (WHERE x.kind = 'paid_in') AS paid_in,
                            sum(x.amount) FILTER (WHERE x.kind = 'paid_out') AS paid_out
                       FROM cl.cash_movements x WHERE x.shift_id = s.id) m ON true
  LEFT JOIN LATERAL (SELECT sum(p.amount) FILTER (WHERE p.method = 'card_manual') AS card,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'jazzcash') AS jazzcash,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'easypaisa') AS easypaisa,
                            sum(p.amount) FILTER (WHERE p.transfer_provider = 'bank') AS bank
                       FROM cl.payments p
                      WHERE p.method <> 'cash' AND p.created_at >= s.opened_at
                        AND (s.closed_at IS NULL OR p.created_at < s.closed_at)) o ON true;
GRANT SELECT ON cl.cash_shift_figures TO cl_app, cl_readonly;
