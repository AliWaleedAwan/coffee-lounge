-- 0017 Pack sizes and barcodes (DATABASE.md §5; RECIPE_INVENTORY.md §1, §7; Phase 4
-- step 4.1). A pack is how an item is bought ("1 L carton" = 1000 ml); a barcode names an
-- item and, usually, one of its packs. A code has at most one active owner; a deactivated
-- barcode frees its code and stays for history. Nothing is deleted (D-31).

CREATE TABLE cl.item_pack_sizes (                              -- (M)
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id    bigint NOT NULL REFERENCES cl.inventory_items,
  name       text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  qty_base   cl.qty NOT NULL CHECK (qty_base > 0),
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1,
  UNIQUE (id, item_id)                                         -- target of the barcode FK below
);
CREATE INDEX item_pack_sizes_item_idx ON cl.item_pack_sizes (item_id);
CREATE UNIQUE INDEX item_pack_sizes_active_name_uq ON cl.item_pack_sizes (item_id, lower(btrim(name)))
  WHERE is_active;

-- What a pack holds is fixed once created: receipts copy the base quantity, and a pack that
-- changes size is a new pack. Only the name and the active flag change.
CREATE FUNCTION cl.pack_size_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.item_id <> OLD.item_id OR NEW.qty_base <> OLD.qty_base THEN
    RAISE EXCEPTION 'A pack size keeps its item and quantity; add a new pack instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER item_pack_sizes_guard BEFORE UPDATE ON cl.item_pack_sizes
  FOR EACH ROW EXECUTE FUNCTION cl.pack_size_guard();

CREATE TABLE cl.barcodes (                                     -- (M)
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         text   NOT NULL CHECK (code ~ '^[!-~]{1,64}$'),  -- printable ASCII, no spaces
  item_id      bigint NOT NULL REFERENCES cl.inventory_items,
  pack_size_id bigint,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  version      int NOT NULL DEFAULT 1,
  -- A barcode's pack belongs to the same item.
  FOREIGN KEY (pack_size_id, item_id) REFERENCES cl.item_pack_sizes (id, item_id)
);
CREATE UNIQUE INDEX barcodes_active_code_uq ON cl.barcodes (code) WHERE is_active;
CREATE INDEX barcodes_item_idx ON cl.barcodes (item_id);
CREATE INDEX barcodes_pack_size_idx ON cl.barcodes (pack_size_id, item_id);

-- A barcode only ever goes from active to inactive, and keeps what it pointed at.
CREATE FUNCTION cl.barcode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code OR NEW.item_id <> OLD.item_id
     OR NEW.pack_size_id IS DISTINCT FROM OLD.pack_size_id OR (NEW.is_active AND NOT OLD.is_active) THEN
    RAISE EXCEPTION 'A barcode is only ever deactivated; add it again to change it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER barcodes_guard BEFORE UPDATE ON cl.barcodes
  FOR EACH ROW EXECUTE FUNCTION cl.barcode_guard();

-- An item's base unit is fixed once anything counts in it: a pack, a barcode, a movement, a
-- recipe component or a modifier rule.
CREATE FUNCTION cl.inventory_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_uom <> OLD.base_uom AND (
       EXISTS (SELECT 1 FROM cl.item_pack_sizes WHERE item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM cl.stock_movements WHERE item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM cl.recipe_components WHERE inventory_item_id = OLD.id)
    OR EXISTS (SELECT 1 FROM cl.modifier_recipe_rules
                WHERE inventory_item_id = OLD.id OR replacement_item_id = OLD.id)) THEN
    RAISE EXCEPTION 'The base unit of an item in use cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'An archived item stays archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_items_guard BEFORE UPDATE ON cl.inventory_items
  FOR EACH ROW EXECUTE FUNCTION cl.inventory_item_guard();

CREATE TRIGGER item_pack_sizes_touch BEFORE UPDATE ON cl.item_pack_sizes FOR EACH ROW EXECUTE FUNCTION cl.touch_row();
CREATE TRIGGER barcodes_touch BEFORE UPDATE ON cl.barcodes FOR EACH ROW EXECUTE FUNCTION cl.touch_row();

GRANT UPDATE ON cl.item_pack_sizes, cl.barcodes TO cl_app;
