-- 0003 Seed: operational settings (docs/DECISIONS.md §4, confirmed at Gate G1).
-- Money values are JSON strings (decimal, never floats); counts and minutes are numbers.

INSERT INTO cl.system_settings (key, value) VALUES
  ('shop.timezone',                          '"Asia/Karachi"'),
  ('shop.business_day_cutoff',               '"04:00"'),
  ('orders.price_lock_minutes',              '30'),
  ('orders.escalation_minutes',              '3'),
  ('orders.takeaway_unpaid_expiry_minutes',  '30'),
  ('orders.uncollected_alert_minutes',       '30'),
  ('orders.pickup_marks_served_dine_in',     'true'),
  ('sessions.stale_alert_hours',             '3'),
  ('billing.cash_rounding_unit',             '"1.00"'),
  ('inventory.count_variance_pct',           '2'),
  ('inventory.count_variance_amount',        '"1000.00"'),
  ('privacy.delivery_pii_retention_months',  '12');
