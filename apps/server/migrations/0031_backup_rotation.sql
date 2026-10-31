-- 0031 Base backups, drive rotation, verification and the off-site copy (BACKUP_RECOVERY.md
-- §1–§4; D-23; P7-2; Phase 7 step 7.2).

-- Which of the two rotating drives (A or B) a run wrote to, by the id the drive carries in
-- CoffeeLounge\drive.json; a base backup is made whenever a different drive is plugged in.
ALTER TABLE cl.backup_runs ADD COLUMN drive_id text CHECK (drive_id ~ '^[0-9a-f-]{36}$');
ALTER TABLE cl.backup_runs ADD COLUMN drive_label text;
-- The run an off-site copy or a test restore was made from.
ALTER TABLE cl.backup_runs ADD COLUMN source_run_id bigint REFERENCES cl.backup_runs;
-- A pruned backup: its file was removed by the retention rules, after a newer one was verified.
ALTER TABLE cl.backup_runs ADD COLUMN pruned_at timestamptz;
CREATE INDEX backup_runs_source_idx ON cl.backup_runs (source_run_id);

-- The owner's S3-compatible bucket for the daily off-site copy (P7-2). One row; the secret
-- access key is sealed (AES-256-GCM under MAIL_KEY_FILE), never returned to any screen.
CREATE TABLE cl.offsite_target (                                -- (M)
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  endpoint          text NOT NULL CHECK (endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
  region            text NOT NULL CHECK (region ~ '^[a-z0-9-]{1,40}$'),
  bucket            text NOT NULL CHECK (bucket ~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'),
  prefix            text NOT NULL DEFAULT 'coffee-lounge/' CHECK (prefix ~ '^[A-Za-z0-9._/-]{0,100}$'),
  access_key_id     text NOT NULL CHECK (length(access_key_id) BETWEEN 4 AND 128),
  secret_sealed     text NOT NULL,
  updated_by        bigint NOT NULL REFERENCES cl.users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1
);
CREATE TRIGGER offsite_target_touch BEFORE UPDATE ON cl.offsite_target FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
GRANT UPDATE ON cl.offsite_target TO cl_app;
