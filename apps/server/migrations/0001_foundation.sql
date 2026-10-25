-- 0001 Foundation: shared definitions, identity & access, audit, infrastructure.
-- Source: docs/DATABASE.md §2, §3, §12. Forward-only; never edit after it has run.

CREATE SCHEMA cl;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- shared definitions
CREATE DOMAIN cl.amount      AS numeric(14,2);   -- PKR
CREATE DOMAIN cl.qty         AS numeric(18,4);   -- base units: g, ml, pcs
CREATE DOMAIN cl.unit_cost   AS numeric(20,8);   -- PKR per base unit
CREATE DOMAIN cl.stock_value AS numeric(18,4);   -- PKR, internal precision

CREATE FUNCTION cl.forbid_update_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% refused)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION cl.touch_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END $$;

-- Business date: shop-local date shifted back by the day cutoff (D-22).
-- Must agree with businessDate() in packages/shared (checked by tests).
CREATE FUNCTION cl.business_date(ts timestamptz, tz text, cutoff time)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT ((ts AT TIME ZONE tz) - cutoff::interval)::date
$$;

-- ---------------------------------------------------------------- identity & access
CREATE TABLE cl.users (                                        -- (M)
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username              text NOT NULL,
  display_name          text NOT NULL,
  password_hash         text NOT NULL,
  pin_hash              text,
  is_owner              boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX users_username_uq ON cl.users (lower(username));

-- At least one active owner must always exist once any user exists (RBAC.md §5).
CREATE FUNCTION cl.ensure_active_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cl.users)
     AND NOT EXISTS (SELECT 1 FROM cl.users WHERE is_owner AND status = 'active') THEN
    RAISE EXCEPTION 'at least one active owner must remain'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE cl.roles (                                        -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE cl.permissions (                                  -- seeded by migrations only
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module       text NOT NULL,
  description  text NOT NULL,
  scope_kind   text NOT NULL DEFAULT 'none'
               CHECK (scope_kind IN ('none','acceptance_scope','own_records','limit')),
  is_protected boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cl.role_permissions (
  role_id        bigint NOT NULL REFERENCES cl.roles,
  permission_key text   NOT NULL REFERENCES cl.permissions,
  scope          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX role_permissions_perm_idx ON cl.role_permissions (permission_key);

-- Grantability per role from RBAC.md: ○ = grantable (off by default), ✕ = never grantable.
-- Addition to DATABASE.md §3 (recorded there): lets the database refuse forbidden grants.
CREATE TABLE cl.role_permission_policy (
  role_id        bigint NOT NULL REFERENCES cl.roles,
  permission_key text   NOT NULL REFERENCES cl.permissions,
  policy         text   NOT NULL CHECK (policy IN ('grantable','forbidden')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_key)
);
CREATE INDEX role_permission_policy_perm_idx ON cl.role_permission_policy (permission_key);

-- Refuse role grants that RBAC.md forbids, and protected permissions on non-owner roles.
CREATE FUNCTION cl.check_role_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cl.role_permission_policy
             WHERE role_id = NEW.role_id AND permission_key = NEW.permission_key
               AND policy = 'forbidden') THEN
    RAISE EXCEPTION 'permission % may not be granted to this role', NEW.permission_key
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM cl.permissions WHERE key = NEW.permission_key AND is_protected)
     AND NOT EXISTS (SELECT 1 FROM cl.roles WHERE id = NEW.role_id AND key = 'owner') THEN
    RAISE EXCEPTION 'protected permission % is owner-only', NEW.permission_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER role_permissions_check BEFORE INSERT OR UPDATE ON cl.role_permissions
  FOR EACH ROW EXECUTE FUNCTION cl.check_role_grant();

CREATE TABLE cl.user_roles (
  user_id    bigint NOT NULL REFERENCES cl.users,
  role_id    bigint NOT NULL REFERENCES cl.roles,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_roles_role_idx ON cl.user_roles (role_id);

CREATE TABLE cl.user_permission_overrides (                    -- (M) deny wins over any grant
  user_id        bigint NOT NULL REFERENCES cl.users,
  permission_key text   NOT NULL REFERENCES cl.permissions,
  effect         text   NOT NULL CHECK (effect IN ('grant','deny')),
  reason         text   NOT NULL,
  granted_by     bigint NOT NULL REFERENCES cl.users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, permission_key)
);
CREATE INDEX user_permission_overrides_granted_by_idx ON cl.user_permission_overrides (granted_by);
CREATE INDEX user_permission_overrides_perm_idx ON cl.user_permission_overrides (permission_key);

-- A protected permission can only be granted to an owner user.
CREATE FUNCTION cl.check_user_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effect = 'grant'
     AND EXISTS (SELECT 1 FROM cl.permissions WHERE key = NEW.permission_key AND is_protected)
     AND NOT EXISTS (SELECT 1 FROM cl.users WHERE id = NEW.user_id AND is_owner) THEN
    RAISE EXCEPTION 'protected permission % is owner-only', NEW.permission_key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_permission_overrides_check BEFORE INSERT OR UPDATE ON cl.user_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION cl.check_user_override();

CREATE TABLE cl.role_discount_limits (                         -- (M)
  role_id     bigint PRIMARY KEY REFERENCES cl.roles,
  max_percent numeric(5,2) NOT NULL CHECK (max_percent BETWEEN 0 AND 100),
  max_amount  cl.amount    CHECK (max_amount >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE cl.devices (                                      -- (M)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text   NOT NULL,
  kind          text   NOT NULL CHECK (kind IN ('waiter','reception','manager','inventory','kitchen')),
  ownership     text   NOT NULL CHECK (ownership IN ('shop','personal')),
  token_hash    bytea  NOT NULL UNIQUE,
  status        text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  registered_by bigint NOT NULL REFERENCES cl.users,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    bigint REFERENCES cl.users,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX devices_registered_by_idx ON cl.devices (registered_by);
CREATE INDEX devices_revoked_by_idx ON cl.devices (revoked_by);

CREATE TABLE cl.auth_sessions (                                -- (M)
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash          bytea  NOT NULL UNIQUE,
  user_id             bigint NOT NULL REFERENCES cl.users,
  device_id           bigint NOT NULL REFERENCES cl.devices,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             int NOT NULL DEFAULT 1
);
CREATE INDEX auth_sessions_live_idx ON cl.auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_device_idx ON cl.auth_sessions (device_id);

CREATE TABLE cl.step_up_approvals (                            -- (A)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action       text   NOT NULL,
  requested_by bigint NOT NULL REFERENCES cl.users,
  approved_by  bigint NOT NULL REFERENCES cl.users,
  device_id    bigint NOT NULL REFERENCES cl.devices,
  entity_type  text   NOT NULL,
  entity_id    bigint NOT NULL,
  reason       text   NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by <> requested_by)
);
CREATE INDEX step_up_approvals_requested_by_idx ON cl.step_up_approvals (requested_by);
CREATE INDEX step_up_approvals_approved_by_idx ON cl.step_up_approvals (approved_by);
CREATE INDEX step_up_approvals_device_idx ON cl.step_up_approvals (device_id);

-- ---------------------------------------------------------------- settings, audit, infrastructure
CREATE TABLE cl.system_settings (                              -- (M) changes audited by the service
  key        text  PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES cl.users,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);

CREATE TABLE cl.document_counters (                            -- locked FOR UPDATE inside the business tx
  kind       text   NOT NULL,
  scope_key  text   NOT NULL,
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, scope_key)
);

CREATE TABLE cl.audit_events (                                 -- (A)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_kind     text   NOT NULL CHECK (actor_kind IN ('user','guest','system')),
  actor_user_id  bigint REFERENCES cl.users,
  device_id      bigint REFERENCES cl.devices,
  action         text   NOT NULL,
  entity_type    text   NOT NULL,
  entity_id      bigint,
  before         jsonb,
  after          jsonb,
  reason         text,
  approved_by    bigint REFERENCES cl.users,
  correlation_id uuid   NOT NULL,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);
CREATE INDEX audit_entity_idx ON cl.audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_actor_idx  ON cl.audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX audit_time_brin  ON cl.audit_events USING brin (occurred_at);
CREATE INDEX audit_device_idx ON cl.audit_events (device_id);
CREATE INDEX audit_approved_by_idx ON cl.audit_events (approved_by);

-- Inserted at the start of the business transaction and completed before COMMIT.
CREATE TABLE cl.idempotency_keys (
  scope           text  NOT NULL,
  key             uuid  NOT NULL,
  actor_ref       text  NOT NULL,
  request_hash    bytea NOT NULL,
  response_status int,
  response_body   jsonb,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_expiry_idx ON cl.idempotency_keys (expires_at);

CREATE TABLE cl.outbox_events (                                -- change hints for SSE; pruned after 24 h
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topics         text[] NOT NULL CHECK (cardinality(topics) > 0),
  event_type     text   NOT NULL,
  entity_type    text   NOT NULL,
  entity_id      bigint NOT NULL,
  entity_version int,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_created_idx ON cl.outbox_events (created_at);

-- ---------------------------------------------------------------- triggers
CREATE TRIGGER users_touch BEFORE UPDATE ON cl.users FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER roles_touch BEFORE UPDATE ON cl.roles FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER user_permission_overrides_touch BEFORE UPDATE ON cl.user_permission_overrides FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER role_discount_limits_touch BEFORE UPDATE ON cl.role_discount_limits FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER devices_touch BEFORE UPDATE ON cl.devices FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER auth_sessions_touch BEFORE UPDATE ON cl.auth_sessions FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER system_settings_touch BEFORE UPDATE ON cl.system_settings FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

CREATE TRIGGER users_active_owner AFTER INSERT OR UPDATE OR DELETE ON cl.users
  FOR EACH STATEMENT EXECUTE FUNCTION cl.ensure_active_owner();

CREATE TRIGGER step_up_approvals_append_only BEFORE UPDATE OR DELETE ON cl.step_up_approvals
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON cl.audit_events
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- ---------------------------------------------------------------- privileges (DATABASE.md §12)
-- cl_app: API and worker. cl_readonly: reports and diagnostics. Both NOLOGIN; the
-- installer creates the login roles that are members of them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_app') THEN
    CREATE ROLE cl_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cl_readonly') THEN
    CREATE ROLE cl_readonly NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA cl FROM PUBLIC;
GRANT USAGE ON SCHEMA cl TO cl_app, cl_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA cl TO cl_readonly;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA cl TO cl_app;
GRANT UPDATE ON cl.users, cl.roles, cl.user_permission_overrides, cl.role_discount_limits,
                cl.devices, cl.auth_sessions, cl.system_settings, cl.document_counters,
                cl.idempotency_keys
  TO cl_app;
-- Junction rows are revoked by deletion (audited by the service); expired keys and old hints are pruned.
GRANT DELETE ON cl.role_permissions, cl.user_roles, cl.user_permission_overrides,
                cl.idempotency_keys, cl.outbox_events
  TO cl_app;

-- Later migrations: new tables get SELECT/INSERT by default; UPDATE/DELETE are granted explicitly.
ALTER DEFAULT PRIVILEGES IN SCHEMA cl GRANT SELECT ON TABLES TO cl_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA cl GRANT SELECT, INSERT ON TABLES TO cl_app;
