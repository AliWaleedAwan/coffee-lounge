# Coffee Lounge — UI/UX Design Specification (Phase 1, package 1E)

> Design specification for review R5. **D-30 decided 19 Oct 2026: clickable HTML prototypes produced in this project** (no Figma). Prototype canvas: <https://claude.ai/artifact/S6w3NNiGLC8Vx3L6BJnPPU>; source files: `docs/prototypes/project/`. Concept background: `docs/phase-0/06-ui-ux.md`. This document is the developer-facing spec; the prototypes show it in use.

## 1. Changes since Phase 0 (because of later decisions)

| Decision | UI consequence |
|---|---|
| D-33 no kitchen device | No KDS screens. A **Pickup** view on waiter devices and the counter replaces it. "Picked up" is the key kitchen action. |
| D-02/D-38 one counter PC | One Electron app hosts the cashier, manager, clerk and owner areas, with fast **PIN user switching** |
| D-03 waiters' own phones | Waiter app must work equally on 3 tablets (landscape) and phones (portrait) |
| D-05b counter QR | Guest takeaway flow ends at "Pay at the counter" with an order number |
| D-07 / D-36 | Approval queue shows only rounds in the user's scope, plus an **escalated** section |
| D-37 transfers | Payment screen has Cash · Card · JazzCash · Easypaisa · Bank |
| No cash drawer | No drawer actions anywhere |

## 2. Design tokens (final proposal, contrast-checked)

All text pairs below were measured against WCAG 2.x. **AA** = ≥ 4.5:1 for normal text.

| Token | Hex | Use | Contrast |
|---|---|---|---|
| `surface.base` | `#FAF7F2` | App background (parchment) | — |
| `surface.raised` | `#FFFFFF` | Cards, sheets, inputs | — |
| `surface.sunken` | `#EDE3D7` | Rails, table headers, selected rows (sand) | — |
| `text.primary` | `#2C211C` | Body and headings (espresso) | 14.65 on base · 12.35 on sunken · AA |
| `text.muted` | `#6E625A` | Secondary labels, timestamps | 5.52 on base · 4.66 on sunken · AA |
| `brand.primary` | `#6B4435` | Primary buttons, active nav (coffee) | White text 8.39 · AA |
| `brand.accent` | `#9A563E` | Accent text/buttons (terracotta, strong) | White text 5.56; on base 5.21 · AA |
| `brand.accent.soft` | `#B86C50` | Large numerals and decoration **only** | 3.71: large text/UI only |
| `status.success` | `#4F634D` text on `#E6EDE4` | Accepted, served, settled | 5.46 · AA |
| `status.warning` | `#7A5200` text on `#FBEFD6` | Low stock, waiting, escalated | 6.07 · AA |
| `status.danger` | `#A23B2A` (text/button), tint `#F8E3DE` | Out of stock, errors, voids | 6.15 on base; white 6.57 · AA |
| `status.info` | `#355574` text on `#E3EAF1` | Neutral info, reprint labels | 6.40 · AA |
| `border.subtle` | `#E2D8CC` | Card and divider lines | — |

Status is never shown by colour alone: always a text label (and usually an icon).

**Branding (DEC-14):** shop name, logo, receipt header and `brand.primary` can be changed in Settings. The app checks the contrast of an owner-chosen colour live and refuses one that fails AA for button text.

## 3. Typography

| Role | Font | Size / weight |
|---|---|---|
| Display (guest menu headings, owner page titles) | **Fraunces** (open licence) | 28–40 px, 600 |
| UI text and numbers | **IBM Plex Sans** (open licence), tabular figures for all money and quantities | 14 / 16 / 18 px, 400–600 |
| Large numbers (totals, change due, KPIs) | IBM Plex Sans | 28–56 px, 600 |
| Urdu item names (if entered) | Noto Nastaliq Urdu | Display only; receipts print English (PRINTING_HARDWARE.md §3) |

Fonts are **self-hosted** in the app (no internet). The prototype loads them from Google Fonts for convenience only. Phase 0 proposed Inter; IBM Plex Sans is proposed instead for clearer tabular numerals and a less generic look (confirm at R5).

## 4. Layout, spacing, touch

- 4 px spacing grid; card padding 16–24 px; radius 12 px cards, 999 px chips.
- Touch targets ≥ 44 px everywhere; ≥ 56 px for primary POS actions (Send, Accept, Picked up, Pay); payment tiles ≥ 80 px.
- Guest phone: single column, bottom sticky cart. Waiter tablet: rail + grid + review pane. Waiter phone: grid + bottom review sheet. Counter PC: list + detail with keyboard shortcuts. Owner: fluid dashboard that stacks to one column on narrow screens.
- Motion: 150–250 ms ease-out for sheets and toasts; respects "reduce motion".

## 5. Component inventory

| Group | Components |
|---|---|
| Actions | Button (primary, secondary, ghost, danger; sizes md / lg / xl-touch), Icon button (with `aria-label`), Press-and-hold button (for irreversible stock actions on touch: optional), Segmented control, Chip (filter / reason) |
| Inputs | Text, Search (with barcode mode), Quantity stepper (large ±), Numeric keypad (cash), PIN pad, Select, Date picker with presets |
| Ordering | Menu card (photo slot, name, price, availability label), Variant picker, Modifier group (required/optional, min/max hint), Cart line, Sticky cart bar, Round review panel |
| Operations | Table tile (state label, time seated, guests, pending/escalated/uncollected badges), Approval card (age timer, scope badge, stock pre-check), Pickup ticket card, Status timeline (guest), Connection banner, Printer banner |
| Money | Bill (rounds grouped, read-only), Totals block, Discount sheet (limit shown), Payment tiles, Change-due display, Step-up approval sheet |
| Data | KPI tile (value, comparison delta, coverage note), Bar/line chart frame, Data table (sticky header, horizontal scroll on narrow screens), Filter bar, Export menu |
| Feedback | Toast, Inline field error, Blocking dialog (irreversible only), Empty state, Skeleton |

## 6. Screen inventory by role

| Role / device | Screens |
|---|---|
| **Guest** (phone, no login) | QR landing · Menu (categories, search, unavailable labels) · Item sheet · Cart · Sent / waiting for staff · Order status timeline · Add more · Request bill · Counter-QR "Pay at counter" · Visit ended · Not on shop Wi-Fi |
| **Waiter** (tablet / own phone) | PIN switch · Floor plan · Table: session + order composer · Approvals (mine / escalated) · Pickup (tickets to collect) · Ready to serve · Bill request |
| **Cashier** (counter PC) | Open sessions · Bill · Lock bill · Payment (cash / card / transfers, split) · Receipt · Takeaway quick order · Counter-QR unpaid queue (Accept & pay) · Delivery board (dispatch / return) · Cash shift · Printer status · Pickup |
| **Manager** (counter PC / tablet) | Live operations · Approvals inbox (voids, discounts, refunds, variances) · Table assignments · Staff activity · Permitted reports |
| **Inventory clerk** (counter PC, off-peak) | Overview & alerts · Lookup / scan · Receive stock · Lots & expiry · Stock count · Waste · Recipes (drafts, activation) · Import · Suppliers · Movement history |
| **Owner** (counter PC) | Overview dashboard · Sales · Profit & margin · Menu engineering · Inventory & waste · Ledger · Expenses · Assets · Users & roles (effective permissions) · Devices · Audit log · Scheduled reports · Settings (shop, branding, tables & QR, printer & templates, thresholds) · System health |

## 7. Priority journeys (prototyped)

| # | Journey | Target | Prototype artboard |
|---|---|---|---|
| J1 | Guest: scan → choose cappuccino, size, oat milk → send → follow status | ≤ 8 taps, ≤ 60 s first time | `Guest.dc.html` |
| J2 | Waiter: add 2 cappuccinos to Table 5 and send (straight to kitchen) | ≤ 5 taps, ≤ 10 s | `Waiter.dc.html` |
| J3 | Waiter: accept a guest's QR round; see what happens when someone else accepted first or stock is short | 1 tap | `Waiter.dc.html` (Approvals) |
| J4 | Waiter/cashier: collect from kitchen, tap **Picked up** | 1 tap per ticket | `Waiter.dc.html` (Pickup) |
| J5 | Cashier: lock bill → cash with change → settled | ≤ 4 actions, ≤ 15 s | `Counter.dc.html` |
| J6 | Cashier: counter-QR takeaway, **Accept & pay** | 2 actions | `Counter.dc.html` (Takeaway queue) |
| J7 | Clerk: scan and receive stock with lot and expiry | ≤ 90 s for 3 items | `Clerk.dc.html` |
| J8 | Owner: overview → top items by margin | ≤ 3 clicks | `Owner.dc.html` |

Plus static boards: key **states** (`States.dc.html`) and **print previews** (`Print.dc.html`).

## 8. Required states (every screen)

Loading (skeleton) · empty · offline device ("Reconnecting…", write buttons disabled) · server starting · unauthorised · duplicate-submit protection (button shows "Sending…" then "Sent") · out of stock / round rejected with reason · price changed · bill locked · printer problem / uncertain print · near-expiry / expired lot · count variance needs approval · step-up approval needed · visit ended (guest) · backup drive missing (owner/cashier banner) · costs incomplete (owner).

## 9. Accessibility checklist

- Real buttons, links and labelled inputs; visible focus ring (2 px `brand.accent` + 2 px offset).
- All text pairs AA (§2); never colour-only status.
- Icon-only buttons have `aria-label`; decorative icons `aria-hidden`.
- Counter app fully keyboard-operable: `/` search, `↑↓` select, `Enter` open, `F2` lock bill, `F4` cash, `F5` card, `Esc` close sheets.
- Live regions announce new approvals and payment results.
- Text resizes to 200 % without loss on guest and owner screens.

## 10. Open points for review R5

1. Fonts: Fraunces + IBM Plex Sans (instead of Inter).
2. Waiter tablets: landscape two-pane composer; waiter phones: single pane with bottom review sheet.
3. Picked up is a single tap with a 5-second **Undo** toast (instead of press-and-hold). The device **holds the request for those 5 seconds** and sends it only when the toast closes, so Undo simply cancels sending. Nothing is posted or reversed, and stock counters still only move forward. If the device goes offline in that window, the toast says "Not sent" and the line stays uncollected.
4. Guest menu shows unavailable items greyed with the label "Unavailable right now" (not hidden).
5. Owner dashboard headline tiles: Net sales · Orders · AOV · Gross margin % (after waste) · Waste cost · Recorded operating result, each with a comparison to the same weekday last week.
