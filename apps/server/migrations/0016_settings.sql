-- 0016 Owner settings used so far (DECISIONS.md §4; UI_UX.md "Branding"; AT-130; Phase 3
-- step 3.12): the hours in which guests may order by QR (staff can always order) and the
-- brand colour. Equal opening and closing times mean always open, the default until the
-- owner sets the shop's hours. The shop name and receipt wording stay in the receipt
-- template (0013); the owner edits both in Settings.

INSERT INTO cl.system_settings (key, value) VALUES
  ('shop.business_hours', '{"opens": "00:00", "closes": "00:00"}'),
  ('brand.primary',       '"#6B4435"');
