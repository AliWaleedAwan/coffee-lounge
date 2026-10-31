-- 0028 The day-end report (FINANCE_REPORTING.md §7; P6-9; Phase 6 step 6.5).
-- One fixed report per completed business date, made by the worker after the 04:00 cutoff
-- (or on first request if the worker missed it) and never changed afterwards, so the
-- screen, the PDF, the 80 mm print and the e-mail show the same numbers. It lives in the
-- database, so the nightly backups keep it.

CREATE TABLE cl.day_end_reports (                               -- (A)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_date  date   NOT NULL UNIQUE,
  data           jsonb  NOT NULL,
  generated_by   text   NOT NULL CHECK (generated_by IN ('worker','on_request')),
  generated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER day_end_reports_append_only BEFORE UPDATE OR DELETE ON cl.day_end_reports
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- The 80 mm day-end summary goes through the existing print queue.
ALTER TABLE cl.print_jobs DROP CONSTRAINT print_jobs_document_type_check;
ALTER TABLE cl.print_jobs ADD CONSTRAINT print_jobs_document_type_check
  CHECK (document_type IN ('kitchen_ticket','receipt','refund_slip','shift_report','test_page','day_end'));
