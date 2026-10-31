-- 0030 Backup runs (BACKUP_RECOVERY.md §1, §4, §8; DATABASE.md §11; Phase 7 step 7.1).
-- One row per nightly dump (and, from step 7.2, base backup, off-site copy and test
-- restore): when it ran, where the encrypted file went, its size and checksum, whether it
-- was checked readable, and the error if it failed. The health page and the banner on every
-- device read the latest rows.

CREATE TABLE cl.backup_runs (                                   -- (M) a run's own row only
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text   NOT NULL CHECK (kind IN ('dump','base_backup','offsite_copy','restore_test')),
  status       text   NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  path         text,
  size_bytes   bigint CHECK (size_bytes >= 0),
  sha256       text   CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  files_copied int    CHECK (files_copied >= 0),
  verified_at  timestamptz,
  error        text,
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK (status <> 'failed' OR error IS NOT NULL),
  CHECK (status <> 'succeeded' OR (path IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL))
);
CREATE INDEX backup_runs_latest_idx ON cl.backup_runs (kind, started_at DESC);
GRANT UPDATE ON cl.backup_runs TO cl_app;

-- The nightly dump runs as the service login (the application role): pg_dump reads where
-- each id sequence stands. SELECT on a sequence reads it only; taking numbers stays as it was.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA cl TO cl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA cl GRANT SELECT ON SEQUENCES TO cl_app;
