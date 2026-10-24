# Coffee Lounge — Decision Log

> Authoritative list of decisions used by the design. Updated 19 Oct 2026 (Gate G0 approved).
> **CONFIRMED** = owner-approved. **ACCEPTED RISK** = owner chose to proceed knowing the risk. **Gate G1 approved 19 Oct 2026: every provisional default in §3 and every review point in phase-1/PLAN.md was accepted as proposed, so all of §3 is now CONFIRMED.**
> History and reasoning: `docs/phase-0/` (especially 10-decision-register and 11-decision-record-01).

## 1. Confirmed client decisions (SRS DEC-01 … DEC-14)

| ID | Decision |
|---|---|
| DEC-01 | Single shop; no multi-branch model |
| DEC-04 | QR orders require staff approval before kitchen |
| DEC-05 | Reserve stock on acceptance; consume on preparation completion (= **Picked up**, D-33) |
| DEC-06 | Insufficient stock blocks affected items |
| DEC-08 | Cash + manual card (+ manual transfer methods, D-37); one consolidated bill per session |
| DEC-09 | Dedicated kitchen and reception roles (kitchen role inactive while no kitchen device, D-33) |
| DEC-10 | Operational ledger + fixed assets; not double-entry |
| DEC-11 | Configurable kitchen tickets, never with prices |
| DEC-12 | Dine-in, takeaway, delivery at launch |
| DEC-13 | No tax/service charge now; history never recalculated |
| DEC-14 | Premium coffee-house theme; replaceable branding |

## 2. Confirmed owner decisions (19 Oct 2026)

| ID | Decision | Status |
|---|---|---|
| D-01 | Keep the quotation as is; scope per SRS v2 | CONFIRMED |
| D-02 | Host = counter PC: iMac 27" Mid 2011, Windows 10 Pro N 22H2, i5-2500S, 16 GB, 128 GB SSD | CONFIRMED |
| D-03 | One Sonic SNC-101 80 mm printer for kitchen tickets + receipts; no cash drawer; no kitchen screen; Sonic SNC-930D wired scanner; 3 tablets + waiters' own phones; Huawei HG8145V5 router; HBL counter terminal + a portable card terminal | CONFIRMED (printer ports/tablet models deferred) |
| D-04 | Perpetual weighted-average cost + FEFO physical picking | CONFIRMED |
| D-05 | Delivery: staff-entered (phone/WhatsApp/walk-in); all customer fields optional; no fee; own riders; prepaid / COD / card on delivery; manager resolves failures | CONFIRMED |
| D-05b | Takeaway pay-first; counter QR for guests | CONFIRMED |
| D-06 | Out-of-stock pending round → reject whole round | CONFIRMED |
| D-07 | Waiters accept for assigned tables; cashiers for takeaway/delivery/unassigned; managers all; one atomic acceptance; staff rounds go straight to kitchen | CONFIRMED |
| D-11 | One shared Wi-Fi for guests and staff | CONFIRMED |
| D-26 | Single kitchen station | CONFIRMED |
| D-29 | Inventory clerk enters/updates data weekly (incremental) | CONFIRMED |
| D-33 | No kitchen device; waiter/cashier **Picked up** = prepared = consumption | CONFIRMED |
| D-15 | "Prepared" = Picked up | CONFIRMED (via D-33) |
| D-34 | Stay on Windows 10 without extended updates; replacement planned later | **ACCEPTED RISK** |
| D-35 | No UPS, no inverter/generator, macOS removed | **ACCEPTED RISK** |
| D-36 | Unaccepted QR round escalates after 3 min; cashiers may then accept | CONFIRMED |
| D-37 | Card on delivery via portable terminal; bank transfer / JazzCash / Easypaisa recorded manually with reference | CONFIRMED |
| D-38 | Clerk works on the counter PC off-peak | CONFIRMED |
| D-39 | Shop certificate installed on staff devices (HTTPS) | CONFIRMED |
| D-40 | Unpaid counter-QR takeaway auto-cancels after 30 min | CONFIRMED |
| D-41 | Riders have no app login; cashier records dispatch/return | CONFIRMED |

## 3. Former provisional defaults: CONFIRMED at Gate G1 (19 Oct 2026)

| ID | Provisional default applied in the design | Confirm at |
|---|---|---|
| D-08 | Price lock: if a price rose after the guest submitted, the quoted price is honoured when accepted within **30 min**; difference recorded as a price-lock adjustment | ✅ G1 |
| D-09 | A scan at an occupied table **auto-joins** the session; staff can "reset guests"; joined phones see all rounds and the total | ✅ G1 |
| D-10 | Table transfer allowed (audited); table merge **not** supported; stale-session alert after **3 h**; no "needs cleaning" state | ✅ G1 |
| D-12 | After bill request, new rounds are still allowed but flagged; **bill lock is blocked while any round is pending**; lock warns (does not block) if accepted items are not yet picked up | ✅ G1 |
| D-13 | Split tender allowed; split bill not supported; refunds by owner (manager only if granted) with step-up approval, refund to original method; requester ≠ approver | ✅ G1 |
| D-14 | Manual discounts (% or fixed, line or bill) with reason; cashier ≤ 10 %, manager ≤ 20 %, above that owner step-up; scheduled item/category promotions (% or fixed, date/day/time windows); no combos, BOGO or coupons | ✅ G1 |
| D-16 | `tax_total = 0` stored on every invoice; whole-rupee prices; invoice total rounded to the nearest **Rs 1** with an explicit rounding line | ✅ G1 |
| D-17 | 80 mm. Kitchen ticket prints automatically on acceptance; customer receipt at settlement; no separate per-round reception slip; reprints labelled | ✅ G1 |
| D-18 | Count variance > 2 % **or** > Rs 1,000 per item needs owner/manager approval; count below reserved → record truth, shortfall alert, block new acceptances for that item | ✅ G1 |
| D-19 | No depreciation, supplier payables or accrued wages at launch; "recorded operating result" label | ✅ G1 |
| D-20 | Owner's own SMTP mailbox; daily day-end PDF + weekly summary | ✅ G1 |
| D-21 | Sales by settlement business date; margin uses each line's frozen COGS on its invoice's date; bill discounts allocated pro-rata to lines; comps = 100 % discount with cost kept | ✅ G1 |
| D-22 | Timezone Asia/Karachi; business day cutoff **04:00**; one cash shift per cashier session on the single counter till | ✅ G1 |
| D-23 | WAL archive (5 min) + nightly encrypted dump to an external USB drive; **two rotating drives** (one kept at home, swapped weekly) + daily cloud copy when online; owner holds decryption key | ✅ G1 |
| D-24 | Registered devices + personal PIN quick-switch; full password for owner and on first login | ✅ G1 |
| D-25 | Keep transactions indefinitely; redact delivery customer name/phone/e-mail/address after 12 months | ✅ G1 |
| D-27 | English UI; Unicode fonts for Urdu item names; "Rs" with thousands separators | ✅ G1 |
| D-28 | No tips at launch | ✅ G1 |
| D-30 | **CONFIRMED 19 Oct 2026: clickable HTML prototypes produced in this project** (no Figma) | — |
| D-31 | Ledger "edit" = create/reverse only; inventory "delete" = archive/reverse; "Resources Management" includes the asset register | ✅ G1 |
| D-32 | No remote owner access at launch | ✅ G1 |

## 4. Operational parameters (settings, changeable by owner)

| Setting | Initial value | Source |
|---|---|---|
| `shop.timezone` | Asia/Karachi | D-22 |
| `shop.business_day_cutoff` | 04:00 | D-22 |
| `orders.price_lock_minutes` | 30 | D-08 |
| `orders.escalation_minutes` | 3 | D-36 |
| `orders.takeaway_unpaid_expiry_minutes` | 30 | D-40 |
| `orders.uncollected_alert_minutes` | 30 | D-33 |
| `orders.pickup_marks_served_dine_in` | true | D-33 |
| `sessions.stale_alert_hours` | 3 | D-10 |
| `billing.cash_rounding_unit` | 1.00 | D-16 |
| `inventory.count_variance_pct` / `_amount` | 2 % / Rs 1,000 | D-18 |
| `privacy.delivery_pii_retention_months` | 12 | D-25 |
| `shop.business_hours` | 00:00–00:00 (always open until the owner sets the hours; guests order by QR only within them) | AT-130 |
| `brand.primary` | #6B4435 (Coffee) | DEC-14 |
