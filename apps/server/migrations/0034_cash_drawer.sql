-- 0034 Cash drawer (Phase 8 step 8.7; P8-5). A drawer is cabled to a printer's RJ11 port and
-- opens on the standard pulse. Off until someone says one is connected. Every manual open
-- needs drawer.open and is written to the audit log.
ALTER TABLE cl.printers
  ADD COLUMN drawer_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN drawer_on_cash boolean NOT NULL DEFAULT true;

INSERT INTO cl.permissions (key, module, description, scope_kind, is_protected) VALUES
  ('drawer.open', 'printers', 'Open the cash drawer by hand', 'none', false);
INSERT INTO cl.role_permission_policy (role_id, permission_key, policy)
SELECT r.id, 'drawer.open', 'forbidden' FROM cl.roles r
 WHERE r.key IN ('waiter','inventory_clerk','kitchen');
INSERT INTO cl.role_permissions (role_id, permission_key, scope)
SELECT r.id, 'drawer.open', NULL FROM cl.roles r WHERE r.key IN ('owner','manager','cashier');
