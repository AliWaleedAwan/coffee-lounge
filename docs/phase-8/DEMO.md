# Demo mode and the changes before Phase 8

Asked for on 1 November 2026, before step 8.1.

## Demo data

```bash
corepack pnpm --filter @cl/server demo-shop
```

Loads the owner's item list as the real menu (195 items) and inventory (36 barcoded goods, 15
sample ingredients), then made-up people for every role, 12 tables, suppliers, stock movements,
14 days of sales, expenses, assets and a delivery, through the real API. Refused on a database
with sales (`--over-test-sales` for a development database) or one that has had a demo.

While a demo is loaded (`cl.demo_state`, which the application role can only read):

- The top bar has a **Demo** switcher: one click becomes any made-up person, with no password.
- The guest page offers a table picker instead of the QR code.

**Settings → Demo data** deletes it, owner only, typing DELETE, once. Sales, stock, ledger, audit
log, tables, suppliers, assets and made-up people go, and numbering restarts. The menu, inventory
items, recipes, settings and real people stay. The switcher and picker end with it. **Delete the
demo before the shop trades:** until then anyone on the shop network can become the owner.

## Other changes

- **Permissions:** the owner can give any permission (overrides RBAC.md ✕ and 🔒; 0032). Those stay
  marked Sensitive, and only an owner can hand them out. The refund and separation-of-duty checks
  in the services are unchanged.
- **Receipt:** fixed line `POWERED_BY` (printing/documents.ts), editable only in the code; five
  text sizes with A−/A+; a logo, turned into black and white dots in the browser and printed as a
  raster image (GS v 0). Larger sizes and the logo are **unproven on the real printer**.
- **Assets:** more categories, which the owner adds and removes; removal asks Sold, Broken or Lost.
- **Reports:** report and period are dropdowns.
- **Forms:** boxes in a row line up whatever hint sits under them (`.row:has(> .field)`).
- **Continuous local copy:** see BACKUP_RECOVERY.md §1. **Not yet run:** the development login has
  no replication right, so only the pruning has a test. Prove it on Windows before relying on it.
