-- 0027 Remaining owner settings and delivery privacy (DECISIONS.md §4; D-25; Phase 5 step 5.6).
-- The lists the owner keeps (refund reasons, asset categories and places) become settings;
-- expense categories are their own table (0025). Delivery customer details are removed
-- after `privacy.delivery_pii_retention_months` by the nightly worker; the sale, its
-- payments and its ledger entries stay as they were (AT-105).

INSERT INTO cl.system_settings (key, value) VALUES
  ('refunds.reasons',  '["Wrong order", "Quality", "Cold or late", "Order cancelled", "Charged twice", "Other"]'),
  ('assets.categories', '["Coffee equipment", "Refrigeration", "Kitchen equipment", "Furniture", "POS hardware", "Other"]'),
  ('assets.locations', '["Bar", "Kitchen", "Dining area", "Store room", "Office"]');

-- When a delivery's customer details were removed; a redacted delivery keeps no address.
ALTER TABLE cl.delivery_orders ADD COLUMN redacted_at timestamptz;
ALTER TABLE cl.delivery_orders ADD CONSTRAINT delivery_redacted_has_no_address
  CHECK (redacted_at IS NULL OR (address IS NULL AND landmark IS NULL AND notes IS NULL));
CREATE INDEX delivery_unredacted_idx ON cl.delivery_orders (created_at) WHERE redacted_at IS NULL;
