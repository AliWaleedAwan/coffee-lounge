# The shop's own data

`owner-items-2026-11-01.tsv` is the item list the owner gave us on 1 November 2026, exported
from the old POS, kept exactly as received. `convert.py` turns it into
`04_menu_owner.csv`, the menu import template (docs/templates/README.md). The owner
imports it at **Inventory** → **Import** → *Menu items, sizes and prices*: **Preview**
first, then **Import**. All rows go in, or none do. Importing it again changes nothing
(`test/imports/import.test.ts` checks this on every build).

```bash
python3 -I docs/shop-data/convert.py
```

## What the conversion did (to confirm with the owner)

| | Old list | On the menu |
|---|---|---|
| Sizes | Pizzas as separate rows (`Tikka small` … `Tikka XL`, `Spc Small Pizza` …) | One item per pizza with sizes Small, Medium, Large, XL (`Tikka Pizza`, `Special Pizza`, `Extra Topping`) |
| | Pakistani dishes `… Full` / `… Half` | One item with sizes Full and Half (`Red Karhai`, `Mutton Shanwari`, `Beef Korma` …) |
| | `Grill Fish Boneless 1Kg` / `1/2Kg`, same for Rahu | Sizes `1 kg` and `½ kg` |
| | `Biscut`, `Lays`, `Packing`, `Party Charge` at several prices | One item each, sizes `Rs 10`, `Rs 20` … |
| Same name twice | `Extra Sauce` (Steak Beef and Steak Chicken) | `Extra Sauce (Beef Steak)`, `Extra Sauce (Chicken Steak)` |
| | `Donut` (Bakery Items and Walls Ice cream) | `Donut` and `Donut Ice Cream` |
| | `Seekh Kabab Full/Half` (Pakistani) next to `Seekh Kabab` (BBQ) | **`Seekh Kabab Karhai`** (a name I chose: please confirm) and `Seekh Kabab` |
| | `white Boneless` / `White Boneless` | `White Boneless` |
| Category | `Chineese` | `Chinese` |
| Left out | 19 rows with no name and price 0 (IDs 391–400, 427–433, 438, 444) | — |
| Order types | — | All items: dine-in, takeaway and delivery; **Gaming** (PS5, VR, heater, firewood, party charge): dine-in only |

Prices are exactly as given. Names keep the owner's spelling, which prints on receipts.
The owner may want to fix these on screen after the import: Alepeno, Mashroom, Lasanga,
Petty Burger, Margrita, Manchorian, Plane Naan, Capati, Browni, Pasty, Biscut, Penut,
Cocolate, Carimal, Old Fashionend, Caremal, Pullao Dish Dish, Turkish kubab,
Jaman, `PS5 30 Mint`, `VR Set Meta 30 Nint`.

Not carried over, because the menu has no place for it:

- **Barcodes** (`pbarcode`). Numbers 1–217 were the old POS's own key codes. The real
  EAN codes on packaged goods (Pepsi, Nestlé, Walls, Bread & Beyond) belong to inventory
  items (template 02, *Pack sizes and barcodes*), so they can be scanned when stock is
  received. They are in the TSV for when those items are set up.
- **Stock** (`pinstock` −1 everywhere): no item tracks stock until it has a recipe
  (D-29).
- **Discountable** (`pdiscountable`): discounts here follow each role's limit
  (Users & roles), not a flag on the item.
- **Cost** (`pcost`, 0 everywhere): costs come from received stock through recipes.
