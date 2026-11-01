-- 0032 Changes asked for before the client demo (docs/phase-8/DEMO.md).
-- 1. The owner may give any permission to anyone (overrides RBAC.md's ✕ and 🔒, recorded in
--    DATABASE.md §15). The policy rows and is_protected stay as advice: the screen calls those
--    permissions sensitive, and the service lets only an owner hand them out.
-- 2. More asset categories offered; the owner adds and removes them (POST /assets/categories).
-- 3. Demo data: `cl.demo_state` has a row only where the demo loader ran (scripts/demo-shop.ts,
--    with the database owner's rights; the application role can only read it), so a shop that
--    never loaded a demo has no switcher and nothing to wipe. The wipe works once.

DROP TRIGGER role_permissions_check ON cl.role_permissions;
DROP FUNCTION cl.check_role_grant();
DROP TRIGGER user_permission_overrides_check ON cl.user_permission_overrides;
DROP FUNCTION cl.check_user_override();

UPDATE cl.system_settings SET value = '["Furniture", "Cutlery & crockery", "Kitchen equipment", "Coffee equipment", "Refrigeration", "Devices & electronics", "POS hardware", "Decoration", "Cleaning", "Other"]'
 WHERE key = 'assets.categories';

CREATE TABLE cl.demo_state (
  only_row   boolean PRIMARY KEY DEFAULT true CHECK (only_row),
  status     text NOT NULL DEFAULT 'loaded' CHECK (status IN ('loaded','wiped')),
  user_ids   bigint[] NOT NULL,                                 -- the made-up people
  guest_links jsonb NOT NULL DEFAULT '[]',                      -- made-up tables and their QR tokens, for the guest picker
  loaded_at  timestamptz NOT NULL DEFAULT now(),
  wiped_at   timestamptz
);
GRANT SELECT ON cl.demo_state TO cl_app;

-- Empties everything the demo traded with, numbering included, and removes the made-up people.
-- The menu, inventory items, recipes, settings and real people stay. A table added later is
-- emptied unless it is named here. The function runs as its owner: the application role has no
-- TRUNCATE of its own, and without a loaded demo this refuses.
CREATE FUNCTION cl.wipe_demo_data() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = cl, pg_temp AS $$
DECLARE
  keep text[] := ARRAY['users','roles','permissions','role_permissions','role_permission_policy',
    'user_roles','user_permission_overrides','role_discount_limits','devices','auth_sessions',
    'owner_recovery_codes','system_settings','menu_categories','menu_items','menu_variants',
    'menu_variant_price_history','modifier_groups','modifier_options','menu_item_modifier_groups',
    'uoms','inventory_items','recipe_versions','recipe_components','modifier_recipe_rules',
    'item_pack_sizes','barcodes','signing_keys','stations','ticket_templates','printers','tills',
    'expense_categories','backup_runs','offsite_target','mail_account',
    'worker_heartbeats','report_schedules','staff_profiles','demo_state'];
  people bigint[];
  names text;
BEGIN
  SELECT user_ids INTO people FROM cl.demo_state WHERE status = 'loaded' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no demo data to delete' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT string_agg(format('cl.%I', tablename), ', ') INTO names
    FROM pg_tables WHERE schemaname = 'cl' AND NOT tablename = ANY (keep);
  EXECUTE 'TRUNCATE ' || names || ' RESTART IDENTITY';
  DELETE FROM cl.auth_sessions WHERE user_id = ANY (people);
  DELETE FROM cl.staff_profiles WHERE user_id = ANY (people);
  DELETE FROM cl.user_permission_overrides WHERE user_id = ANY (people) OR granted_by = ANY (people);
  DELETE FROM cl.user_roles WHERE user_id = ANY (people);
  DELETE FROM cl.users WHERE id = ANY (people);
  UPDATE cl.demo_state SET status = 'wiped', wiped_at = now(), user_ids = '{}', guest_links = '[]';
END $$;
REVOKE ALL ON FUNCTION cl.wipe_demo_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cl.wipe_demo_data() TO cl_app;
