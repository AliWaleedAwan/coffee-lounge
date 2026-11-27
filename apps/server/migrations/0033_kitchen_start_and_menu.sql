-- 0033 The kitchen accepts a ticket, which is when guests and waiters see "Preparing"; before
-- that an accepted round reads "Sent to kitchen". Display only: stock still moves at pickup
-- (D-33). The kitchen role may also read the menu, overriding RBAC.md's ✕ at the owner's request.
ALTER TABLE cl.kitchen_tickets ADD COLUMN started_at timestamptz;

DELETE FROM cl.role_permission_policy
 WHERE permission_key = 'menu.read' AND role_id = (SELECT id FROM cl.roles WHERE key = 'kitchen');
INSERT INTO cl.role_permissions (role_id, permission_key)
SELECT id, 'menu.read' FROM cl.roles WHERE key = 'kitchen';
