-- 0004 Identity support tables (step 2.4). Additions to DATABASE.md §3, recorded in §15.

-- One-time codes for registering a device (API.md §4). Only a hash of the code is kept.
CREATE TABLE cl.device_registration_codes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash   bytea  NOT NULL UNIQUE,
  device_name text   NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 60),
  kind        text   NOT NULL CHECK (kind IN ('waiter','reception','manager','inventory','kitchen')),
  ownership   text   NOT NULL CHECK (ownership IN ('shop','personal')),
  created_by  bigint REFERENCES cl.users,                   -- NULL = created by the admin CLI (installer)
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  device_id   bigint REFERENCES cl.devices,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((used_at IS NULL) = (device_id IS NULL))
);
CREATE INDEX device_registration_codes_created_by_idx ON cl.device_registration_codes (created_by);
CREATE INDEX device_registration_codes_device_idx ON cl.device_registration_codes (device_id);

-- A step-up approval may be used once (RBAC.md §1.4). step_up_approvals is append-only,
-- so use is recorded here; the primary key makes a second use impossible.
CREATE TABLE cl.step_up_uses (
  step_up_id bigint PRIMARY KEY REFERENCES cl.step_up_approvals,
  used_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER step_up_uses_append_only BEFORE UPDATE OR DELETE ON cl.step_up_uses
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- Owner recovery code (SECURITY.md §2.2): argon2id hash of a printed one-time code.
CREATE TABLE cl.owner_recovery_codes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash  text   NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX owner_recovery_one_active ON cl.owner_recovery_codes ((true)) WHERE used_at IS NULL;

GRANT UPDATE ON cl.device_registration_codes, cl.owner_recovery_codes TO cl_app;
-- Reports and diagnostics have no business reading recovery hashes.
REVOKE SELECT ON cl.owner_recovery_codes FROM cl_readonly;
