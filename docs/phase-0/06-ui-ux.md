# 06 — Premium UI/UX Design Proposal

> Phase 0 · Concept for the Figma phase (quoted deliverable 01). The final visual design and every dashboard need **design approval before implementation**. The Figma files themselves will be produced in Phase 1 (G-18: confirm who produces them).

## 6.1 Design principles

1. **Speed beats decoration at the counter.** POS screens are judged by taps and seconds; owner screens by clarity and trust.
2. **One glance, one truth.** Every status is shown with **text + icon + colour**, never colour alone. The UI shows authoritative server state, and while data is stale it says so.
3. **Mistake-proof money and stock actions.** Big, separated destructive actions; confirmations only where something is irreversible; undo where it's safe (cart edits), never for posted money.
4. **Warm, premium, quiet.** Parchment surfaces, espresso type, restrained accent. No gradients-for-the-sake-of-it, no stock-photo clutter.
5. **Brand as data.** Logo, shop name, address and accent colour come from settings. Nothing is hard-coded into markup (DEC-14).

## 6.2 Design tokens (starting palette, contrast-checked)

| Token | Hex | Use | Contrast check (WCAG 2.x) |
|---|---|---|---|
| `surface.base` (Parchment) | `#FAF7F2` | App background | — |
| `surface.raised` (Sand) | `#EDE3D7` | Cards on parchment, table headers | — |
| `text.primary` (Espresso) | `#2C211C` | Body and headings | ~15:1 on parchment ✔ AAA |
| `text.neutral` (Charcoal) | `#2B2927` | Dense tables | ✔ AAA |
| `brand.primary` (Coffee) | `#6B4435` | Primary buttons, active nav | White on coffee ≈ 8.4:1 ✔ AA/AAA |
| `brand.accent` (Terracotta) | `#B86C50` | Highlights, large numerals, focus accents | 3.7:1 on parchment: **large text/UI only**. White on terracotta 3.96:1: **fails AA for normal text**. Don't use it for body text or small-label buttons. |
| `brand.accent.strong` | ~`#9A563E` (to tune in Figma) | Accent text/buttons needing AA | Target ≥ 4.5:1 |
| `status.success` (Sage) | `#637861` | Success fills | 4.48:1 on parchment, **just under AA** for small text. White on sage 4.78:1 ✔ |
| `status.success.text` | ~`#4F634D` (to tune) | Success text on light surfaces | Target ≥ 4.5:1 |
| `status.warning` | amber, to define | Low stock, near expiry, stale | Text + icon always |
| `status.danger` | brick red, to define | Insufficient stock, void, errors | Text + icon always |
| `status.info` | muted slate, to define | Neutral info, reprint labels | |

**Dark theme for KDS** (bright kitchens, long viewing distance): espresso `#1E1714` background, parchment text, lane accents (New = terracotta, Preparing = amber, Ready = sage), all with lane titles and icons.

**Typography (self-hosted, offline):** *Fraunces* (OFL) or a similar refined serif for display headings on owner/customer screens. *Inter* (OFL) for all UI, with **tabular numerals** for prices, quantities and KPIs. Optional *Noto Nastaliq Urdu / Noto Sans Arabic* if Urdu text is needed (G-12). Type scale: 12 / 14 / 16 / 18 / 22 / 28 / 36 / 48, with KDS item text ≥ 24 px.

**Spacing & shape:** 4-pt grid; radius 10–14 px on cards, 999 px on chips; soft single-layer shadows only on raised interactive surfaces.

**Touch:** ≥ 44 × 44 px targets everywhere; ≥ 56 px for primary POS actions; ≥ 64 px for KDS bump buttons and payment method buttons.

## 6.3 Component library (Figma + code parity)

| Group | Components |
|---|---|
| Foundations | Colour/typography/spacing variables, elevation, icon set (one outline set, 24 px grid), motion tokens (120/200/320 ms, reduced-motion respected) |
| Inputs | Button (primary/secondary/ghost/danger; sm/md/lg/xl-touch), Quantity stepper (large ±), Numeric keypad (cash entry), Search with barcode mode, Select/Combobox, Segmented control, Toggle, Date-range picker with presets, PIN pad |
| Commerce | Menu card (image, name, price, availability badge), Variant picker, Modifier tray (required/optional groups, min/max), Cart line, Sticky cart bar, Price summary, Discount chip, Payment method tile, Change-due display |
| Operations | Table tile (state, timer, guest count, pending badge), Floor plan canvas, Approval card, Ticket card (KDS), Status timeline, Stock badge (OK/Low/Out/Expiring), Printer status pill, Connection banner |
| Data | KPI tile (value, delta vs comparison, sparkline, "incomplete data" note), Chart frames (ECharts theme), Data table (sticky header, column chooser, pagination, row drill), Filter bar, Export menu |
| Feedback | Toast (non-blocking), Inline validation, Blocking dialog (for irreversible actions only), Step-up approval sheet (manager PIN), Empty states, Skeleton loaders, Offline/reconnecting banners |
| Print previews | Kitchen ticket (58/80 mm), Receipt, Round slip, Refund slip, Report PDF cover/page |

## 6.4 Navigation hierarchy by role

```text
Customer (mobile web, no login)
  QR landing → Menu (categories, search) → Item detail (variants, modifiers, notes)
  → Cart → Submit → Order status (rounds timeline) → Add more → Request bill

Waiter (tablet/phone)
  PIN/Login → Floor plan ─┬→ Table → Order composer → Review → Submit
                          ├→ Approvals (my tables / all)
                          ├→ Ready to serve
                          └→ My active rounds

Kitchen / Bar (KDS, landscape screen)
  Station select (once per device) → Lanes: New | Preparing | Ready → Ticket detail → Recalled/Completed (last 2 h) → Reprint

Reception / Cashier (Electron, keyboard + mouse/touch)
  Open sessions (search) → Bill → Lock → Payment → Receipt
  Takeaway quick order · Approvals · Cash shift (open/paid-in/out/close) · Receipts (reprint/refund*) · Printer status

Manager
  Live operations (tables, approvals, kitchen load, alerts) · Orders · Kitchen monitor · Staff activity
  · Shift/day-end · Permitted reports · Approvals inbox (voids, discounts, count variances)

Inventory clerk
  Overview (alerts) · Lookup/Barcode · Receive stock · Lots & expiry · Stock counts · Wastage · Suppliers
  · Movement history · Recipes (if permitted)

Owner (Electron or desktop browser)
  Overview · Live operations · Sales · Profit & margin · Menu · Recipes · Inventory · Purchasing
  · Waste & expiry · Ledger · Expenses · Assets · Users · Roles & permissions · Audit log
  · Scheduled reports · Settings (shop, branding, tables & QR, printers & templates, thresholds) · System health
```

Navigation is **generated from effective permissions**: users never see menu entries they can't use. The server still enforces every call.

## 6.5 Key screens by role

### Customer (mobile-first, ≤ 150 KB JS gz target)
- **QR landing:** shop logo/name, "Table 5", a single "View menu" CTA. If the table is unavailable or blocked: a friendly message.
- **Menu:** sticky category chips; search; cards with photo placeholder, name, short description, price "from Rs 550", tags; unavailable items greyed with an "Unavailable" label (still visible, not orderable).
- **Item sheet:** size segmented control, modifier groups with clear required/optional labels and per-option price, notes (120 chars), quantity, "Add · Rs 1,300".
- **Cart:** editable lines, total "estimated, staff will confirm", one prominent **Send to staff** button.
- **Status:** per round: *Waiting for staff → Accepted → Being prepared → Ready → Served* (or *Not accepted: reason*), as a calm animated timeline with a reduced-motion fallback. Buttons: **Order more** and **Request bill**.
- **States:** offline ("You're not connected to Coffee Lounge Wi-Fi"), bill being prepared (ordering paused), session closed ("Thanks! Scan again to start a new order").

### Waiter (tablet landscape + phone portrait)
- **Floor plan:** table tiles positioned by area (configurable drag layout in settings), each showing number, state label, time since seated, guest count, a pending-approval badge and a "ready to serve" badge. Filter: My tables / All.
- **Order composer:** left = category rail + item grid (large tiles); right = live round review (sticky). Tapping an item with no required modifiers adds it instantly (fast path). Long-press/second tap opens modifiers. "Repeat last round" chip. Notes per line. **Send** button shows item count and total.
- **Approvals:** card per pending round: table, age timer, lines, notes, a stock pre-check pill (OK/Short), **Accept** (primary) / **Reject** (with reason chips).
- **Ready to serve:** list grouped by table; tap **Served**.

### Kitchen / bar KDS
- Three lanes; tickets sorted by acceptance time (oldest first), with the age timer turning amber/red at configurable thresholds (also as text: "12 min").
- Ticket: large table/order-type header ("T5 · Dine-in", "Takeaway · Ali"), ticket number, ADD-ON/CORRECTION banners, lines with qty, size and modifiers on separate lines; **notes highlighted** in a boxed callout. **No prices anywhere.**
- Actions: tap the ticket → *Start*; tap a line → *Ready* (or "All ready"); *Bump* to complete. Undo is available for 10 s on Start/Bump only (status-only). Ready (consumption) is not undoable; it uses a press-and-hold to avoid accidental taps.
- Correction/void tickets appear at the top with a striped warning style and require an *Acknowledge* tap.
- Printer pill in the header: "Bar printer · Paper out", with **Reprint**.

### Reception / cashier (Electron)
- **Open sessions:** searchable list/grid (table, takeaway name, total, status, time). Keyboard: `/` search, `↑↓` select, `Enter` open, `F2` lock bill, `F4` cash, `F5` card.
- **Bill:** rounds shown as immutable groups, line-level status chips, discounts panel (shows limits), totals. **Lock bill** CTA with the pre-checks listed ("1 round pending approval: resolve first").
- **Payment:** two huge tiles **Cash** / **Card (manual)**. Cash: keypad + quick-tender buttons (exact, next 100/500/1000/5000) and a giant "Change: Rs 350". Card: amount + optional slip reference. Split tender supported.
- **Cash shift:** open with float; paid-in/out with reasons; close with denomination count helper → expected vs counted → variance → submit for approval.
- **Takeaway quick order:** compact composer; pay-first flow (D-05b).

### Manager
- **Live operations:** occupancy strip, approvals waiting (with oldest age), kitchen load per lane, alerts (stock, printer, stale reservations), cash shift status.
- **Approvals inbox:** voids after preparation, discounts over limit, count variances, refund requests. Each shows who/what/why with approve/deny.

### Inventory clerk
- **Lookup:** a search field that is **always focused** in barcode mode; HID scanner input (fast keystrokes + Enter) is detected and routed; the result shows the exact SKU/pack, on hand / reserved / available, lots with expiry, and the next actions (Receive, Waste, Count).
- **Receive stock:** supplier, invoice ref; scan → line with pack qty × pack size = base qty shown explicitly ("6 × 1 L = 6,000 ml"), cost, lot, expiry (required when the item tracks expiry). Post shows a summary.
- **Counts:** choose scope (all / category / item list) → blind count option (book qty hidden) → variance review with value → submit.
- **Alerts:** each alert has a next step (Reorder note, Count now, Record waste).

### Owner
- **Overview:** KPI row (Net sales, Orders, AOV, Gross margin %, Waste cost, Recorded operating result*), each with a comparison period and a drill link; revenue by hour/day; item popularity × margin quadrant; alerts. *Labelled as recorded result, not statutory profit.
- **Reports:** a consistent filter bar (period presets: hour/day/week/month/year/custom, order type, category, item, staff, payment method, supplier) → chart → table → export (CSV/PDF). The footer of every report states the formula and data source ("Net sales = Gross − Discounts − Refunds; by settlement date; tax = 0").
- **Roles & permissions:** matrix of roles × permission groups with toggles; user detail shows **effective permissions** with the source of each (role / override grant / override deny); changes require a reason and are audited.
- **Settings:** shop profile and branding (logo upload, accent override with live contrast check), tables & QR (print sheet), printers & templates (live 58/80 mm preview), thresholds, business day cutoff.
- **System health:** services, DB, last backup and verification, print queue, worker heartbeat, internet status, disk space.

## 6.6 Device behaviour

| Device | Layout | Notes |
|---|---|---|
| Guest phone (portrait, 360–430 px) | Single column, bottom sticky cart | No hover reliance; works on iOS Safari and Android Chrome (versions to verify in matrix) |
| Waiter tablet (landscape 1024–1366) | Two-pane composer | Keep-awake via kiosk settings; registered device |
| Waiter phone (portrait) | Single pane + bottom sheet review | Same flows |
| KDS (landscape 1920×1080, wall/counter) | Three lanes, dark theme | Kiosk/full-screen browser, auto-reconnect, no login timeout (device-bound session) |
| Reception PC (Electron, ≥ 1366×768) | Dense list + detail, keyboard shortcuts | Printer/drawer status visible |
| Owner desktop | 12-col grid, data-dense | Charts lazy-loaded |

## 6.7 Priority user journeys & targets (to validate in prototype tests)

| Journey | Target |
|---|---|
| Guest: scan → submit 2 drinks with a size + 1 modifier | ≤ 60 s for a first-time user; ≤ 8 taps |
| Waiter: add "2 × Cappuccino Regular" to Table 5 and send | ≤ 5 taps, ≤ 10 s |
| Waiter/manager: accept a pending QR round | 1 tap from approval card (+ reason when rejecting) |
| Barista: mark a ticket's lines ready | 1 press-and-hold per line or "All ready" |
| Cashier: lock bill and settle exact cash | ≤ 4 actions, ≤ 15 s |
| Clerk: receive 3 scanned items with lot/expiry | ≤ 90 s |
| Owner: from overview to yesterday's top 10 items by margin | ≤ 3 clicks |

## 6.8 Required state designs

Loading/skeleton · empty · offline device · server unreachable · reconnecting (stale data, actions disabled) · duplicate-submit protection (spinner + disabled + "Sent") · unauthorised (no access page, never a broken screen) · out of stock / partially unavailable round · price changed since submission · bill locked · printer offline / paper out / uncertain print · near-expiry / expired lot · count variance over threshold · step-up approval required · server starting/upgrading.

## 6.9 Figma plan

| Page | Contents |
|---|---|
| 00 Cover & status | Version, approval status per flow |
| 01 Foundations | Variables (colour modes: light, KDS dark, brand override), type, spacing, icons, motion |
| 02 Components | All components with variants and states, auto-layout, matching code names |
| 03 Patterns | Filter bar, approval card, bill, payment, step-up, banners |
| 04–10 Role screens | Customer, Waiter, Kitchen, Reception, Manager, Inventory, Owner: desktop/tablet/mobile frames |
| 11 Print | Kitchen ticket, receipt, round slip, refund slip, report PDF |
| 12 States | Every state in §6.8 for each role |
| 13 Prototypes | Clickable flows for the §6.7 journeys + cancel/partial flows |
| 14 Handoff | Redlines, token export (JSON → CSS variables), accessibility notes |

**Review cadence:** foundations and components → customer + waiter + KDS → reception + manager → inventory → owner/reports. Each is approved before the matching build phase. Usability check: 3–5 real staff members run the §6.7 journeys on clickable prototypes.
