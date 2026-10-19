# 11 — Decision Record 01 (19 Oct 2026)

> The owner's answers to the Phase 0 blockers, what each changes in the design, and the new questions they raise. Register: [10-decision-register.md](10-decision-register.md).

## 1. What was decided and what changed

| ID | Decision | Design change | Docs updated |
|---|---|---|---|
| D-01 | Keep quote as is | None to the technical scope. The commercial risk is accepted by the owner. | 09 R-5 |
| D-02 | Reception PC is the host (iMac 2011, Windows 10 Pro N, 16 GB, 128 GB SSD), no UPS | Host constraints and mitigations: static IP, wired Ethernet, mandatory USB backup drive, no BitLocker (no TPM), hardening, training not to shut down | 02 §2.2, §2.6, §2.12, §2.13 · 07 §7.5 |
| D-03 | One Sonic SNC-101 80 mm printer; no kitchen printer, no drawer, no KDS screen; Sonic SNC-930D scanner; 3 tablets + personal phones; Huawei HG8145V5; HBL terminal | Single print route (kitchen tickets + receipts on one USB printer at the host). Drawer kick not built/tested. Personal phones registered as staff devices. Card reference = HBL slip approval code/RRN. | 02 §2.10 · 03 devices/payments · 08 §8.4 |
| D-04 | Weighted-average + FEFO | FIFO tables dropped; WAC structures final | 03 · 05 |
| D-05 | Delivery: all channels staff-entered, optional customer fields, no fee, own rider, all payment modes, manager handles failures | Delivery status machine, rider handover recorded in-shop (riders are off the LAN on the road), COD custody by rider, failed-delivery manager inbox | 03 `delivery_orders`, `delivery_events`, `staff_profiles` · 04 §4.4 |
| D-05b | Takeaway pay-first; counter QR yes | Counter QR entry point; per-guest takeaway session; **Accept & pay** atomic step; unpaid expiry | 03 `qr_entry_points` · 04 §4.4 |
| D-06 | Reject whole round | No staff editing of guest rounds | 04 §4.2 |
| D-07 | Waiters: assigned tables; cashiers: takeaway + unassigned; managers: all; atomic single acceptance; staff rounds straight to kitchen | `table_assignments`; acceptance-scope check inside the acceptance transaction; queue routing | 03 · 04 §4.2 · 07 matrix |
| D-11 | One shared Wi-Fi; router photos available | No segmentation; whole Wi-Fi untrusted; host static IP outside DHCP pool; AP isolation off; router admin password changed | 02 §2.7 · 07 §7.5 |
| D-29 | Inventory clerk supplies data; date per client | Phase 4 start depends on the data date | — |

### Router access

Please **don't send me router or Wi-Fi passwords**. I can't enter credentials, and they shouldn't be stored in project files. Instead, during the on-site check either send **screenshots** of these router pages (with passwords blurred) or follow a checklist I'll provide and report the results:
1. LAN → DHCP server settings (address pool range).
2. WLAN → basic and advanced settings for each band (SSID, security mode, any "AP isolation" / "SSID isolation" option).
3. Device/system management → whether the admin password is still the default (just yes/no).

## 2. Consequences you should know about

1. **Power is now the biggest operational risk.** With the server on the counter PC and no UPS, every power cut stops QR ordering, waiters, the kitchen and checkout at the same time. An abrupt cut can also lose the last moments of data on a consumer SSD. A small UPS for the **counter PC and the router** is the cheapest, highest-value fix (D-35). Without it, the system can still be built. The design limits the damage (WAL archived to a USB drive, idempotent retries, startup checks), but downtime during cuts is unavoidable.
2. **The host's operating system no longer gets security updates** (Windows 10 support ended 14 Oct 2025; consumer extended updates ended 13 Oct 2026). This PC's CPU can't officially run Windows 11, and the PC sits on the same Wi-Fi as customers. See D-34.
3. **Nobody in the kitchen can tell the system "this is ready".** Stock is consumed at that moment (DEC-05), and waiters/guests see "Ready" from it. Without a kitchen device, someone else must record it (D-33).
4. **Riders can't update the system while out**, because it only works on the shop's network. Delivery and COD handover are recorded when the rider returns. This is designed in, but it means the shop sees "out for delivery" until then.
5. **One printer for everything:** if it runs out of paper, kitchen tickets and receipts stop together. Orders are never lost (they are on screen and re-printable), but keep spare rolls at the counter.
6. **Cash drawer:** the quote lists drawer integration, but no drawer exists. It won't be built or claimed as tested. It can be added later if a drawer is connected to the printer.

## 3. New questions (please answer)

| ID | Question | My recommendation |
|---|---|---|
| **D-33 (blocker)** | No kitchen screen. Who marks items **Ready**? (a) a cheap Android tablet/phone in the kitchen showing the kitchen page, or (b) the waiter/cashier taps **Picked up** when collecting from the kitchen | (a). Any spare tablet or old phone works; the quote already includes the kitchen display software. (b) works if no device can be spared. |
| D-34 | Windows 10 host: buy paid extended security updates (if available to the business), accept the risk with hardening, or plan a newer PC? | Extended updates (if available) + hardening now, replacement PC within 12 months |
| D-35 | Will you add a UPS for the counter PC and router? Is there an inverter/generator in the shop? Is macOS still installed on the iMac (needed to enable auto power-on after a cut)? | Add a UPS |
| D-36 | If the assigned waiter doesn't accept a QR order within 3 minutes, should it be flagged to managers and cashiers and become acceptable by cashiers? | Yes, 3 minutes |
| D-37 | Card on delivery: does the rider carry a **portable** card terminal? Should prepaid orders accept bank transfer / JazzCash / Easypaisa recorded with a reference? | Card on delivery only with a portable terminal; add transfer methods only if you use them |
| D-38 | The scanner is wired: will the clerk use the counter PC (off-peak), or a tablet with a USB-OTG adapter? | Counter PC off-peak |
| D-39 | Staff phones and tablets need a one-time shop certificate install for secure login on the shared Wi-Fi. OK for staff personal phones? | Yes; manager/cashier/owner logins only on devices with it |
| D-40 | Auto-cancel unpaid counter-QR takeaway orders after 30 min? | Yes |
| D-41 | Riders: no app login; the cashier records dispatch and return? | Yes |
| D-29 | Approximate date the clerk can deliver menu, recipes, ingredients and opening stock | Templates will be provided in Phase 1 |
| D-03 | Printer: photo of the rear ports and a self-test printout. Tablets: make/model of the 3 tablets | — |

## 4. Gate status

All nine Phase 0 blockers have answers. **D-33 was decided on 19 Oct 2026:** no kitchen device, and the waiter or cashier taps **Picked up**, which is the stock consumption event (design in 04-workflows §4.2 step 9). There are no open blockers. D-34…D-41 are still awaiting answers. Phase 1 has **not** started; it begins only on your explicit go-ahead.

## 5. Addendum — follow-up answers (19 Oct 2026)

| ID | Answer | Design effect |
|---|---|---|
| D-33 | No kitchen device; waiter/cashier taps **Picked up** | Picked up = prepared = consumption; uncollected-item alerts; "Was it already made?" on cancel (04 §4.2 step 9) |
| D-34 | Stay on Windows 10 iMac, no extended updates; replacement later | **Owner-accepted risk**; hardening mandatory (02 §2.6) |
| D-35 | No UPS, no inverter/generator, no macOS | **Owner-accepted risk**: full outage on every power cut. Try Boot Camp Control Panel auto-restart; paper fallback pad; WAL + nightly backups to USB (02 §2.6) |
| D-36 | Escalate after 3 min; cashiers may accept | As designed (04 §4.2 step 5) |
| D-37 | Portable card terminal: yes. Bank transfer / JazzCash / Easypaisa: yes | `transfer` payment method with provider + required reference + confirming staff; card on delivery recorded on rider return (03, 04 §4.4, §4.6) |
| D-38 | Clerk uses counter PC off-peak | Inventory screens in the Electron app; PIN user switch at the counter |
| D-39 | Shop certificate on staff devices: yes | Staff HTTPS with local CA as designed (02 §2.7) |
| D-40 | Auto-cancel unpaid counter-QR orders after 30 min | As designed |
| D-41 | Riders without login | Riders are staff profiles; cashier records dispatch/return |
| D-29 | Clerk updates data **every week** | Incremental data: items without recipes run as non-stock until completed; COGS coverage shown in reports (09 R-4) |
| D-03 | Printer details and tablet models deferred | Needed before Phase 3 printing work (09 R-11) |

**Gate status after the addendum:** every Phase 0 blocker and follow-up question is answered. The remaining open items (D-08 … D-32 in the register) are non-blocking and each has a recommended default.
