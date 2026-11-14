-- 0038 How long a device may sit idle before it logs out (owner's request, Nov 2026): the owner
-- sets it per kind of device, 0 meaning never (a login still ends after 12 hours). The values
-- are those used until now (RBAC.md §4).
INSERT INTO cl.system_settings (key, value) VALUES
  ('security.logout_counter_minutes', '10'),
  ('security.logout_manager_minutes', '5'),
  ('security.logout_waiter_minutes',  '5');
