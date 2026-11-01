# Phase 8 — Scan-to-Add Products, One-Click App, Device Setup: Build Plan

> **Approved, 1 Nov 2026, with the recommendations in §5.** Steps 8.1 to 8.4 are built, the wizard's screens not yet clicked through on Windows; 8.5 is next.

| | |
|---|---|
| Goal | (A) Scan a barcode and add or edit a product in one place. (B) Install from one setup wizard with no typing in a console, and open everything from one app icon. (C) One page to add, test and manage the printer, scanner and cash drawer |
| Estimate | 8 steps. Each ends with its tests, verify, e2e, Windows CI and a commit |
| Order | Before the shop visit (7.7) and UAT (7.8), so that those test the final product. The checklists, guides and UAT sheets are updated in step 8.8 |
| Limit | Windows only (the counter iMac runs Windows 10, D-02). Real printer, scanner and drawer can only be proven at the shop; until then they are "tested with the simulator" |

Done first, at the owner's request: [DEMO.md](DEMO.md).

## 1. What exists today

| You asked for | Today | Missing |
|---|---|---|
| Scan to find an item | **Yes:** Inventory → Items and Receive stock both take scans | — |
| Scan an unknown barcode | Only **links the code to an existing item** | Creating a new product from the scan |
| Name, cost, expiry | Name on the inventory item; cost and expiry per delivery in Receive stock; expiry only for items set to track it | One screen for all of it |
| Selling price | On the **menu item**, a separate record with no barcode | Connecting the two, so one form sets both |
| Scan to sell at the counter | **No** | See P8-1 |
| Installer creates everything | **Mostly:** one offline `CoffeeLounge-Setup.exe` already bundles PostgreSQL and Node, creates the database and services, and adds the desktop app | It runs as a console window and asks questions there; no wizard |
| Things start by themselves | **Yes, at Windows start-up** (services, watchdog; counter app at login) | The icon does not check or restart a stopped service; it only says "Server unavailable" |
| Printer setup | Settings → Printers: type the Windows queue name or network address, assign, test print | Picking from a detected list; a guided setup |
| Scanner | Works as a keyboard, nothing to install | A test screen |
| Cash drawer | **Not built** (D-03: none installed) | All of it |

## 2. Part A: scan-to-add products

**Scan anywhere in Inventory → Products:**

- **Known barcode:** the product card opens, ready to edit.
- **Unknown barcode:** a **New product** form opens with the code filled in.

**The form, on one screen:** name, category, photo, selling price, cost, unit and pack size, low-stock level, "has an expiry date", and optionally the quantity on hand with its expiry date.

**Saving** does what takes several screens today, in one transaction: inventory item + barcode + menu item with one size + one-to-one recipe, with stock tracking on. Selling one then takes one off stock. The existing rules stay:

- Changing a selling price needs `menu.price_change` and a reason, and keeps price history.
- Cost comes from deliveries, so editing a product never rewrites past costs. The quantity on hand goes in as an opening balance or a delivery, so the ledger stays correct.
- Expiry belongs to each delivery, not the product: two deliveries can have different dates. Correcting a wrong date on a delivery is an audited change; step 8.2 checks what exists and adds it if not.

Products without a barcode (fries, karhai) stay on the menu as they are. The owner's list gives real barcodes for about 50 packaged goods. Numbers 1–217 are old POS key codes, not printed barcodes, so they are not imported.

## 3. Part B: install once, click once

**Setup wizard** replaces the console: Welcome → options (install folder, shop address) → owner password → key passphrase and USB key folder → progress bar → Finish. It installs PostgreSQL, the database, the services and the firewall rules, and adds the desktop icon, as it does today. Passwords reach the install script through the installer process's environment, never the command line or a file, which the existing unattended path already used. The current command-line options stay for CI and restores.

**The icon** opens a start-up screen showing Database, Server, Background jobs and Printer as they come up. If one is stopped, the app starts it, then opens the login screen. If one fails, it says which and in plain words what to do.

The counter user is not an administrator, so the installer grants that one Windows account the right to start only these three services, and nothing else.

**What stays true (see P8-2):** the services keep starting with Windows and keep running when the app window is closed.

**Still not automatic:**

- Windows SmartScreen warns once, because the installer is unsigned (K-3, P7-7).
- The owner still keeps the backup key and the shop key on a USB key.
- Staff tablets still install the shop certificate once.

## 4. Part C: the Devices page

A new **Hardware** page for the owner and whoever has `printers.manage`; Settings → Printers moves there.

| Device | What the page does | What it cannot do |
|---|---|---|
| **Printer** | Lists the Windows printers it finds; pick one, or type a network address. Choose paper width and what it prints (kitchen, receipts), test print, see its status. **Open Windows printer settings** button | Install an unknown driver by itself. The Sonic SNC-101's driver has to come from the maker: if you give me the file, the page can run it (P8-4) |
| **Scanner** | **Test scanner** box: scan a real product; it shows the code and type and says whether Enter arrived, with the fix if not | Nothing to install: it is a USB keyboard |
| **Cash drawer** | Turn on "Drawer connected to this printer", **Test open**, and choose when it opens: on cash payments and change. **Open drawer** button needs a permission, and every manual open is logged with who and when | A drawer not cabled to the printer's RJ11 port. Works only with a printer and drawer that take the standard pulse command; unverified until one is bought |

Detection runs on the server, which is the counter PC, so it sees that PC's printers. Tablets and phones can open the page but only see the same list.

## 5. Decisions for you

| # | Question | Recommendation | Why |
|---|---|---|---|
| P8-1 | Should scanning at **Bills & payments** add the product to the bill? | **Yes**, on the counter only | You sell Pepsi, juices and ice cream with barcodes. It adds one small step (8.3) |
| P8-2 | Should the system start only when the icon is clicked? | **No.** Keep it starting with Windows, and have the icon check and repair it. To the user it looks the same | If it only ran while the app was open, tablets and QR orders would stop until someone opened it, and closing the window would stop them mid-service. The 04:25 day-end report and 04:35 backups would be missed. It also protects against a crash after a power cut |
| P8-3 | Who may add products by scanning? | Inventory clerks add and edit products; the selling price needs `menu.price_change` as today, and a clerk without it saves the product as **not on sale** until a manager sets the price | Keeps the current separation of duties |
| P8-4 | Can you get the Sonic SNC-101 Windows driver file? | **Yes, if available**; otherwise the technician installs it at the visit | Needed for one-click printer setup. I cannot download or test it blind |
| P8-5 | Build the cash drawer now, though none is bought? | **Yes, kept switched off** until one is connected; it stays unproven on real hardware | Small software step; saves an upgrade later |

## 6. Steps

| Step | What | Done when |
|---|---|---|
| 8.1 ✅ | **New product API:** one transaction creating item, barcode, menu item and recipe; refuses duplicate barcodes; permissions per P8-3 | Tests: stock falls on sale, ledger balances, retry creates no duplicates |
| 8.2 ✅ | **Products screen:** scan to open or create, edit card, photo, expiry correction | e2e with scanner-style typing; accessibility check passes |
| 8.3 ✅ | **Scan to sell** at the counter (if P8-1 is yes): a scan adds the line, and unknown codes say so | e2e; a scan never lands in a text field by mistake |
| 8.4 ✅ | **Setup wizard:** NSIS pages, protected secrets, progress and a log, Finish opens the app | Windows CI: fresh install, upgrade and restore drills all still pass |
| 8.5 | **Start-up screen:** service status, start a stopped service, plain-language errors, limited service right | Windows CI: stop each service, click the icon, app recovers as a non-administrator |
| 8.6 | **Hardware page:** printer detection and guided setup, scanner test | Tests with the simulator; Windows CI lists a real print queue |
| 8.7 | **Cash drawer:** pulse command, open rules, permission and audit log; off by default | Golden file of the bytes; simulator sees the pulse; receipts unchanged with it off |
| 8.8 | **Docs and hand-over:** owner guide, training, checklists (add drawer, scanner test), UAT sheets, known issues, RBAC review, DATABASE and API notes | Doc checks pass; ready for the visit |

## 7. Risks

- **Printer detection under the service account** may not see every queue on a real PC. Typing the name remains as a fallback; checked at the visit.
- **The SNC-930D and SNC-101 are still unverified** (PRINTING_HARDWARE.md §8). Nothing here makes them proven until they are tried at the shop.
- **Installer rewrite:** the wizard wraps `install.ps1` rather than replacing it, so the install, upgrade, rollback and restore drills already proven in CI keep guarding it.
- **Scan to sell** must not catch scans while a cashier is typing in a form; it needs a dedicated, focused scan field.
