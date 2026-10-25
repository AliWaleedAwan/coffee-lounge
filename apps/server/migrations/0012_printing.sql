-- 0012 Printers and print jobs (DATABASE.md §11; PRINTING_HARDWARE.md §5; Phase 3 step
-- 3.6). Deviations recorded in DATABASE.md §15: print_jobs also has `test_page` jobs,
-- `next_attempt_at` (retry backoff) and `claimed_at` (to tell a crashed send from a
-- slow one), plus the standard columns.

CREATE TABLE cl.printers (                                      -- (M) one Sonic SNC-101 at launch
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 60),
  connection      text NOT NULL CHECK (connection IN ('spooler','tcp')),
  address         text NOT NULL,                               -- Windows queue name, or host:port
  paper_width_mm  int  NOT NULL DEFAULT 80 CHECK (paper_width_mm IN (58,80)),
  chars_per_line  int  NOT NULL DEFAULT 48 CHECK (chars_per_line BETWEEN 24 and 64),
  code_page       text NOT NULL DEFAULT 'cp437' CHECK (code_page IN ('cp437')),
  supports_status boolean NOT NULL DEFAULT false,              -- real-time status (DLE EOT) over TCP
  can_cut         boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK (connection <> 'tcp' OR address ~ '^[A-Za-z0-9.-]+:[0-9]{1,5}$')
);

ALTER TABLE cl.stations ADD CONSTRAINT stations_printer_fk FOREIGN KEY (printer_id) REFERENCES cl.printers;
CREATE INDEX stations_printer_idx ON cl.stations (printer_id);

CREATE TABLE cl.print_jobs (                                    -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_key         text   NOT NULL UNIQUE,                      -- 'ticket:118:copy:1'
  printer_id      bigint NOT NULL REFERENCES cl.printers,
  document_type   text   NOT NULL CHECK (document_type IN ('kitchen_ticket','receipt','refund_slip','shift_report','test_page')),
  document_id     bigint NOT NULL,
  copy_no         int    NOT NULL DEFAULT 1 CHECK (copy_no > 0),
  is_reprint      boolean NOT NULL DEFAULT false,
  requested_by    bigint REFERENCES cl.users,
  status          text   NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','retrying','uncertain','needs_attention','cancelled')),
  attempts        int    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  next_attempt_at timestamptz,
  claimed_at      timestamptz,
  sent_at         timestamptz,
  resolved_by     bigint REFERENCES cl.users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int NOT NULL DEFAULT 1,
  CHECK (is_reprint = (copy_no > 1)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status <> 'sending' OR claimed_at IS NOT NULL),
  CHECK (status <> 'retrying' OR next_attempt_at IS NOT NULL)
);
CREATE INDEX print_jobs_open_idx ON cl.print_jobs (printer_id, id)
  WHERE status IN ('queued','sending','retrying','uncertain','needs_attention');
CREATE INDEX print_jobs_printer_idx ON cl.print_jobs (printer_id);
CREATE INDEX print_jobs_document_idx ON cl.print_jobs (document_type, document_id);
CREATE INDEX print_jobs_requested_by_idx ON cl.print_jobs (requested_by);
CREATE INDEX print_jobs_resolved_by_idx ON cl.print_jobs (resolved_by);

-- What a job prints never changes; only its delivery state moves. A sent or cancelled
-- job is final (a reprint is a new, labelled job).
CREATE FUNCTION cl.print_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_key <> OLD.job_key OR NEW.printer_id <> OLD.printer_id OR NEW.document_type <> OLD.document_type
     OR NEW.document_id <> OLD.document_id OR NEW.copy_no <> OLD.copy_no OR NEW.is_reprint <> OLD.is_reprint
     OR NEW.created_at <> OLD.created_at
     OR (OLD.status IN ('sent','cancelled') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'print job % cannot change that (status %)', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER print_jobs_guard BEFORE UPDATE ON cl.print_jobs
  FOR EACH ROW EXECUTE FUNCTION cl.print_job_guard();

CREATE TRIGGER printers_touch BEFORE UPDATE ON cl.printers FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER print_jobs_touch BEFORE UPDATE ON cl.print_jobs FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

GRANT UPDATE ON cl.printers, cl.print_jobs TO cl_app;
