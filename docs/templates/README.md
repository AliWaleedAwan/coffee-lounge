# Data-entry templates for the inventory clerk

> Phase 1, package 1D (review R4). Supports the weekly, step-by-step data entry agreed in D-29. Files open in Excel or Google Sheets; save as **CSV UTF-8**. Import happens on the counter PC (Inventory → Import), off-peak (D-38). The import screen is part of the Phase 4 build.

## Before you start

- **Every row in these files is an example. Delete the example rows** and type your real data. Example SKUs start with `EX-`; the importer refuses any SKU starting with `EX-` so examples can't be imported by accident.
- Keep the header row exactly as it is.
- Use the units `g`, `kg`, `ml`, `l` or `pcs`. Weight and volume can't be mixed for the same item.
- `yes` / `no` for true/false columns. Dates as `YYYY-MM-DD`. Money with up to 2 decimals, no "Rs" and no commas (`3240.00`).

## Weekly order (D-29, RECIPE_INVENTORY.md §2)

| Step | File | What it does |
|---|---|---|
| 1 | `01_inventory_items.csv` | Ingredients and packaging the shop stocks |
| 2 | `02_pack_sizes_barcodes.csv` | How each item is bought (carton, bag, sleeve) and its barcode |
| 3 | `03_opening_stock.csv` | What you have today and what it's worth. **This switches stock control on** for those items. Posted by the owner, or by the clerk if the owner has granted `inventory.opening_balance`. |
| 4 | `08_suppliers.csv` | Supplier list (any time) |
| 5 | `04_menu.csv` | Menu items, sizes and prices (price changes need owner permission) |
| 6 | `05_modifiers.csv` | Options such as oat milk or extra shot, and their extra price |
| 7 | `06_recipes.csv` | Ingredients per drink size. Imported as **drafts**; activate them on screen after checking. |
| 8 | `07_modifier_recipe_rules.csv` | How options change ingredients (replace milk, add beans) |

A recipe can only be activated when **all** its ingredients have had their opening stock entered (step 3). Start with your best-selling drinks.

## Column guide

**01_inventory_items.csv:** `sku` your own short code, unique (e.g., `MILK-WHOLE`) · `name` · `category` · `base_uom` `g`/`ml`/`pcs` · `track_lots`, `track_expiry` (`yes` for perishables) · `low_threshold`, `overstock_threshold` in base units · `near_expiry_days`.

**02_pack_sizes_barcodes.csv:** `sku` · `pack_name` · `pack_qty` + `pack_uom` (e.g., `1`,`l` → 1,000 ml) · `barcode` (optional; scan it into the cell; must be unique).

**03_opening_stock.csv:** `sku` · `lot_code`, `expiry_date` (required for expiry-tracked items) · `quantity` + `uom` · `total_value` (what that quantity cost you in total).

**04_menu.csv:** one row per size: `category` · `item` · `description` · `variant` (Regular, Large…) · `price` · `is_default` (one `yes` per item) · `allow_dine_in`/`allow_takeaway`/`allow_delivery`.

**05_modifiers.csv:** `group` (e.g., Milk choice) · `min_select`/`max_select` · `option` · `price_delta` (0 or more) · `applies_to_items` (item names separated by `|`).

**06_recipes.csv:** one row per ingredient per size: `item` + `variant` (must match the menu) · `ingredient_sku` · `quantity` + `uom` · `waste_factor_percent` (extra normally lost, e.g., `5`) · `for_dine_in`/`for_takeaway`/`for_delivery` (cups and lids: takeaway/delivery only) · `prep_note`.

**07_modifier_recipe_rules.csv:** `modifier_option` · `item` · `variant` (empty = all sizes) · `action` `add`/`remove`/`replace`/`scale` · `ingredient_sku` · `replacement_sku` (for replace) · `quantity` + `uom` (for add) · `scale_factor` (for scale, e.g., `1.5`).

**08_suppliers.csv:** `name` · `phone` · `email` · `address` · `notes`.

## How the import behaves

1. **Preview first:** the screen shows what will be created or changed and lists every problem with its row number. Nothing is saved yet.
2. **All or nothing per file:** if any row has an error, nothing from that file is saved.
3. Re-importing the same file is safe: existing SKUs/items are **updated**, not duplicated. Changed prices are recorded in price history. Recipes always become **new draft versions**; the active version is untouched until you activate the draft.
4. Opening stock can be imported **once per item**. Later corrections use a stock count.
5. Every import is recorded in the audit log with who imported which file.
6. An import needs the same permission as doing the same thing on screen (e.g., `inventory.items_manage` for items, `menu.price_change` for prices, `recipes.manage` for recipes). See RBAC.md.

**As built (Phase 4 step 4.9):** the files are matched by their header row, which must be exactly as shipped. Opening stock takes one line per item (for a lot-tracked item, that line becomes its first lot). The menu and choices files need `menu.manage` (the owner by default). Re-importing recipes replaces a draft not yet activated. Problems are listed with the row number as the spreadsheet shows it (the header is row 1).
