# Coffee Lounge — Database Design (Phase 1, package 1A)

> **Design specification, not a migration.** Status: draft for review R1. The SQL below is the reviewed source for the Phase 2 migrations; it has not been executed. Target: PostgreSQL 17 on Windows. Decisions referenced: [DECISIONS.md](DECISIONS.md). Items marked **PROVISIONAL** depend on a provisional default.

## 1. Conventions

| Topic | Rule |
|---|---|
| Schema | All application tables live in schema `cl`. The job queue library uses its own schema. |
| Keys | `bigint GENERATED ALWAYS AS IDENTITY`. Customer-facing tokens are 128-bit random values stored as SHA-256 hashes (`bytea`). |
| Enumerations | `text` + `CHECK (… IN (…))`, not PostgreSQL enum types (simpler, reviewable migrations). |
| Money / quantities | Domains below. Never `float`/`real`. Node reads NUMERIC as strings into `decimal.js`. |
| Time | `timestamptz` everywhere; `business_date date` is written by the service using `cl.business_date()` with the shop timezone and cutoff in force at write time. It is never recomputed. |
| Standard columns | Every table has `created_at timestamptz NOT NULL DEFAULT now()`. Tables marked **(M)** (mutable) also have `updated_at timestamptz NOT NULL DEFAULT now()` and `version int NOT NULL DEFAULT 1`, maintained by the `cl.touch_row` trigger. These columns are not repeated in the listings below. |
| Append-only | Tables marked **(A)** get the `cl.forbid_update_delete` trigger, and the app role has no `UPDATE`/`DELETE` on them. Corrections are new rows. |
| Draft-then-frozen | Tables marked **(D)** are editable while their parent is a draft and frozen by trigger once the parent is posted/active/settled. |
| Foreign keys | Every FK column is indexed (not repeated below unless it's part of a composite or partial index). `ON DELETE` is always the default `NO ACTION`: nothing cascades. |

## 2. Shared definitions

```sql
CREATE SCHEMA cl;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

-- Business date: shop-local date, shifted back by the day cutoff (D-22: 04:00).
CREATE FUNCTION cl.business_date(ts timestamptz, tz text, cutoff time)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT ((ts AT TIME ZONE tz) - cutoff::interval)::date
$$;
```

## 3. Identity, access, audit, infrastructure

```sql
CREATE TABLE cl.users (                                        -- (M)
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username              text NOT NULL,
  display_name          text NOT NULL,
  password_hash         text NOT NULL,                         -- argon2id
  pin_hash              text,                                  -- argon2id; quick-switch on registered devices only
  is_owner              boolean NOT NULL DEFAULT false,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_attempts       int NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until          timestamptz,
  last_login_at         timestamptz
);
CREATE UNIQUE INDEX users_username_uq ON cl.users (lower(username));
-- Trigger cl.ensure_active_owner (statement-level): at least one active is_owner user must remain.

CREATE TABLE cl.roles (                                        -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,                            -- owner, manager, waiter, cashier, inventory_clerk, kitchen
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  description text
);

CREATE TABLE cl.permissions (                                  -- seeded by migrations only
  key          text PRIMARY KEY CHECK (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  module       text NOT NULL,
  description  text NOT NULL,
  scope_kind   text NOT NULL DEFAULT 'none'
               CHECK (scope_kind IN ('none','acceptance_scope','own_records','limit')),
  is_protected boolean NOT NULL DEFAULT false                  -- owner-only, never delegable
);

CREATE TABLE cl.role_permissions (
  role_id        bigint NOT NULL REFERENCES cl.roles,
  permission_key text   NOT NULL REFERENCES cl.permissions,
  scope          jsonb,                                        -- e.g. {"acceptance":"assigned_tables"}
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE cl.user_roles (
  user_id bigint NOT NULL REFERENCES cl.users,
  role_id bigint NOT NULL REFERENCES cl.roles,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE cl.user_permission_overrides (                    -- (M) deny wins over any grant
  user_id        bigint NOT NULL REFERENCES cl.users,
  permission_key text   NOT NULL REFERENCES cl.permissions,
  effect         text   NOT NULL CHECK (effect IN ('grant','deny')),
  reason         text   NOT NULL,
  granted_by     bigint NOT NULL REFERENCES cl.users,
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE cl.role_discount_limits (                         -- (M) PROVISIONAL D-14
  role_id     bigint PRIMARY KEY REFERENCES cl.roles,
  max_percent numeric(5,2) NOT NULL CHECK (max_percent BETWEEN 0 AND 100),
  max_amount  cl.amount    CHECK (max_amount >= 0)
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
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE cl.auth_sessions (                                -- (M)
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash          bytea  NOT NULL UNIQUE,
  user_id             bigint NOT NULL REFERENCES cl.users,
  device_id           bigint NOT NULL REFERENCES cl.devices,
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoke_reason       text
);
CREATE INDEX auth_sessions_live_idx ON cl.auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE cl.step_up_approvals (                            -- (A)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action       text   NOT NULL,                                -- e.g. 'discount.over_limit', 'refund.approve'
  requested_by bigint NOT NULL REFERENCES cl.users,
  approved_by  bigint NOT NULL REFERENCES cl.users,
  device_id    bigint NOT NULL REFERENCES cl.devices,
  entity_type  text   NOT NULL,
  entity_id    bigint NOT NULL,
  reason       text   NOT NULL,
  CHECK (approved_by <> requested_by)
);

CREATE TABLE cl.system_settings (                              -- (M) every change audited
  key        text  PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by bigint REFERENCES cl.users
);

CREATE TABLE cl.document_counters (                            -- locked FOR UPDATE inside the business tx
  kind       text   NOT NULL,                                  -- invoice, round, ticket, refund, grn, count, expense, ledger, session
  scope_key  text   NOT NULL,                                  -- e.g. '2026' or '2026-10-19'
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
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
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);
CREATE INDEX audit_entity_idx ON cl.audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_actor_idx  ON cl.audit_events (actor_user_id, occurred_at DESC);
CREATE INDEX audit_time_brin  ON cl.audit_events USING brin (occurred_at);

-- Idempotency: the row is inserted at the START of the business transaction and completed
-- before COMMIT, so outside readers only ever see completed rows. A concurrent duplicate
-- blocks on the primary key until the first transaction ends, then replays its stored response.
CREATE TABLE cl.idempotency_keys (
  scope           text  NOT NULL,                              -- e.g. 'round.submit', 'payment.create'
  key             uuid  NOT NULL,
  actor_ref       text  NOT NULL,                              -- 'user:12' | 'guest:845'
  request_hash    bytea NOT NULL,                              -- same key + different payload → 409
  response_status int,
  response_body   jsonb,
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_expiry_idx ON cl.idempotency_keys (expires_at);

CREATE TABLE cl.outbox_events (                                -- change hints for SSE; pruned after 24 h
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- = SSE event id
  topics         text[] NOT NULL,                             -- e.g. {'approvals','table:5','session:812'}
  event_type     text   NOT NULL,
  entity_type    text   NOT NULL,
  entity_id      bigint NOT NULL,
  entity_version int
);
```

## 4. Menu, pricing, promotions

```sql
CREATE TABLE cl.menu_categories (                              -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  sort        int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  archived_at timestamptz
);

CREATE TABLE cl.menu_items (                                   -- (M)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id    bigint NOT NULL REFERENCES cl.menu_categories,
  name           text   NOT NULL,
  description    text,
  image_path     text,
  station_id     bigint,                                      -- FK added after cl.stations
  allow_dine_in  boolean NOT NULL DEFAULT true,
  allow_takeaway boolean NOT NULL DEFAULT true,
  allow_delivery boolean NOT NULL DEFAULT true,
  dietary_tags   text[]  NOT NULL DEFAULT '{}',               -- MENU-008: shown exactly as entered, never inferred
  sort           int     NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  archived_at    timestamptz,
  CHECK (allow_dine_in OR allow_takeaway OR allow_delivery)
);
CREATE INDEX menu_items_name_trgm ON cl.menu_items USING gin (name gin_trgm_ops);

CREATE TABLE cl.menu_variants (                                -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     bigint    NOT NULL REFERENCES cl.menu_items,
  name        text      NOT NULL,                             -- 'Regular', 'Large'
  price       cl.amount NOT NULL CHECK (price >= 0),
  stock_mode  text      NOT NULL DEFAULT 'untracked'
              CHECK (stock_mode IN ('untracked','recipe')),   -- D-29: 'recipe' only once an active recipe exists (service rule)
  is_default  boolean   NOT NULL DEFAULT false,
  sort        int       NOT NULL DEFAULT 0,
  is_active   boolean   NOT NULL DEFAULT true,
  archived_at timestamptz,
  UNIQUE (item_id, name)
);
CREATE UNIQUE INDEX menu_variants_one_default ON cl.menu_variants (item_id) WHERE is_default;

CREATE TABLE cl.menu_variant_price_history (                   -- (A)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id bigint    NOT NULL REFERENCES cl.menu_variants,
  old_price  cl.amount,
  new_price  cl.amount NOT NULL,
  changed_by bigint    NOT NULL REFERENCES cl.users,
  reason     text
);

CREATE TABLE cl.modifier_groups (                              -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  min_select int  NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select int  NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  is_active  boolean NOT NULL DEFAULT true,
  CHECK (min_select <= max_select)
);

CREATE TABLE cl.modifier_options (                             -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    bigint    NOT NULL REFERENCES cl.modifier_groups,
  name        text      NOT NULL,
  price_delta cl.amount NOT NULL DEFAULT 0 CHECK (price_delta >= 0),
  sort        int       NOT NULL DEFAULT 0,
  is_active   boolean   NOT NULL DEFAULT true
);

CREATE TABLE cl.menu_item_modifier_groups (
  item_id  bigint NOT NULL REFERENCES cl.menu_items,
  group_id bigint NOT NULL REFERENCES cl.modifier_groups,
  sort     int    NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, group_id)
);

CREATE TABLE cl.promotions (                                   -- (M) PROVISIONAL D-14: no stacking, best single promotion per line
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('percent','fixed')),
  value        numeric(14,2) NOT NULL CHECK (value > 0),
  starts_on    date NOT NULL,
  ends_on      date,
  days_of_week smallint[],                                    -- ISO 1..7; NULL = every day
  time_from    time,
  time_to      time,
  is_active    boolean NOT NULL DEFAULT true,
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((time_from IS NULL) = (time_to IS NULL))
);

CREATE TABLE cl.promotion_targets (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id  bigint NOT NULL REFERENCES cl.promotions,
  menu_item_id  bigint REFERENCES cl.menu_items,
  category_id   bigint REFERENCES cl.menu_categories,
  CHECK (num_nonnulls(menu_item_id, category_id) = 1)
);
```

## 5. Inventory, recipes, purchasing

```sql
CREATE TABLE cl.uoms (
  code           text PRIMARY KEY,                            -- g, kg, ml, l, pcs
  dimension      text NOT NULL CHECK (dimension IN ('mass','volume','count')),
  base_code      text NOT NULL REFERENCES cl.uoms,            -- g | ml | pcs
  factor_to_base numeric(18,6) NOT NULL CHECK (factor_to_base > 0)
);
-- Conversions only within a dimension; no g↔ml density conversion exists (MENU-007).

CREATE TABLE cl.inventory_items (                              -- (M)
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku                  text NOT NULL UNIQUE,
  name                 text NOT NULL,
  category             text,
  base_uom             text NOT NULL REFERENCES cl.uoms CHECK (base_uom IN ('g','ml','pcs')),
  track_lots           boolean NOT NULL DEFAULT false,
  track_expiry         boolean NOT NULL DEFAULT false,
  low_threshold        cl.qty CHECK (low_threshold >= 0),
  overstock_threshold  cl.qty CHECK (overstock_threshold >= 0),
  near_expiry_days     int    CHECK (near_expiry_days >= 0),
  stock_control_active boolean NOT NULL DEFAULT false,        -- D-29: switched on after its opening count
  is_active            boolean NOT NULL DEFAULT true,
  archived_at          timestamptz,
  CHECK (NOT track_expiry OR track_lots)
);
CREATE INDEX inventory_items_name_trgm ON cl.inventory_items USING gin (name gin_trgm_ops);

CREATE TABLE cl.item_pack_sizes (                              -- (M)
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id   bigint NOT NULL REFERENCES cl.inventory_items,
  name      text   NOT NULL,                                  -- '1 L carton', '1 kg bag'
  qty_base  cl.qty NOT NULL CHECK (qty_base > 0),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE cl.barcodes (                                     -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text   NOT NULL,
  item_id      bigint NOT NULL REFERENCES cl.inventory_items,
  pack_size_id bigint REFERENCES cl.item_pack_sizes,
  is_active    boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX barcodes_active_code_uq ON cl.barcodes (code) WHERE is_active;

-- Projection maintained in the same transaction as every movement/reservation.
-- The row lock on this table serialises all stock operations per item.
CREATE TABLE cl.inventory_balances (                           -- (M)
  item_id         bigint PRIMARY KEY REFERENCES cl.inventory_items,
  on_hand         cl.qty         NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved        cl.qty         NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  inventory_value cl.stock_value NOT NULL DEFAULT 0 CHECK (inventory_value >= 0),
  avg_unit_cost   cl.unit_cost GENERATED ALWAYS AS
                  (CASE WHEN on_hand > 0 THEN round(inventory_value / on_hand, 8) END) STORED,
  last_unit_cost  cl.unit_cost,                               -- kept when on_hand = 0; values found stock (COST_VALUATION §5)
  CHECK (on_hand > 0 OR inventory_value = 0)                  -- guaranteed by the drain rule (COST_VALUATION §4)
);
-- available = on_hand − reserved; may be negative only after a count shortfall (D-18), which raises an alert.

CREATE TABLE cl.suppliers (                                    -- (M)
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL,
  phone     text,
  email     text,
  address   text,
  notes     text,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE cl.purchase_receipts (                            -- (M) lines frozen once posted
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no           text UNIQUE,                           -- 'GRN-2026-00042', assigned at posting
  supplier_id          bigint REFERENCES cl.suppliers,
  supplier_invoice_ref text,
  received_at          timestamptz NOT NULL,
  business_date        date,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','reversed')),
  total_cost           cl.amount,
  paid_now             boolean NOT NULL DEFAULT false,
  payment_channel      text CHECK (payment_channel IN ('cash','card','transfer')),
  posted_by            bigint REFERENCES cl.users,
  posted_at            timestamptz,
  reversed_by          bigint REFERENCES cl.users,
  reversal_reason      text,
  CHECK (status = 'draft' OR (receipt_no IS NOT NULL AND posted_at IS NOT NULL AND business_date IS NOT NULL)),
  CHECK (NOT paid_now OR payment_channel IS NOT NULL)
);

CREATE TABLE cl.purchase_receipt_lines (                       -- (D)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id     bigint NOT NULL REFERENCES cl.purchase_receipts,
  item_id        bigint NOT NULL REFERENCES cl.inventory_items,
  pack_size_id   bigint REFERENCES cl.item_pack_sizes,
  pack_qty       numeric(12,3) CHECK (pack_qty > 0),
  qty_base       cl.qty       NOT NULL CHECK (qty_base > 0),
  line_cost      cl.amount    NOT NULL CHECK (line_cost >= 0),
  unit_cost_base cl.unit_cost NOT NULL,                       -- = round(line_cost / qty_base, 8)
  lot_code       text,
  expiry_date    date
);

CREATE TABLE cl.inventory_lots (                               -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES cl.inventory_items,
  lot_code        text,
  received_at     timestamptz NOT NULL,
  expiry_date     date,
  qty_received    cl.qty NOT NULL CHECK (qty_received >= 0),
  qty_remaining   cl.qty NOT NULL CHECK (qty_remaining >= 0),
  receipt_line_id bigint REFERENCES cl.purchase_receipt_lines,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','depleted'))
);
CREATE INDEX lots_fefo_idx ON cl.inventory_lots (item_id, expiry_date NULLS LAST, received_at, id)
  WHERE qty_remaining > 0 AND status = 'active';

CREATE TABLE cl.recipe_versions (                              -- (M) components frozen once active
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id        bigint NOT NULL REFERENCES cl.menu_variants,
  version_no        int    NOT NULL CHECK (version_no > 0),
  status            text   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  prep_instructions text,
  activated_by      bigint REFERENCES cl.users,
  activated_at      timestamptz,
  retired_at        timestamptz,
  UNIQUE (variant_id, version_no),
  CHECK (status = 'draft' OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX recipe_one_active ON cl.recipe_versions (variant_id) WHERE status = 'active';

CREATE TABLE cl.recipe_components (                            -- (D) editable only while version is draft
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_version_id bigint NOT NULL REFERENCES cl.recipe_versions,
  inventory_item_id bigint NOT NULL REFERENCES cl.inventory_items,
  qty_base          cl.qty NOT NULL CHECK (qty_base > 0),
  waste_factor      numeric(6,4) NOT NULL DEFAULT 0 CHECK (waste_factor >= 0 AND waste_factor < 1),
  for_dine_in       boolean NOT NULL DEFAULT true,
  for_takeaway      boolean NOT NULL DEFAULT true,            -- e.g. cup + lid: takeaway/delivery only
  for_delivery      boolean NOT NULL DEFAULT true,
  CHECK (for_dine_in OR for_takeaway OR for_delivery)
);

CREATE TABLE cl.modifier_recipe_rules (                        -- (M) effective-dated; accepted lines snapshot results
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  modifier_option_id  bigint NOT NULL REFERENCES cl.modifier_options,
  variant_id          bigint REFERENCES cl.menu_variants,     -- NULL = applies to every variant of the item
  action              text   NOT NULL CHECK (action IN ('add','remove','replace','scale')),
  inventory_item_id   bigint NOT NULL REFERENCES cl.inventory_items,
  replacement_item_id bigint REFERENCES cl.inventory_items,
  qty_base            cl.qty,
  scale_factor        numeric(8,4),
  effective_from      timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz,
  CHECK (action <> 'add'     OR (qty_base > 0 AND replacement_item_id IS NULL)),
  CHECK (action <> 'replace' OR replacement_item_id IS NOT NULL),
  CHECK (action <> 'scale'   OR scale_factor > 0)
);
```

## 6. Tables, sessions, guests, riders

```sql
CREATE TABLE cl.dining_tables (                                -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text NOT NULL UNIQUE,                          -- 'T05'
  name         text NOT NULL,
  area         text,
  seats        int  CHECK (seats > 0),
  layout_x     int,
  layout_y     int,
  availability text NOT NULL DEFAULT 'active' CHECK (availability IN ('active','blocked','maintenance')),
  sort         int  NOT NULL DEFAULT 0,
  archived_at  timestamptz
);

CREATE TABLE cl.qr_entry_points (                              -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text  NOT NULL CHECK (kind IN ('table','counter_takeaway')),
  table_id   bigint REFERENCES cl.dining_tables,
  label      text  NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  is_active  boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  CHECK ((kind = 'table') = (table_id IS NOT NULL))
);
CREATE UNIQUE INDEX qr_one_active_per_table ON cl.qr_entry_points (table_id) WHERE is_active AND kind = 'table';

CREATE TABLE cl.table_assignments (                            -- D-07
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id    bigint NOT NULL REFERENCES cl.dining_tables,
  user_id     bigint NOT NULL REFERENCES cl.users,
  assigned_by bigint NOT NULL REFERENCES cl.users,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  ended_by    bigint REFERENCES cl.users,
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
CREATE UNIQUE INDEX table_one_current_waiter ON cl.table_assignments (table_id) WHERE ended_at IS NULL;
CREATE INDEX table_assignments_user_idx ON cl.table_assignments (user_id) WHERE ended_at IS NULL;
-- Only ended_at/ended_by may change (trigger); rows are never deleted.

CREATE TABLE cl.staff_profiles (                               -- (M) riders: no login needed (D-41)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('rider')),
  phone        text,
  user_id      bigint REFERENCES cl.users,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE cl.dining_sessions (                              -- (M) one per visit/order, all order types
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_no            text NOT NULL UNIQUE,                 -- 'S-20261019-0031'
  order_type            text NOT NULL CHECK (order_type IN ('dine_in','takeaway','delivery')),
  table_id              bigint REFERENCES cl.dining_tables,
  entry_point_id        bigint REFERENCES cl.qr_entry_points,
  status                text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','checkout_requested','checkout_locked','settled','cancelled')),
  guest_count           int CHECK (guest_count > 0),
  customer_name         text,                                 -- all optional (D-05)
  customer_phone        text,
  customer_email        text,
  opened_via            text NOT NULL CHECK (opened_via IN ('qr','staff')),
  opened_by_user_id     bigint REFERENCES cl.users,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  checkout_requested_at timestamptz,
  locked_at             timestamptz,
  closed_at             timestamptz,
  close_reason          text,
  business_date         date NOT NULL,                        -- business date of opening
  pii_redacted_at       timestamptz,                          -- D-25
  CHECK ((order_type = 'dine_in') = (table_id IS NOT NULL)),
  CHECK ((status IN ('settled','cancelled')) = (closed_at IS NOT NULL)),
  CHECK ((opened_via = 'staff') = (opened_by_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX session_one_active_per_table ON cl.dining_sessions (table_id)
  WHERE status IN ('open','checkout_requested','checkout_locked');
CREATE INDEX sessions_active_idx ON cl.dining_sessions (status, opened_at)
  WHERE status IN ('open','checkout_requested','checkout_locked');

CREATE TABLE cl.session_table_moves (                          -- (A) D-10 transfer
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id    bigint NOT NULL REFERENCES cl.dining_sessions,
  from_table_id bigint NOT NULL REFERENCES cl.dining_tables,
  to_table_id   bigint NOT NULL REFERENCES cl.dining_tables,
  moved_by      bigint NOT NULL REFERENCES cl.users,
  reason        text,
  CHECK (from_table_id <> to_table_id)
);

CREATE TABLE cl.session_guest_tokens (                         -- (M)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint NOT NULL REFERENCES cl.dining_sessions,
  entry_point_id bigint NOT NULL REFERENCES cl.qr_entry_points,
  token_hash     bytea  NOT NULL UNIQUE,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  revoke_reason  text CHECK (revoke_reason IN ('session_closed','staff_reset','expired'))
);
CREATE INDEX guest_tokens_live_idx ON cl.session_guest_tokens (session_id) WHERE revoked_at IS NULL;

CREATE TABLE cl.delivery_orders (                              -- (M) D-05
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint NOT NULL UNIQUE REFERENCES cl.dining_sessions,
  channel        text NOT NULL CHECK (channel IN ('phone','whatsapp','walk_in')),
  address        text,                                        -- optional (D-05)
  landmark       text,
  notes          text,
  payment_mode   text NOT NULL CHECK (payment_mode IN ('prepaid','cod_cash','card_on_delivery')),
  status         text NOT NULL DEFAULT 'pending_dispatch'
                 CHECK (status IN ('pending_dispatch','out_for_delivery','delivered','failed',
                                   'cancelled','converted_to_pickup')),
  rider_id       bigint REFERENCES cl.staff_profiles,
  dispatched_at  timestamptz,
  delivered_at   timestamptz,
  failed_at      timestamptz,
  failure_reason text,
  resolved_by    bigint REFERENCES cl.users,
  CHECK (status NOT IN ('out_for_delivery','delivered','failed') OR (rider_id IS NOT NULL AND dispatched_at IS NOT NULL)),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);
CREATE INDEX delivery_open_idx ON cl.delivery_orders (status)
  WHERE status IN ('pending_dispatch','out_for_delivery','failed');

CREATE TABLE cl.delivery_events (                              -- (A)
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_order_id bigint NOT NULL REFERENCES cl.delivery_orders,
  from_status       text,
  to_status         text   NOT NULL,
  actor_user_id     bigint NOT NULL REFERENCES cl.users,
  rider_id          bigint REFERENCES cl.staff_profiles,
  reason            text,
  event_key         text   NOT NULL UNIQUE,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
```

## 7. Orders and kitchen

```sql
CREATE TABLE cl.order_rounds (                                 -- (M) approval lifecycle only
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id                   bigint NOT NULL REFERENCES cl.dining_sessions,
  round_no                     int    NOT NULL CHECK (round_no > 0),     -- within session
  round_ref                    text   NOT NULL UNIQUE,                   -- 'R-1019-042' (daily counter)
  source                       text   NOT NULL CHECK (source IN ('qr','waiter','reception')),
  status                       text   NOT NULL
                               CHECK (status IN ('pending_approval','accepted','rejected','cancelled','expired')),
  submitted_at                 timestamptz NOT NULL DEFAULT now(),
  submitted_by_user_id         bigint REFERENCES cl.users,
  submitted_by_guest_token_id  bigint REFERENCES cl.session_guest_tokens,
  quoted_total                 cl.amount NOT NULL,
  after_bill_request           boolean NOT NULL DEFAULT false,           -- D-12 flag
  escalated_at                 timestamptz,                              -- D-36
  decided_at                   timestamptz,
  decided_by                   bigint REFERENCES cl.users,
  decision_reason              text,
  UNIQUE (session_id, round_no),
  CHECK (num_nonnulls(submitted_by_user_id, submitted_by_guest_token_id) = 1),
  CHECK ((source = 'qr') = (submitted_by_guest_token_id IS NOT NULL)),
  CHECK (status NOT IN ('accepted','rejected') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (status <> 'rejected' OR decision_reason IS NOT NULL)
);
CREATE INDEX rounds_pending_idx ON cl.order_rounds (submitted_at) WHERE status = 'pending_approval';

CREATE TABLE cl.order_lines (                                  -- (M) prices frozen once round accepted (trigger)
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id                 bigint NOT NULL REFERENCES cl.order_rounds,
  session_id               bigint NOT NULL REFERENCES cl.dining_sessions,
  line_no                  int    NOT NULL CHECK (line_no > 0),
  variant_id               bigint NOT NULL REFERENCES cl.menu_variants,
  item_name_snap           text   NOT NULL,
  variant_name_snap        text   NOT NULL,
  qty                      int    NOT NULL CHECK (qty > 0),
  notes                    text   CHECK (char_length(notes) <= 120),
  unit_price_quoted        cl.amount NOT NULL,                  -- what the guest/staff saw at submission
  catalog_unit_price       cl.amount,                           -- catalog price at acceptance
  unit_price               cl.amount,                           -- charged; = quoted if price lock applied (D-08)
  price_locked             boolean NOT NULL DEFAULT false,
  modifiers_unit_total     cl.amount NOT NULL DEFAULT 0,
  promotion_id             bigint REFERENCES cl.promotions,
  promotion_discount       cl.amount NOT NULL DEFAULT 0 CHECK (promotion_discount >= 0),
  line_gross               cl.amount,                           -- (unit_price + modifiers_unit_total) × qty
  stock_mode_snap          text CHECK (stock_mode_snap IN ('untracked','recipe')),
  recipe_version_id        bigint REFERENCES cl.recipe_versions,
  station_id               bigint,
  qty_picked_up            int NOT NULL DEFAULT 0,              -- = prepared = consumption (D-33)
  qty_served               int NOT NULL DEFAULT 0,              -- served / collected / dispatched
  qty_cancelled_unprepared int NOT NULL DEFAULT 0,              -- reservation released
  qty_cancelled_prepared   int NOT NULL DEFAULT 0,              -- consumed, classified as waste
  UNIQUE (round_id, line_no),
  CHECK (qty_picked_up >= 0 AND qty_served >= 0 AND qty_cancelled_unprepared >= 0 AND qty_cancelled_prepared >= 0),
  CHECK (qty_picked_up + qty_cancelled_unprepared <= qty),
  CHECK (qty_served <= qty_picked_up),
  CHECK (qty_cancelled_prepared <= qty_picked_up),               -- a served item may still be voided (spilled/refused)
  CHECK (unit_price IS NULL OR line_gross = (unit_price + modifiers_unit_total) * qty),
  CHECK (stock_mode_snap IS DISTINCT FROM 'recipe' OR recipe_version_id IS NOT NULL)
);
CREATE INDEX order_lines_session_idx ON cl.order_lines (session_id);
CREATE INDEX order_lines_open_idx ON cl.order_lines (round_id)
  WHERE qty_picked_up + qty_cancelled_unprepared < qty;            -- uncollected items (D-33 alert)

CREATE TABLE cl.order_line_modifiers (                         -- written with the line, frozen on acceptance
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id            bigint    NOT NULL REFERENCES cl.order_lines,
  modifier_option_id bigint    NOT NULL REFERENCES cl.modifier_options,
  name_snap          text      NOT NULL,
  price_delta_snap   cl.amount NOT NULL,
  qty                int       NOT NULL DEFAULT 1 CHECK (qty > 0)
);

CREATE TABLE cl.order_line_components (                        -- (A) frozen recipe explosion at acceptance
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  line_id           bigint NOT NULL REFERENCES cl.order_lines,
  inventory_item_id bigint NOT NULL REFERENCES cl.inventory_items,
  qty_per_unit      cl.qty NOT NULL CHECK (qty_per_unit > 0), -- includes waste factor and modifier rules
  UNIQUE (line_id, inventory_item_id)
);

CREATE TABLE cl.order_events (                                 -- (A) idempotency anchor for every transition
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id       bigint NOT NULL REFERENCES cl.order_rounds,
  line_id        bigint REFERENCES cl.order_lines,
  event_type     text   NOT NULL,                             -- see ORDER_STATE_MACHINE.md §8
  qty            int    CHECK (qty > 0),
  actor_kind     text   NOT NULL CHECK (actor_kind IN ('user','guest','system')),
  actor_user_id  bigint REFERENCES cl.users,
  reason         text,
  data           jsonb,
  event_key      text   NOT NULL UNIQUE,
  correlation_id uuid   NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_round_idx ON cl.order_events (round_id, occurred_at);

CREATE TABLE cl.stations (                                     -- (M) one 'Kitchen' station (D-26)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  printer_id bigint                                            -- FK added after cl.printers
);
ALTER TABLE cl.menu_items  ADD FOREIGN KEY (station_id) REFERENCES cl.stations;
ALTER TABLE cl.order_lines ADD FOREIGN KEY (station_id) REFERENCES cl.stations;

CREATE TABLE cl.ticket_templates (                             -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text  NOT NULL CHECK (kind IN ('kitchen','receipt','refund')),
  name       text  NOT NULL,
  definition jsonb NOT NULL,                                   -- kitchen schema has no price fields (validated)
  is_active  boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX ticket_template_one_active ON cl.ticket_templates (kind) WHERE is_active;

CREATE TABLE cl.kitchen_tickets (                              -- (M) status only; content immutable
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_no            text   NOT NULL UNIQUE,                -- 'K-1019-118'
  round_id             bigint NOT NULL REFERENCES cl.order_rounds,
  station_id           bigint NOT NULL REFERENCES cl.stations,
  kind                 text   NOT NULL CHECK (kind IN ('new','supplement','correction','void')),
  supersedes_ticket_id bigint REFERENCES cl.kitchen_tickets,
  template_id          bigint NOT NULL REFERENCES cl.ticket_templates,
  status               text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  CHECK ((kind IN ('correction','void')) = (supersedes_ticket_id IS NOT NULL))
);
CREATE UNIQUE INDEX ticket_one_original ON cl.kitchen_tickets (round_id, station_id)
  WHERE kind IN ('new','supplement');

CREATE TABLE cl.kitchen_ticket_lines (                         -- (A)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id     bigint NOT NULL REFERENCES cl.kitchen_tickets,
  order_line_id bigint NOT NULL REFERENCES cl.order_lines,
  qty           int    NOT NULL CHECK (qty > 0),
  display       jsonb  NOT NULL                               -- names, size, modifiers, notes — never prices
);
```

## 8. Stock reservations, movements, costs, counts, waste

```sql
CREATE TABLE cl.stock_reservations (                           -- (M) counters only move forward
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id bigint NOT NULL REFERENCES cl.order_lines,
  item_id       bigint NOT NULL REFERENCES cl.inventory_items,
  qty_reserved  cl.qty NOT NULL CHECK (qty_reserved > 0),
  qty_consumed  cl.qty NOT NULL DEFAULT 0 CHECK (qty_consumed >= 0),
  qty_released  cl.qty NOT NULL DEFAULT 0 CHECK (qty_released >= 0),
  status        text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  UNIQUE (order_line_id, item_id),
  CHECK (qty_consumed + qty_released <= qty_reserved),
  CHECK ((status = 'closed') = (qty_consumed + qty_released = qty_reserved))
);
CREATE INDEX reservations_active_idx ON cl.stock_reservations (item_id) WHERE status = 'active';

CREATE TABLE cl.stock_movements (                              -- (A) the stock ledger
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id             bigint NOT NULL REFERENCES cl.inventory_items,
  lot_id              bigint REFERENCES cl.inventory_lots,
  movement_type       text   NOT NULL CHECK (movement_type IN (
                        'opening','receipt','consumption','waste','count_adjustment',
                        'supplier_return','cost_adjustment','rounding','reversal')),
  qty_delta           cl.qty NOT NULL,                         -- signed, base unit
  unit_cost           cl.unit_cost,                            -- receipt: purchase cost; issues: average at posting
  value_delta         cl.stock_value NOT NULL,                 -- signed
  source_type         text   NOT NULL,                         -- 'order_line','purchase_receipt_line','stock_count_line',...
  source_id           bigint NOT NULL,
  source_key          text   NOT NULL UNIQUE,                  -- e.g. 'consume:evt:<event_key>:item:44:lot:7'
  reason_code         text,
  flags               text[] NOT NULL DEFAULT '{}',            -- 'expired_lot_used', 'manual_back_entry', 'auto_found_stock'
  reverses_movement_id bigint REFERENCES cl.stock_movements,
  actor_user_id       bigint REFERENCES cl.users,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  business_date       date   NOT NULL,
  note                text,
  CHECK (qty_delta <> 0 OR movement_type IN ('cost_adjustment','rounding')),
  CHECK (movement_type <> 'reversal' OR reverses_movement_id IS NOT NULL)
);
CREATE INDEX movements_item_time_idx ON cl.stock_movements (item_id, occurred_at);
CREATE INDEX movements_source_idx    ON cl.stock_movements (source_type, source_id);
CREATE INDEX movements_bdate_idx     ON cl.stock_movements (business_date);

CREATE TABLE cl.order_line_costs (                             -- (A) frozen actual COGS (WAC at consumption)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id bigint NOT NULL REFERENCES cl.order_lines,
  item_id       bigint NOT NULL REFERENCES cl.inventory_items,
  movement_id   bigint NOT NULL UNIQUE REFERENCES cl.stock_movements,
  qty_base      cl.qty NOT NULL CHECK (qty_base > 0),
  value         cl.stock_value NOT NULL CHECK (value >= 0)
);
CREATE INDEX line_costs_line_idx ON cl.order_line_costs (order_line_id);

CREATE TABLE cl.cost_adjustments (                             -- (A) supplier price corrections, current period
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id         bigint NOT NULL REFERENCES cl.inventory_items,
  receipt_line_id bigint NOT NULL REFERENCES cl.purchase_receipt_lines,
  amount          cl.amount NOT NULL,                          -- signed total correction
  to_inventory    cl.stock_value NOT NULL,
  to_variance     cl.stock_value NOT NULL,
  reason          text   NOT NULL,
  movement_id     bigint NOT NULL REFERENCES cl.stock_movements,
  actor_user_id   bigint NOT NULL REFERENCES cl.users,
  CHECK (to_inventory + to_variance = amount)
);

CREATE TABLE cl.stock_counts (                                 -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_no     text UNIQUE,
  kind         text NOT NULL DEFAULT 'periodic' CHECK (kind IN ('opening','periodic','spot')),
  status       text NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','submitted','approved','rejected','posted')),
  blind        boolean NOT NULL DEFAULT true,
  started_by   bigint NOT NULL REFERENCES cl.users,
  started_at   timestamptz NOT NULL DEFAULT now(),
  submitted_by bigint REFERENCES cl.users,
  approved_by  bigint REFERENCES cl.users,
  posted_at    timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> submitted_by)  -- D-18 segregation
);

CREATE TABLE cl.stock_count_lines (                            -- (D)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  count_id       bigint NOT NULL REFERENCES cl.stock_counts,
  item_id        bigint NOT NULL REFERENCES cl.inventory_items,
  lot_id         bigint REFERENCES cl.inventory_lots,
  book_qty_snap  cl.qty NOT NULL,
  counted_qty    cl.qty CHECK (counted_qty >= 0),
  unit_cost_snap cl.unit_cost,
  variance_qty   cl.qty,
  variance_value cl.stock_value,
  needs_approval boolean NOT NULL DEFAULT false,
  UNIQUE (count_id, item_id, lot_id)
);

CREATE TABLE cl.wastage_records (                              -- (A)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('ingredient','prepared_item','expired_lot','failed_delivery')),
  item_id       bigint REFERENCES cl.inventory_items,
  lot_id        bigint REFERENCES cl.inventory_lots,
  order_line_id bigint REFERENCES cl.order_lines,
  qty           numeric(18,4) NOT NULL CHECK (qty > 0),       -- base units, or sellable units for prepared items
  reason_code   text NOT NULL,
  cost_value    cl.stock_value NOT NULL CHECK (cost_value >= 0),
  movement_id   bigint REFERENCES cl.stock_movements,         -- set for ingredient/expired_lot; NULL for prepared items
  recorded_by   bigint NOT NULL REFERENCES cl.users,
  business_date date NOT NULL,
  note          text,
  CHECK ((kind IN ('prepared_item','failed_delivery')) = (order_line_id IS NOT NULL)),
  CHECK ((kind IN ('ingredient','expired_lot')) = (movement_id IS NOT NULL))
);

CREATE TABLE cl.inventory_alerts (                             -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     bigint REFERENCES cl.inventory_items,
  lot_id      bigint REFERENCES cl.inventory_lots,
  kind        text NOT NULL CHECK (kind IN ('low','zero','near_expiry','expired','overstock',
                                            'reservation_shortfall','stale_reservation','balance_mismatch')),
  state       text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  detail      jsonb,
  resolved_at timestamptz,
  resolved_by bigint REFERENCES cl.users
);
CREATE UNIQUE INDEX alerts_one_open ON cl.inventory_alerts (kind, item_id, lot_id) NULLS NOT DISTINCT
  WHERE state <> 'resolved';
```

## 9. Billing, payments, cash

```sql
CREATE TABLE cl.tills (                                        -- (M) logical till; one 'Counter' till (no drawer)
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE cl.cash_shifts (                                  -- (M)
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  till_id         bigint    NOT NULL REFERENCES cl.tills,
  cashier_user_id bigint    NOT NULL REFERENCES cl.users,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_float   cl.amount NOT NULL CHECK (opening_float >= 0),
  closed_at       timestamptz,
  counted_cash    cl.amount CHECK (counted_cash >= 0),
  expected_cash   cl.amount,
  variance        cl.amount,
  variance_reason text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','approved')),
  approved_by     bigint REFERENCES cl.users,
  CHECK (status = 'open' OR (closed_at IS NOT NULL AND counted_cash IS NOT NULL AND expected_cash IS NOT NULL)),
  CHECK (approved_by IS NULL OR approved_by <> cashier_user_id)
);
CREATE UNIQUE INDEX shift_one_open_per_till ON cl.cash_shifts (till_id) WHERE status = 'open';

CREATE TABLE cl.cash_movements (                               -- (A) paid-in / paid-out
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shift_id    bigint    NOT NULL REFERENCES cl.cash_shifts,
  kind        text      NOT NULL CHECK (kind IN ('paid_in','paid_out')),
  amount      cl.amount NOT NULL CHECK (amount > 0),
  reason      text      NOT NULL,
  actor       bigint    NOT NULL REFERENCES cl.users,
  approved_by bigint    REFERENCES cl.users
);

CREATE TABLE cl.invoices (                                     -- (M) frozen once settled (trigger)
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id          bigint NOT NULL UNIQUE REFERENCES cl.dining_sessions,   -- one bill per session
  invoice_no          text UNIQUE,                            -- 'INV-2026-000123', assigned at settlement
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','settled')),
  lock_version        int  NOT NULL DEFAULT 0,
  subtotal            cl.amount NOT NULL DEFAULT 0,           -- Σ line gross − promotion discounts
  discount_total      cl.amount NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total           cl.amount NOT NULL DEFAULT 0 CHECK (tax_total = 0),     -- DEC-13; changing needs a migration
  rounding_adjustment cl.amount NOT NULL DEFAULT 0,           -- PROVISIONAL D-16
  total               cl.amount NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid_total          cl.amount NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
  locked_at           timestamptz,
  locked_by           bigint REFERENCES cl.users,
  settled_at          timestamptz,
  settled_by          bigint REFERENCES cl.users,
  business_date       date,                                   -- settlement business date (D-21)
  CHECK (total = subtotal - discount_total + tax_total + rounding_adjustment),
  CHECK (paid_total <= total),
  CHECK (status <> 'settled' OR (invoice_no IS NOT NULL AND paid_total = total AND business_date IS NOT NULL))
);
CREATE INDEX invoices_unsettled_idx ON cl.invoices (status) WHERE status <> 'settled';
CREATE INDEX invoices_bdate_idx ON cl.invoices (business_date);

CREATE TABLE cl.invoice_lines (                                -- (D) rebuilt on lock, frozen on settlement
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id         bigint NOT NULL REFERENCES cl.invoices,
  order_line_id      bigint NOT NULL UNIQUE REFERENCES cl.order_lines,
  description_snap   text   NOT NULL,
  billable_qty       int    NOT NULL CHECK (billable_qty >= 0),
  unit_price         cl.amount NOT NULL,
  modifiers_unit_total cl.amount NOT NULL,
  gross              cl.amount NOT NULL,
  promotion_discount cl.amount NOT NULL DEFAULT 0,
  manual_discount    cl.amount NOT NULL DEFAULT 0,
  discount_alloc     cl.amount NOT NULL DEFAULT 0,            -- pro-rata share of bill-level discounts (D-21)
  net                cl.amount NOT NULL,
  is_comp            boolean NOT NULL DEFAULT false,
  CHECK (gross = (unit_price + modifiers_unit_total) * billable_qty),
  CHECK (net = gross - promotion_discount - manual_discount - discount_alloc),
  CHECK (net >= 0)
);

CREATE TABLE cl.discount_applications (                        -- (M) voidable before settlement only
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id      bigint NOT NULL REFERENCES cl.invoices,
  order_line_id   bigint REFERENCES cl.order_lines,           -- NULL = bill-level
  kind            text   NOT NULL CHECK (kind IN ('percent','fixed','comp')),
  value           numeric(14,2) NOT NULL CHECK (value >= 0),
  amount          cl.amount NOT NULL CHECK (amount >= 0),
  reason          text   NOT NULL,
  applied_by      bigint NOT NULL REFERENCES cl.users,
  step_up_id      bigint REFERENCES cl.step_up_approvals,      -- required above role limit
  voided_at       timestamptz,
  voided_by       bigint REFERENCES cl.users,
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (kind <> 'comp' OR order_line_id IS NOT NULL)
);

CREATE TABLE cl.payments (                                     -- (A)
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  invoice_id            bigint    NOT NULL REFERENCES cl.invoices,
  method                text      NOT NULL CHECK (method IN ('cash','card_manual','transfer')),
  transfer_provider     text      CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  amount                cl.amount NOT NULL CHECK (amount > 0),   -- applied to the invoice
  tendered              cl.amount,
  change_due            cl.amount,
  reference             text      CHECK (char_length(reference) <= 32),
  confirmed_by          bigint    REFERENCES cl.users,          -- transfer seen in shop account/app
  collected_by_rider_id bigint    REFERENCES cl.staff_profiles, -- COD / card on delivery
  received_by           bigint    NOT NULL REFERENCES cl.users,
  cash_shift_id         bigint    REFERENCES cl.cash_shifts,
  idempotency_key       uuid      NOT NULL UNIQUE,
  business_date         date      NOT NULL,
  CHECK ((method = 'transfer') = (transfer_provider IS NOT NULL)),
  CHECK (method <> 'transfer' OR (reference IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((method = 'cash') = (tendered IS NOT NULL)),
  CHECK (method <> 'cash' OR (tendered >= amount AND change_due = tendered - amount)),
  CHECK (method = 'cash' OR change_due IS NULL),
  CHECK (method <> 'cash' OR cash_shift_id IS NOT NULL)
);
CREATE INDEX payments_invoice_idx ON cl.payments (invoice_id);
CREATE INDEX payments_bdate_idx   ON cl.payments (business_date, method);
CREATE INDEX payments_shift_idx   ON cl.payments (cash_shift_id);
-- Service rule: reference must not look like a card number (13–19 digits passing Luhn) → rejected.

CREATE TABLE cl.refunds (                                      -- (A) refunds and method corrections
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_no         text   NOT NULL UNIQUE,                   -- 'RF-2026-00012'
  kind              text   NOT NULL CHECK (kind IN ('refund','method_correction')),
  invoice_id        bigint NOT NULL REFERENCES cl.invoices,
  payment_id        bigint REFERENCES cl.payments,
  amount            cl.amount NOT NULL CHECK (amount > 0),
  method            text   NOT NULL CHECK (method IN ('cash','card_manual','transfer')),
  transfer_provider text   CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  reference         text   CHECK (char_length(reference) <= 32),
  reason            text   NOT NULL,
  requested_by      bigint NOT NULL REFERENCES cl.users,
  approved_by       bigint NOT NULL REFERENCES cl.users,
  step_up_id        bigint NOT NULL REFERENCES cl.step_up_approvals,
  cash_shift_id     bigint REFERENCES cl.cash_shifts,
  idempotency_key   uuid   NOT NULL UNIQUE,
  business_date     date   NOT NULL,
  CHECK (approved_by <> requested_by),
  CHECK ((method = 'transfer') = (transfer_provider IS NOT NULL)),
  CHECK (method <> 'cash' OR cash_shift_id IS NOT NULL)
);
-- Service rule: Σ refunds per invoice ≤ Σ payments per invoice (checked under invoice row lock).

CREATE TABLE cl.refund_lines (                                 -- (A) item-level net sales
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_id       bigint NOT NULL REFERENCES cl.refunds,
  invoice_line_id bigint NOT NULL REFERENCES cl.invoice_lines,
  qty             int    NOT NULL CHECK (qty > 0),
  amount          cl.amount NOT NULL CHECK (amount > 0)
);
```

## 10. Operational ledger, expenses, assets

```sql
CREATE TABLE cl.expense_categories (                           -- (M)
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE cl.ledger_entries (                               -- (A)
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_no          text   NOT NULL UNIQUE,
  entry_type        text   NOT NULL CHECK (entry_type IN ('sale_receipt','refund','purchase_payment','expense',
                                                           'cash_in','cash_out','adjustment','reversal')),
  direction         text   NOT NULL CHECK (direction IN ('in','out')),
  amount            cl.amount NOT NULL CHECK (amount > 0),
  channel           text   NOT NULL CHECK (channel IN ('cash','card','transfer','other')),
  transfer_provider text   CHECK (transfer_provider IN ('bank','jazzcash','easypaisa')),
  category_id       bigint REFERENCES cl.expense_categories,
  business_date     date   NOT NULL,
  source_type       text   NOT NULL,
  source_id         bigint NOT NULL,
  source_key        text   NOT NULL UNIQUE,
  reverses_entry_id bigint REFERENCES cl.ledger_entries,
  memo              text,
  created_by        bigint REFERENCES cl.users,
  CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL))
);
CREATE INDEX ledger_bdate_idx  ON cl.ledger_entries (business_date);
CREATE INDEX ledger_source_idx ON cl.ledger_entries (source_type, source_id);

CREATE TABLE cl.expenses (                                     -- (M) void = reversal ledger entry
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_no      text   NOT NULL UNIQUE,
  category_id     bigint NOT NULL REFERENCES cl.expense_categories,
  amount          cl.amount NOT NULL CHECK (amount > 0),
  payee           text,
  reference       text,
  business_date   date   NOT NULL,
  paid_via        text   NOT NULL CHECK (paid_via IN ('cash','card','transfer','other')),
  attachment_path text,
  status          text   NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','voided')),
  created_by      bigint NOT NULL REFERENCES cl.users,
  voided_by       bigint REFERENCES cl.users,
  void_reason     text,
  CHECK ((status = 'voided') = (voided_by IS NOT NULL AND void_reason IS NOT NULL))
);

CREATE TABLE cl.assets (                                       -- (M)
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_tag           text NOT NULL UNIQUE,
  name                text NOT NULL,
  category            text NOT NULL,
  quantity            int  NOT NULL DEFAULT 1 CHECK (quantity > 0),
  purchase_date       date,
  purchase_price      cl.amount CHECK (purchase_price >= 0),
  supplier_id         bigint REFERENCES cl.suppliers,
  location            text,
  condition           text CHECK (condition IN ('new','good','fair','poor')),
  responsible_user_id bigint REFERENCES cl.users,
  status              text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use','in_repair','retired','disposed')),
  notes               text
);

CREATE TABLE cl.asset_events (                                 -- (A)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id   bigint NOT NULL REFERENCES cl.assets,
  event_type text   NOT NULL CHECK (event_type IN ('acquired','moved','condition_changed','maintenance',
                                                   'value_corrected','status_changed','disposed')),
  data       jsonb  NOT NULL,
  actor      bigint NOT NULL REFERENCES cl.users,
  reason     text
);

CREATE TABLE cl.asset_maintenance (                            -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id     bigint NOT NULL REFERENCES cl.assets,
  performed_on date   NOT NULL,
  vendor       text,
  cost         cl.amount CHECK (cost >= 0),
  description  text   NOT NULL,
  next_due     date,
  expense_id   bigint REFERENCES cl.expenses
);
```

## 11. Printing, reports, backups

```sql
CREATE TABLE cl.printers (                                     -- (M) one Sonic SNC-101 at launch
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL UNIQUE,
  connection       text NOT NULL CHECK (connection IN ('spooler','tcp','agent')),
  address          text NOT NULL,                             -- Windows printer name or host:port
  paper_width_mm   int  NOT NULL CHECK (paper_width_mm IN (58,80)),
  chars_per_line   int  NOT NULL CHECK (chars_per_line > 0),
  code_page        text,
  supports_status  boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true
);
ALTER TABLE cl.stations ADD FOREIGN KEY (printer_id) REFERENCES cl.printers;

CREATE TABLE cl.print_jobs (                                   -- (M)
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_key       text   NOT NULL UNIQUE,                       -- 'ticket:118:copy:1'
  printer_id    bigint NOT NULL REFERENCES cl.printers,
  document_type text   NOT NULL CHECK (document_type IN ('kitchen_ticket','receipt','refund_slip','shift_report')),
  document_id   bigint NOT NULL,
  copy_no       int    NOT NULL DEFAULT 1 CHECK (copy_no > 0),
  is_reprint    boolean NOT NULL DEFAULT false,
  requested_by  bigint REFERENCES cl.users,
  status        text   NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sending','sent','retrying','uncertain','needs_attention','cancelled')),
  attempts      int    NOT NULL DEFAULT 0,
  last_error    text,
  sent_at       timestamptz,
  CHECK (is_reprint = (copy_no > 1))
);
CREATE INDEX print_jobs_open_idx ON cl.print_jobs (printer_id, created_at)
  WHERE status IN ('queued','sending','retrying','uncertain','needs_attention');

CREATE TABLE cl.report_schedules (                             -- (M) PROVISIONAL D-20
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_type text   NOT NULL,
  filters     jsonb  NOT NULL DEFAULT '{}',
  frequency   text   NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  send_at     time   NOT NULL,
  weekday     smallint CHECK (weekday BETWEEN 1 AND 7),
  recipients  text[] NOT NULL CHECK (cardinality(recipients) > 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_by  bigint NOT NULL REFERENCES cl.users
);

CREATE TABLE cl.report_runs (                                  -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id  bigint REFERENCES cl.report_schedules,
  report_type  text   NOT NULL,
  period_from  date   NOT NULL,
  period_to    date   NOT NULL,
  file_path    text,
  status       text   NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','ready','failed')),
  error        text,
  UNIQUE (schedule_id, period_from, period_to)                -- a scheduled period is generated once
);

CREATE TABLE cl.report_deliveries (                            -- (M) e-mail is at-least-once
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       bigint NOT NULL REFERENCES cl.report_runs,
  recipient    text   NOT NULL,
  message_id   text   NOT NULL UNIQUE,                        -- stable Message-ID reused on retries
  status       text   NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts     int    NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  UNIQUE (run_id, recipient)
);

CREATE TABLE cl.backup_runs (                                  -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('dump','base_backup','offsite_copy','restore_test')),
  status      text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  path        text,
  size_bytes  bigint,
  verified_at timestamptz,
  error       text
);
```

## 12. Privileges and protection

```sql
CREATE ROLE cl_migrator NOLOGIN;   -- owns objects; used only by the installer
CREATE ROLE cl_app      NOLOGIN;   -- API and worker
CREATE ROLE cl_readonly NOLOGIN;   -- reports, diagnostics

REVOKE ALL ON SCHEMA cl FROM PUBLIC;
GRANT USAGE ON SCHEMA cl TO cl_app, cl_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA cl TO cl_readonly;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA cl TO cl_app;
GRANT UPDATE ON <every (M) and (D) table> TO cl_app;
GRANT DELETE ON cl.purchase_receipt_lines, cl.recipe_components, cl.stock_count_lines,
                cl.invoice_lines, cl.idempotency_keys, cl.outbox_events TO cl_app;
-- (D) deletes are further restricted by triggers to draft/unlocked parents.
-- No TRUNCATE for anyone but cl_migrator.
```

**Append-only (A) tables** (trigger + no UPDATE/DELETE grant): `step_up_approvals`, `audit_events`, `menu_variant_price_history`, `session_table_moves`, `delivery_events`, `order_line_components`, `order_events`, `kitchen_ticket_lines`, `stock_movements`, `order_line_costs`, `cost_adjustments`, `wastage_records`, `cash_movements`, `payments`, `refunds`, `refund_lines`, `ledger_entries`, `asset_events`.

**Freeze triggers:** `order_lines` price columns once the round is accepted · `order_line_modifiers` once accepted · `recipe_components` unless the version is draft · `purchase_receipt_lines` unless the receipt is draft · `stock_count_lines` once posted · `invoices`/`invoice_lines` once settled · `kitchen_tickets` content columns always (only `status` may change) · `table_assignments` except `ended_at`/`ended_by`.

## 13. Seed data (migration-time)

| Table | Rows |
|---|---|
| `roles` | owner, manager, waiter, cashier, inventory_clerk, kitchen (inactive while no kitchen device) |
| `permissions`, `role_permissions` | Catalog and defaults from [RBAC.md](RBAC.md) |
| `role_discount_limits` | cashier 10 %, manager 20 % (PROVISIONAL D-14) |
| `uoms` | g (1), kg (1000 g), ml (1), l (1000 ml), pcs (1) |
| `system_settings` | All values in DECISIONS.md §4 |
| `tills` | 'Counter' |
| `stations` | 'Kitchen' → counter printer |
| `ticket_templates` | Default kitchen (no prices), receipt, refund slip, all 80 mm |
| `expense_categories` | Rent, Utilities, Salaries, Supplies, Repairs, Marketing, Other (editable) |
| Owner account | Created by the installer with a one-time recovery code (SECURITY.md) |

## 14. Lock order and critical transactions

**Global lock order** (every multi-row transaction locks in this order to prevent deadlocks):
`dining_tables → table_assignments → dining_sessions → delivery_orders → order_rounds → order_lines → inventory_balances (ascending item_id) → inventory_lots (ascending id) → stock_reservations → invoices → cash_shifts → document_counters`.

Transaction contents for submit, accept (with the D-07 scope check), Picked up, cancel, lock bill, take payment, Accept & pay, dispatch, rider return, post receipt and post count are specified step by step in [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md) §8 and `docs/phase-0/03-data-model.md` §3.5.

## 15. Implementation notes (changes made while building)

| Date | Migration | Change from the design above | Why |
|---|---|---|---|
| 20 Oct 2026 | 0001 | Added `cl.role_permission_policy (role_id, permission_key, policy grantable/forbidden)` and triggers `check_role_grant` / `check_user_override` | RBAC.md's ○/✕ marks and owner-only permissions are now enforced by the database, not only by the service |
| 20 Oct 2026 | 0001 | `cl_migrator` is **not** created by migrations; the installer creates the login that runs migrations. Migrations create only `cl_app` and `cl_readonly` (idempotently, since roles are cluster-wide) | Roles outlive databases; dev and test databases share one PostgreSQL instance |
| 20 Oct 2026 | 0001 | Migration bookkeeping lives in `cl_meta.schema_migrations (version, name, checksum, applied_at)` | Forward-only runner refuses edited, missing or out-of-order migrations |
| 20 Oct 2026 | 0001 | `ensure_active_owner` also fires on INSERT, so the first user must be an owner | The installer creates the owner first; prevents a shop with no owner |
| 20 Oct 2026 | 0002, 0003 | Seeds: `0002_seed_access.sql` is generated from RBAC.md (72 permissions, 163 grants, 269 policies); `0003_seed_settings.sql` from DECISIONS.md §4 | Tests re-read both documents and compare them with the database |
| 20 Oct 2026 | 0001 | Default privileges: later tables automatically get SELECT (cl_readonly) and SELECT/INSERT (cl_app); UPDATE/DELETE are granted per table in each migration | Append-only tables stay append-only by default |
| 20 Oct 2026 | 0004 | Added `cl.device_registration_codes` (hashed one-time codes, 10 min), `cl.step_up_uses` (single use of an approval; `step_up_approvals` stays append-only) and `cl.owner_recovery_codes` (argon2id hash; hidden from `cl_readonly`) | Needed for device registration (API.md §4), single-use step-up approvals (RBAC.md §1.4) and owner recovery (SECURITY.md §2.2) |
| 20 Oct 2026 | 0005 | Added `cl.worker_heartbeats (worker_name, pid, version, started_at, beat_at)`; `cl_app` may UPDATE it | The health page reports the worker as stale after 60 s without a beat (WINDOWS_DEPLOYMENT.md §2) |
| 20 Oct 2026 | — | The job queue is graphile-worker 0.18 in its own schema `graphile_worker`, installed and upgraded by `db:migrate` after our migrations (not by numbered files). Jobs are added with `graphile_worker.add_job` inside the business transaction. Task names use `area:action` (cron lines reject dots) | Library-owned schema stays out of our checksummed migrations. **Open for 2.9:** grant the production app login what graphile needs in that schema; today only the owner login runs the worker |
| 20 Oct 2026 | 0006 | `cl_app` and `cl_readonly` may read `cl_meta.schema_migrations` (startup schema check). New role `cl_jobs` owns the job-queue schema; `cl_app` and the migrating login are members. `db:migrate` hands every `graphile_worker` object to `cl_jobs` after each job-queue migration (`adoptJobQueue`) | graphile-worker protects its tables with row-level security that only the owner passes, and its functions run with the caller's rights. Membership gives the services the queue without any extra right on schema `cl`. The installed API and worker log in as `cl_service` (member of `cl_app` only); a test runs startup checks, live updates, jobs, worker and login as `cl_app` |
| 20 Oct 2026 | 0007 | `menu_variants` gained the manual "temporarily unavailable" switch: `manual_unavailable`, `unavailable_note` (≤ 120), `unavailable_by`, `unavailable_at` (set together). `promotions` also checks `time_from <> time_to` and `days_of_week` ⊂ 1…7 (1–7 entries); `promotion_targets` has partial unique indexes so a target appears once. `menu_items.station_id` has no FK until `cl.stations` exists (step 3.5) | API.md §5.7 has the switch but §4 gave it no column; a zero-length or impossible promotion window is refused by the database, not only by the service |
| 20 Oct 2026 | 0008 | Phase 3 subset of §5 and §8: `uoms`, `inventory_items`, `inventory_balances` (a trigger creates the row with the item), `recipe_versions` (forward-only trigger), `recipe_components` (draft-only trigger), `modifier_recipe_rules`, `stock_reservations` (counters-only-forward trigger), `stock_movements`, `order_line_costs`, `wastage_records`, `inventory_alerts`. `order_line_id` columns have no FK until `cl.order_lines` exists (step 3.4); `lot_id` columns none until `cl.inventory_lots` (Phase 4). Extra checks: a movement's value never moves against its quantity; a replace rule cannot replace an item with itself; waste reason `other` needs a note. Alert kind `found_stock` added | Acceptance and pickup need stock now; purchasing, lots and counts come with the Phase 4 screens. `found_stock` is the owner alert COST_VALUATION.md §5 asks for when a pickup needs more than the book quantity |
| 21 Oct 2026 | 0009 | §6 tables for the floor: `dining_tables`, `qr_entry_points`, `table_assignments` (end-only trigger), `dining_sessions` (closed is final; a QR-opened session names its entry point), `session_table_moves`, `session_guest_tokens` (revocation is final). Added `signing_keys` (the entry-cookie HMAC key, created by the server on first use, hidden from `cl_readonly`) and `operational_alerts` (`stale_session` now, `uncollected_item` in step 3.5; one open alert per subject). Delivery orders and riders follow in step 3.10; invoices are created with sessions from step 3.7 | API.md §4 asks for a signed entry cookie, which needs a key the backup carries; ORDER_STATE_MACHINE.md T1 asks for a stale-session alert, and `inventory_alerts` is for stock only |
| 21 Oct 2026 | 0010 | §7 order tables: `order_rounds` (decided once; escalation set once), `order_lines` (what was ordered never changes, prices set once at acceptance, counters only grow; `unit_price` and `stock_mode_snap` are set together), `order_line_modifiers` (append-only, one row per option with `qty`), `order_line_components`, `order_events`. Stations, ticket templates and kitchen tickets follow in step 3.5 with the station FKs. Adds the `order_line_id` FKs on `stock_reservations`, `order_line_costs` and `wastage_records` that 0008 left out | Rounds need lines before tickets exist; the guards make the state machine rules of ORDER_STATE_MACHINE.md §2–§3 hold in the database too |
| 22 Oct 2026 | 0011 | §7 kitchen tables: `stations` (seeded "Kitchen"; `printer_id` gets its FK with the printers in step 3.6), `ticket_templates` (seeded kitchen template; a kitchen template whose definition mentions price, total, amount, pay, discount, phone, email, address or customer is refused by a CHECK), `kitchen_tickets` (only the status changes, forward only), `kitchen_ticket_lines`; station FKs on `menu_items` and `order_lines`. Correction and void tickets are created `completed`: they tell the kitchen, nothing waits on them. Receipt and refund templates are seeded with the receipt in step 3.6 | AT-99 holds in the database as well as in the code that builds ticket content |
| 22 Oct 2026 | 0012 | §11 printing: `printers` (connection `spooler` or `tcp` only; `can_cut`; TCP address checked), `stations.printer_id` FK, `print_jobs` with `test_page` documents, `next_attempt_at` (retry backoff), `claimed_at` (a `sending` job claimed over two minutes ago died with its worker and becomes `uncertain`), `resolved_by` and the standard columns; what a job prints never changes and `sent`/`cancelled` are final. Also found while building it: `SELECT id::text … ORDER BY id` orders by the text output column ("10" before "9"); every query now orders by the table column, and test/platform/sql-order.test.ts keeps it that way | The worker needs these to print in order, back off, and never resend a job that may have printed (AT-28) |
| 22 Oct 2026 | 0013 | §9 billing: `tills` (seeded "Counter", plus `receipt_printer_id`: where receipts print), `cash_shifts`, `cash_movements`, `invoices`, `invoice_lines`, `discount_applications`, `payments`, with the standard columns on (M) tables and `created_at` on the (A) ones. `payments.collected_by_rider_id` has no FK until riders exist (step 3.10). Extra CHECKs: `settled_at` set exactly when settled, an invoice number only on a settled invoice, a comp is 100 % on a line, a voided discount names who voided it, `invoice_lines.is_comp` means net 0. Triggers: a settled invoice and its lines and discounts never change and invoices are never deleted (AT-97); `lock_version` and `paid_total` never go down; a payment needs a locked invoice; `payments` and `cash_movements` are append-only. Every session gets its invoice when it opens (sessions opened before 0013 got theirs in the migration). A receipt template is seeded with the shop name and footer for the owner to confirm (R5) | Cash payments need an open shift (P1); receipts need a printer; the database, not only the service, keeps settled bills frozen |
| 24 Oct 2026 | 0014 | §9 cash shifts: `closed_by` (a manager may close a cashier’s shift) and `approved_at`; CHECKs that a closed shift’s variance = counted − expected, that a variance has a reason, and that only a balanced shift is approved without an approver; a guard that keeps a closed count final (open → closed → approved, approved is final, no delete); paid-in/out and cash payments only into an open shift. The view `cl.cash_shift_figures` is the one definition of expected cash (FINANCE_REPORTING.md §5), read by the screen, the close and the printed report; card and transfer totals are payments taken while the shift was open | AT-37; the screen, the close and the report cannot disagree |
| 25 Oct 2026 | — | No migration in step 3.9. Recorded here because it touches the lock order (§14): Accept & pay locks the invoice and the cash shift after the stock and before the kitchen ticket is numbered (acceptance takes a hook at that point), and numbers the invoice last, so ticket and invoice numbers both come from `document_counters` at the end of the transaction | The global lock order holds for the one transaction that accepts, pays and settles |
| 25 Oct 2026 | 0015 | §6 delivery: `staff_profiles` (riders, no login; unique active name), `delivery_orders` with the standard columns, `attempt` (each dispatch prints its own rider slip), `refund_due` (P3-1: set when a prepaid delivery is cancelled; the refund itself is Phase 5), `created_by`, and a trigger allowing only the moves of ORDER_STATE_MACHINE.md §7 (delivered, cancelled and converted are final); `delivery_events` append-only; the `payments.collected_by_rider_id` FK; delivery sessions are opened by staff only; alert kinds `failed_delivery` and `refund_due`. **Lock order (§14):** `delivery_orders` comes right after `dining_sessions` | Dispatch, return and resolve lock the session, then the delivery, then lines and the bill |
| 25 Oct 2026 | 0016 | Two settings, also in DECISIONS.md §4: `shop.business_hours` (`{"opens","closes"}`, equal times = always open, the default until the owner sets the hours; guests order by QR only within them) and `brand.primary` (#6B4435). The shop name and receipt wording stay in the receipt template | AT-130: owner settings used so far |
| 26 Oct 2026 | 0017 | §5 `item_pack_sizes` and `barcodes` with the standard columns. Extra: a pack name is unique among an item's active packs; what a pack holds and whose it is never change (trigger); `UNIQUE (id, item_id)` on packs so a barcode's pack must belong to the barcode's item (composite FK); a code is 1–64 printable ASCII characters; a barcode only goes from active to inactive and never changes its code, item or pack (re-linking adds a row). `inventory_items` gains a guard: the base unit changes only while no pack, movement, recipe component or modifier rule uses the item, and an archived item stays archived. **Lock order (§14):** an `inventory_items` row is locked after its `inventory_balances` row, as the opening balance already did (archive checks the balance first) | Receipts copy a pack's base quantity, so a pack that changed size would make history unreadable; the database keeps one active owner per code even when two clerks link it at once (AT-14) |
| 26 Oct 2026 | 0018 | §5 `suppliers` (standard columns; unique active name), `purchase_receipts` and `purchase_receipt_lines`. Additions: `payment_reference` (P4-2), `note`, `created_by`, `reversed_at`; a GRN number format CHECK; payment channel set exactly when paid now; reversal fields set exactly when reversed (reason ≥ 3 characters); a receipt line's pack must belong to its item (composite FK, as for barcodes) and has a pack quantity exactly when it has a pack. Triggers: a receipt goes draft → posted → reversed only, a posted receipt changes only by being reversed, nothing is deleted; lines change only while the receipt is a draft (and `cl_app` has no UPDATE or DELETE on lines at all). The API posts a receipt in one transaction (draft, lines, stock, number, posted), so the draft lives on the clerk's screen, not in the database. **Lock order (§14):** reversal locks the `purchase_receipts` row before the balances; posting takes the GRN number from `document_counters` last | A posted receipt is the record of what came in and what it cost; the frozen rows make the costing history trustworthy (COST_VALUATION.md §9) |
| 26 Oct 2026 | 0019 | §5 `inventory_lots` with the standard columns and `origin` (`receipt`, `opening`, `found`, `count`; a receipt lot names its receipt line, one lot per line); `depleted` is set by a trigger exactly when nothing remains; a lot keeps its item and origin. **Lot detail of movements is in a new append-only `stock_movement_lots (movement_id, lot_id, qty_delta, expired)`** instead of one movement per lot, so an issue spanning two lots stays one movement with one line cost (PT-01) and the WAC formulas are untouched; `stock_movements.lot_id` stays empty. FKs for the `lot_id` columns of 0008 (`stock_movements`, `wastage_records`, `inventory_alerts`). Stock already on hand for lot-tracked items became lots: the newest posted receipt lines first (with their lot code and expiry), the rest one opening lot of unknown expiry (P4-3). **Lock order (§14):** lots change only inside ledger operations that already hold the item's balance lock, so they are updated without a separate lock; switching lots on or off locks the balance before the item | Lots carry quantity and expiry; value stays per item (D-04). The nightly check now also proves Σ lots = on hand for lot-tracked items |
| 26 Oct 2026 | 0020 | New `supplier_returns` (append-only; not in §5): one row per returned receipt line with item, lot, quantity, stock value out at the average, reason, the refund's amount, channel and reference (set together; P4-2), its `supplier_return` movement and who returned it. The service never returns more than the line brought in (serialised by the receipt's row lock, which is taken before the balance), and a receipt with returns cannot be reversed | RECIPE_INVENTORY.md §11 asks for returns against the receipt line and lot; Phase 5 writes the refund's ledger entry from these rows |
| 26 Oct 2026 | 0021 | §8 `stock_counts` and `stock_count_lines` with changes: count statuses `draft → submitted → posted` (submitted can go back to draft when sent back) and `draft → cancelled`, instead of `approved`/`rejected` (approval posts at once; a send-back is a return to counting); `count_no` is `CNT-YYYY-NNNNN` (a format to confirm with the others in §16); the scope is stored (`scope_kind`, `scope_category`, `scope_item_ids`); added `submitted_at`, `business_date`, `note`, `sent_back_reason`, standard columns. Lines: `counted_qty` is set when the line exists (a line is created by entering it), `variance_qty = counted − book` by CHECK, `new_lot_expiry` for stock found in no known lot, `entered_by`/`entered_at`, and the result `posted_qty` and `movement_id`; unique per count, item and lot (NULLS NOT DISTINCT). Triggers keep posted and cancelled counts final and lines editable only while counting (at posting only the result columns are written). The service allows one open count at a time. **Lock order (§14):** the count's row before the balances | RECIPE_INVENTORY.md §9 and D-18, as built; the posted delta can differ from the variance when stock was sold after the line was counted, so both are kept |
| 26 Oct 2026 | 0022 | §8 `cost_adjustments` as designed, plus `business_date`, a check that `amount` is not zero, and that both shares have the sign of the correction; append-only. The `cost_adjustment` movement has quantity 0 and value = the stock share. A receipt with corrections cannot be reversed (its exact path would use the uncorrected cost) | COST_VALUATION.md §6; Phase 5 reports the variance share as purchase price variance |

## 16. Open points for review R1

1. Promotions: confirm **no stacking** (best single promotion per line) — part of D-14.
2. Modifier price deltas are **≥ 0**. Is a negative modifier ever needed (e.g., "no milk −Rs 50")?
3. `tax_total` is constrained to 0. Enabling tax in future requires a deliberate migration (by design, DEC-13).
4. Refunds require **approver ≠ requester** (D-13). If the owner is the only person with refund rights, the owner cannot refund alone; a cashier must request it and the owner approves. Confirm, or allow owner self-approval with a mandatory reason.
5. Session numbering `S-YYYYMMDD-NNNN`, round `R-MMDD-NNN`, ticket `K-MMDD-NNN`, invoice `INV-YYYY-NNNNNN`, refund `RF-YYYY-NNNNN`, receipt `GRN-YYYY-NNNNN`. Confirm or supply a preferred format.
