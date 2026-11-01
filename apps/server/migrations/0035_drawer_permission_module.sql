-- 0035 drawer.open belongs to its own module, like every other permission (the part before
-- the dot). Written as a new migration because 0034 may already be applied on a dev laptop.
UPDATE cl.permissions SET module = 'drawer' WHERE key = 'drawer.open';
