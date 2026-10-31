-- 0029 Scheduled e-mails (FINANCE_REPORTING.md §8; D-20; P6-4; Phase 6 step 6.6).
-- The owner's own mailbox sends the reports chosen in schedules. Each completed period of
-- a schedule is made once (a run, with its file), then one e-mail per recipient (a
-- delivery) waits in the queue until it is sent, retried with backoff while there is no
-- internet; the Message-ID is fixed when the delivery is queued and kept on every retry.

-- The mailbox is the owner's alone (RBAC.md: settings.mailbox, protected).
INSERT INTO cl.permissions (key, module, description, scope_kind, is_protected) VALUES
  ('settings.mailbox', 'settings', 'The shop''s mailbox for scheduled e-mails (address, app password)', 'none', true);
INSERT INTO cl.role_permission_policy (role_id, permission_key, policy)
SELECT r.id, 'settings.mailbox', 'forbidden' FROM cl.roles r
 WHERE r.key IN ('manager','waiter','cashier','inventory_clerk','kitchen');
INSERT INTO cl.role_permissions (role_id, permission_key, scope)
SELECT r.id, 'settings.mailbox', NULL FROM cl.roles r WHERE r.key = 'owner';

-- One row. The password is sealed with AES-256-GCM under a key kept in the protected config
-- folder (MAIL_KEY_FILE), so the database and its backups hold it only encrypted.
CREATE TABLE cl.mail_account (                                  -- (M)
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  host            text     NOT NULL CHECK (host ~ '^[A-Za-z0-9.-]{1,253}$'),
  port            int      NOT NULL CHECK (port BETWEEN 1 AND 65535),
  security        text     NOT NULL CHECK (security IN ('starttls','tls')),
  username        text     NOT NULL CHECK (length(username) BETWEEN 1 AND 254),
  from_address    text     NOT NULL CHECK (from_address ~ '^[^@\s<>",;]+@[^@\s<>",;]+$'),
  from_name       text     NOT NULL CHECK (length(from_name) BETWEEN 1 AND 80),
  password_sealed text     NOT NULL,
  updated_by      bigint   NOT NULL REFERENCES cl.users,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         int      NOT NULL DEFAULT 1
);
CREATE TRIGGER mail_account_touch BEFORE UPDATE ON cl.mail_account FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
GRANT UPDATE ON cl.mail_account TO cl_app;

CREATE TABLE cl.report_schedules (                              -- (M) D-20
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type  text   NOT NULL CHECK (report_type ~ '^[a-z-]{1,40}$'),  -- 'day-end' or a report key
  filters      jsonb  NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(filters) = 'object'),
  frequency    text   NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  send_at      time   NOT NULL CHECK (send_at >= '04:30'),             -- after the day ends (04:00)
  weekday      smallint CHECK (weekday BETWEEN 1 AND 7),               -- ISO: 1 = Monday
  recipients   text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  is_active    boolean NOT NULL DEFAULT true,
  created_by   bigint NOT NULL REFERENCES cl.users,
  starts_on    date   NOT NULL,                                        -- first period it covers
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int    NOT NULL DEFAULT 1,
  CHECK ((frequency = 'weekly') = (weekday IS NOT NULL)),
  CHECK (report_type <> 'day-end' OR frequency = 'daily')
);
CREATE TRIGGER report_schedules_touch BEFORE UPDATE ON cl.report_schedules FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
GRANT UPDATE ON cl.report_schedules TO cl_app;

-- A completed period of a schedule, made once (two workers: the unique key keeps one).
CREATE TABLE cl.report_runs (                                   -- (A) the file never changes
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id   bigint NOT NULL REFERENCES cl.report_schedules,
  report_type   text   NOT NULL,
  period_from   date   NOT NULL,
  period_to     date   NOT NULL CHECK (period_to >= period_from),
  status        text   NOT NULL CHECK (status IN ('ready','failed')),
  file_name     text,
  content_type  text,
  content       bytea,
  summary       text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, period_from, period_to),
  CHECK ((status = 'ready') = (content IS NOT NULL AND file_name IS NOT NULL)),
  CHECK (status = 'ready' OR error IS NOT NULL)
);
CREATE TRIGGER report_runs_append_only BEFORE UPDATE OR DELETE ON cl.report_runs
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- One e-mail per recipient; delivery is at-least-once (FINANCE_REPORTING.md §8).
CREATE TABLE cl.report_deliveries (                             -- (M)
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id           bigint NOT NULL REFERENCES cl.report_runs,
  recipient        text   NOT NULL,
  message_id       text   NOT NULL UNIQUE,                       -- kept on every retry (AT-104)
  status           text   NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts         int    NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int    NOT NULL DEFAULT 1,
  UNIQUE (run_id, recipient),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status <> 'sending' OR claimed_at IS NOT NULL)
);
CREATE INDEX report_deliveries_due_idx ON cl.report_deliveries (next_attempt_at)
  WHERE status IN ('queued','sending');
CREATE TRIGGER report_deliveries_touch BEFORE UPDATE ON cl.report_deliveries FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
GRANT UPDATE ON cl.report_deliveries TO cl_app;
