-- 0036 Installing a new version is the owner's alone (Phase 8, automatic updates).
INSERT INTO cl.permissions (key, module, description, scope_kind, is_protected) VALUES
  ('system.update', 'system', 'Install a new version of the app', 'none', true);
INSERT INTO cl.role_permission_policy (role_id, permission_key, policy)
SELECT r.id, 'system.update', 'forbidden' FROM cl.roles r
 WHERE r.key IN ('manager','waiter','cashier','inventory_clerk','kitchen');
INSERT INTO cl.role_permissions (role_id, permission_key, scope)
SELECT r.id, 'system.update', NULL FROM cl.roles r WHERE r.key = 'owner';
