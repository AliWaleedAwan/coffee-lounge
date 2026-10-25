-- 0007 Menu, pricing, promotions (DATABASE.md §4; Phase 3 step 3.1).
-- Deviation recorded in DATABASE.md §15: menu_variants carries the manual
-- "temporarily unavailable" switch (API.md §5.7), which §4 did not give a home.

CREATE TABLE cl.menu_categories (                              -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  sort        int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);

CREATE TABLE cl.menu_items (                                   -- (M)
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id    bigint NOT NULL REFERENCES cl.menu_categories,
  name           text   NOT NULL,
  description    text,
  image_path     text,
  station_id     bigint,                                      -- FK added with cl.stations (step 3.5)
  allow_dine_in  boolean NOT NULL DEFAULT true,
  allow_takeaway boolean NOT NULL DEFAULT true,
  allow_delivery boolean NOT NULL DEFAULT true,
  dietary_tags   text[]  NOT NULL DEFAULT '{}',               -- MENU-008: shown exactly as entered, never inferred
  sort           int     NOT NULL DEFAULT 0,
  is_active      boolean NOT NULL DEFAULT true,
  archived_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  version        int NOT NULL DEFAULT 1,
  CHECK (allow_dine_in OR allow_takeaway OR allow_delivery)
);
CREATE INDEX menu_items_category_idx ON cl.menu_items (category_id);
CREATE INDEX menu_items_name_trgm ON cl.menu_items USING gin (name gin_trgm_ops);

CREATE TABLE cl.menu_variants (                                -- (M)
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id            bigint    NOT NULL REFERENCES cl.menu_items,
  name               text      NOT NULL,                      -- 'Regular', 'Large'
  price              cl.amount NOT NULL CHECK (price >= 0),
  stock_mode         text      NOT NULL DEFAULT 'untracked'
                     CHECK (stock_mode IN ('untracked','recipe')), -- D-29: 'recipe' only once an active recipe exists (service rule)
  is_default         boolean   NOT NULL DEFAULT false,
  sort               int       NOT NULL DEFAULT 0,
  is_active          boolean   NOT NULL DEFAULT true,
  archived_at        timestamptz,
  -- Manual "temporarily unavailable" (machine broken…); overrides stock availability.
  manual_unavailable boolean   NOT NULL DEFAULT false,
  unavailable_note   text      CHECK (length(unavailable_note) <= 120),
  unavailable_by     bigint    REFERENCES cl.users,
  unavailable_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  UNIQUE (item_id, name),
  CHECK (NOT manual_unavailable OR (unavailable_by IS NOT NULL AND unavailable_at IS NOT NULL))
);
CREATE UNIQUE INDEX menu_variants_one_default ON cl.menu_variants (item_id) WHERE is_default;
CREATE INDEX menu_variants_unavailable_by_idx ON cl.menu_variants (unavailable_by);

CREATE TABLE cl.menu_variant_price_history (                   -- (A)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  variant_id bigint    NOT NULL REFERENCES cl.menu_variants,
  old_price  cl.amount,
  new_price  cl.amount NOT NULL,
  changed_by bigint    NOT NULL REFERENCES cl.users,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX menu_variant_price_history_variant_idx ON cl.menu_variant_price_history (variant_id, created_at);
CREATE INDEX menu_variant_price_history_changed_by_idx ON cl.menu_variant_price_history (changed_by);

CREATE TABLE cl.modifier_groups (                              -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  min_select int  NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select int  NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  CHECK (min_select <= max_select)
);

CREATE TABLE cl.modifier_options (                             -- (M)
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    bigint    NOT NULL REFERENCES cl.modifier_groups,
  name        text      NOT NULL,
  price_delta cl.amount NOT NULL DEFAULT 0 CHECK (price_delta >= 0),
  sort        int       NOT NULL DEFAULT 0,
  is_active   boolean   NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     int NOT NULL DEFAULT 1
);
CREATE INDEX modifier_options_group_idx ON cl.modifier_options (group_id);

CREATE TABLE cl.menu_item_modifier_groups (
  item_id    bigint NOT NULL REFERENCES cl.menu_items,
  group_id   bigint NOT NULL REFERENCES cl.modifier_groups,
  sort       int    NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, group_id)
);
CREATE INDEX menu_item_modifier_groups_group_idx ON cl.menu_item_modifier_groups (group_id);

CREATE TABLE cl.promotions (                                   -- (M) D-14: no stacking, best single promotion per line
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
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CHECK ((time_from IS NULL) = (time_to IS NULL)),
  CHECK (time_from IS NULL OR time_from <> time_to),
  CHECK (days_of_week IS NULL OR (cardinality(days_of_week) BETWEEN 1 AND 7
         AND days_of_week <@ ARRAY[1,2,3,4,5,6,7]::smallint[]))
);

CREATE TABLE cl.promotion_targets (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  promotion_id  bigint NOT NULL REFERENCES cl.promotions,
  menu_item_id  bigint REFERENCES cl.menu_items,
  category_id   bigint REFERENCES cl.menu_categories,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(menu_item_id, category_id) = 1)
);
CREATE INDEX promotion_targets_promotion_idx ON cl.promotion_targets (promotion_id);
CREATE UNIQUE INDEX promotion_targets_item_uq ON cl.promotion_targets (promotion_id, menu_item_id) WHERE menu_item_id IS NOT NULL;
CREATE UNIQUE INDEX promotion_targets_category_uq ON cl.promotion_targets (promotion_id, category_id) WHERE category_id IS NOT NULL;
CREATE INDEX promotion_targets_item_idx ON cl.promotion_targets (menu_item_id);
CREATE INDEX promotion_targets_category_idx ON cl.promotion_targets (category_id);

-- Version bumps on every update; price history is append-only.
CREATE TRIGGER menu_categories_touch BEFORE UPDATE ON cl.menu_categories FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON cl.menu_items FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER menu_variants_touch BEFORE UPDATE ON cl.menu_variants FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER modifier_groups_touch BEFORE UPDATE ON cl.modifier_groups FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER modifier_options_touch BEFORE UPDATE ON cl.modifier_options FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER promotions_touch BEFORE UPDATE ON cl.promotions FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER menu_variant_price_history_append_only BEFORE UPDATE OR DELETE ON cl.menu_variant_price_history
  FOR EACH ROW EXECUTE FUNCTION cl.forbid_update_delete();

-- Default privileges give cl_app SELECT/INSERT; mutable tables also need UPDATE.
-- Nothing is ever deleted except links (modifier groups on items, promotion targets).
GRANT UPDATE ON cl.menu_categories, cl.menu_items, cl.menu_variants, cl.modifier_groups,
                cl.modifier_options, cl.promotions
  TO cl_app;
GRANT DELETE ON cl.menu_item_modifier_groups, cl.promotion_targets TO cl_app;
