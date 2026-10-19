# 10 — Decision Register (requires owner approval)

> Phase 0 · Updated **19 Oct 2026** with the owner's answers to the blocker decisions. **Status** shows what has been decided. A *Recommended default* is advice only and is **not** treated as approval. Consequences and new questions from the 19 Oct answers are in [11-decision-record-01.md](11-decision-record-01.md).

Status: **✅ Decided** · **◐ Partly decided** (open items listed) · **⬜ Open**

Priority: **Blocker** (blocks Phase 1 sign-off or the named design) · **High** (needed before the related build phase) · **Medium** (can use an approved provisional default).

## Decided or partly decided (19 Oct 2026)

| ID | Decision | Owner answer | Status |
|---|---|---|---|
| D-01 | Commercial scope/quote | **Keep as is.** No re-quote or scope change requested. The scope stays as defined in SRS v2. | ✅ |
| D-02 | Host machine | **Reception (counter) PC is the host.** Apple iMac 27" Mid 2011 (iMac12,2), Windows 10 Pro N 22H2, i5-2500S, 16 GB RAM, 128 GB SSD. **No UPS.** | ✅ (risks → D-34, D-35) |
| D-03 | Hardware | Receipt printer **Sonic SNC-101, 80 mm** (connection unknown) · **no kitchen printer**: kitchen tickets print on the receipt printer · **no cash drawer** · scanner **Sonic SNC-930D**, wired (likely USB) · **3 waiter tablets** (model unknown) + other waiters' **own phones** · **no KDS screens** · router **Huawei EchoLife HG8145V5** (PTCL Flash Fiber ONT, dual-band, admin at 192.168.100.1) · **HBL card terminal** at counter (standalone) | ◐ printer connection + tablet models to confirm |
| D-04 | Inventory valuation | **Perpetual weighted-average + FEFO picking** | ✅ |
| D-05 | Delivery | Orders arrive by **phone, WhatsApp and walk-in** (staff-entered) · customer name/phone/email/address **all optional** · **no delivery fee** · **own rider** · statuses: architect to propose · payment: **prepaid, cash on delivery, card on delivery** · failed delivery: **manager handles** | ◐ card-on-delivery feasibility → D-37 |
| D-05b | Takeaway | **Pay first.** **Counter QR for guests: yes.** | ✅ (expiry → D-40) |
| D-06 | Out-of-stock item on a pending round | **Reject the whole round** (reason shown to guest) | ✅ |
| D-07 | Who accepts QR rounds | **Waiters** accept for their **assigned tables** · **cashiers** handle **takeaway and unassigned** orders · **managers** see and can act on **all** orders · acceptance must be **atomic: only one succeeds** · staff-entered rounds **go straight to the kitchen** | ✅ (escalation → D-36) |
| D-11 | LAN / Wi-Fi | **Guests and staff share the same Wi-Fi.** Owner can provide router access/photos for an on-site check. | ✅ (staff HTTPS → D-39) |
| D-26 | Stations | **Single kitchen**, tickets printed at the counter printer (from D-03) | ✅ |
| D-29 | Menu/recipe/ingredient/opening-stock data | **Inventory clerk** supplies it; **date per client** | ◐ date open |
| D-34 | Windows 10 host without security updates | **Stay on the same machine; no extended updates now; replacement to be planned later.** Recorded as an **owner-accepted risk**, mitigated by hardening (02 §2.6) | ✅ accepted risk |
| D-35 | Power continuity | **No UPS, no inverter/generator, macOS not installed.** Every power cut is a full outage. Owner-accepted risk. Auto power-on to be tried via the Windows Boot Camp Control Panel. | ✅ accepted risk |
| D-36 | Escalation of unaccepted QR rounds | **Yes: after 3 min**, flagged to managers and cashiers; cashiers may then accept | ✅ |
| D-37 | Delivery/prepaid payment methods | **Portable card terminal available** → card on delivery supported. **Bank transfer, JazzCash, Easypaisa** recorded manually with a reference | ✅ |
| D-38 | Where the clerk works | **Counter PC, off-peak** (scanner stays on the counter PC) | ✅ |
| D-39 | Staff HTTPS | **Yes**: shop certificate installed once on each staff phone/tablet | ✅ |
| D-40 | Unpaid counter-QR takeaway | **Auto-cancel after 30 min** | ✅ |
| D-41 | Riders | **No app login**; cashier records dispatch and return | ✅ |
| D-29 (update) | Data delivery | **Clerk enters/updates data weekly** (incremental, ongoing), not a one-time load | ✅ |
| D-03 (update) | Printer ports/self-test, tablet models | **Deferred by owner** until needed. Needed before Phase 3 printing work at the latest. | ◐ deferred |
| D-33 | Who records "Ready" without a kitchen screen | **No kitchen device.** The waiter or cashier taps **Picked up** when collecting from the kitchen. That tap is the Ready/prepared event and consumes stock. (Decided 19 Oct 2026.) | ✅ |
| D-15 | Definition of "Prepared" | Resolved by D-33: **Picked up = prepared = consumption** | ✅ |

## Still open (not blockers; recommended defaults can be approved as provisional)

| ID | Priority | Decision | Recommended default |
|---|---|---|---|
| D-08 | High | Price change between submission and acceptance | Price-lock: honour quoted price for 30 min, adjustment recorded |
| D-09 | High | Guest joining an occupied table's session; bill detail on joined phones | Auto-join + staff "reset guests"; joined phones see rounds and total |
| D-10 | Medium | Table transfer/merge; stale sessions; "needs cleaning" | Transfer yes (audited); merge no; stale alert after 3 h; no cleaning state |
| D-12 | High | Bill request & checkout lock | Allow more items after request (flagged); block lock while rounds pending; warn on unserved |
| D-13 | High | Refunds, corrections, split tender/split bill | Split tender yes; split bill no; refunds by owner (or granted manager) with step-up |
| D-14 | High | Discount & promotion scope and limits | Manual % / fixed with reason; cashier ≤ 10 %, manager ≤ 20 %; scheduled item/category promotions; no combos/BOGO/coupons |
| D-16 | Medium | Tax placeholder & cash rounding | `tax_total = 0`; whole-rupee prices; optional Rs 1 rounding line |
| D-17 | High | Receipt/ticket formats; per-round reception slip | 80 mm (confirmed). Kitchen ticket prints automatically on acceptance; final receipt at settlement; no extra per-round reception slip |
| D-18 | Medium | Count approval threshold; reservation shortfall | > 2 % or > Rs 1,000 per item needs approval; shortfall: record truth, alert, block new acceptances |
| D-19 | Medium | Depreciation, payables, accruals | Out of launch scope; "recorded operating result" label |
| D-20 | High | Email provider and schedules | Owner's SMTP mailbox; daily day-end PDF + weekly summary |
| D-21 | High | KPI definitions and timing | Sales by settlement date; frozen line COGS; pro-rata bill discount allocation; comps = 100 % discount |
| D-22 | High | Timezone, business-day cutoff, shifts | Asia/Karachi; cutoff 04:00; one cash shift per cashier session |
| D-23 | High | Backup targets, retention, key custody | WAL + nightly encrypted dump to an **external USB drive** (required: the 128 GB host disk is too small and is the single point of failure) + owner cloud copy when online |
| D-24 | High | Staff login on shared devices | Registered devices + PIN quick-switch |
| D-25 | Medium | Data retention / PII | Keep transactions; redact delivery customer PII after 12 months |
| D-27 | Medium | Language/locale | English UI; Unicode fonts for Urdu item names |
| D-28 | Medium | Tips | None at launch |
| D-30 | High | Figma responsibility and cadence | Per 06-ui-ux §6.9 |
| D-31 | Medium | Quote wording interpretation (ledger "edit", inventory "delete", assets) | Agree |
| D-32 | Medium | Remote owner access | Not at launch |
