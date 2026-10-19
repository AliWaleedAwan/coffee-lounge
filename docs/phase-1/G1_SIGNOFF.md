# Gate G1 — Phase 1 Design Sign-off

> Phase 1 (design) is complete as of 19 Oct 2026. Signing this sheet approves the design so that **Phase 2 (foundation build) can start**. Nothing has been implemented yet. Anything not ticked stays open and is carried into Phase 2 as a tracked item.

## 1. What is being approved

| Package | Documents | Review | Approved |
|---|---|---|---|
| 1A Foundations | [DECISIONS.md](../DECISIONS.md), [DATABASE.md](../DATABASE.md), [ORDER_STATE_MACHINE.md](../ORDER_STATE_MACHINE.md), [RBAC.md](../RBAC.md) | R1 | ☐ |
| 1B Contracts | [API.md](../API.md), [openapi/phase3.yaml](../openapi/phase3.yaml) | R2 | ☐ |
| 1C Operations | [LOCAL_LAN_HOSTING.md](../LOCAL_LAN_HOSTING.md), [PRINTING_HARDWARE.md](../PRINTING_HARDWARE.md), [WINDOWS_DEPLOYMENT.md](../WINDOWS_DEPLOYMENT.md), [SECURITY.md](../SECURITY.md), [BACKUP_RECOVERY.md](../BACKUP_RECOVERY.md) | R3 | ☐ |
| 1D Domain rules | [RECIPE_INVENTORY.md](../RECIPE_INVENTORY.md), [COST_VALUATION.md](../COST_VALUATION.md), [FINANCE_REPORTING.md](../FINANCE_REPORTING.md), [templates/](../templates/README.md) | R4 | ☐ |
| 1E Design | [UI_UX.md](../UI_UX.md), prototype canvas <https://claude.ai/artifact/S6w3NNiGLC8Vx3L6BJnPPU> | R5 | ☐ |
| 1F Quality | [TEST_PLAN.md](../TEST_PLAN.md), [traceability.csv](../traceability.csv) | R6 | ☐ |

## 2. Provisional decisions to confirm or change

Applied as defaults on the owner's instruction (19 Oct 2026). Details: [DECISIONS.md §3](../DECISIONS.md) and [PLAN.md open review points](PLAN.md).

| ID | Provisional default | Confirm |
|---|---|---|
| D-08 | Quoted price honoured if accepted within 30 min | ☐ |
| D-09 | Scan at an occupied table joins its session; staff can reset guests | ☐ |
| D-10 | Table transfer yes; merge no; stale-session alert after 3 h | ☐ |
| D-12 | Orders allowed after bill request (flagged); bill can't be locked while orders are pending | ☐ |
| D-13 | Split payment yes, split bill no; refunds approved by owner (manager if granted); approver ≠ requester | ☐ |
| D-14 | Discount limits cashier 10 %, manager 20 %; scheduled promotions; no stacking, combos or coupons | ☐ |
| D-16 | No tax; totals rounded to Rs 1 with a visible rounding line | ☐ |
| D-17 | Kitchen ticket prints on acceptance; receipt at settlement; no extra per-round slip | ☐ |
| D-18 | Count variance > 2 % or > Rs 1,000 needs approval; shortfalls recorded truthfully | ☐ |
| D-19 | No depreciation, payables or accrued wages at launch | ☐ |
| D-20 | Owner's own e-mail account; daily day-end + weekly summary | ☐ |
| D-21 | KPI definitions in FINANCE_REPORTING.md §3, incl. recipe-only margins and "Needs recipes" below 95 % coverage | ☐ |
| D-22 | Asia/Karachi; business day ends 04:00 | ☐ |
| D-23 | WAL + nightly encrypted backups to USB; two rotating drives; daily cloud copy when online | ☐ |
| D-24 | Registered devices + PIN quick-switch | ☐ |
| D-25 | Delivery customer details erased after 12 months | ☐ |
| D-27 | English UI; Urdu names on screen only, English on paper | ☐ |
| D-28 | No tips | ☐ |
| D-31 | Ledger "edit" = add/reverse; inventory "delete" = archive; assets included | ☐ |
| D-32 | No remote owner access at launch | ☐ |

Plus the review-point answers listed in [PLAN.md](PLAN.md#open-review-points) (number formats, owner self-refund, guest limits, fonts, Picked-up undo, and others).

## 3. Accepted risks (already decided, restated for the record)

| ID | Risk | Owner decision |
|---|---|---|
| D-34 / SR-1 | Server runs Windows 10 without security updates, on Wi-Fi shared with guests | Accepted, with mandatory hardening |
| D-35 / SR-2 | No UPS: every power cut stops all devices; restart needed | Accepted, with write-safety settings, WAL archive and paper fallback |
| D-01 | Expanded scope delivered under the original quotation | Accepted |

## 4. Inputs still needed (do not block G1)

| Item | Needed before |
|---|---|
| Printer rear-port photo + self-test page (Sonic SNC-101) | Phase 3 printing work |
| Router screenshots, passwords blurred (DHCP, Wi-Fi isolation settings) | Printing QR codes (Phase 7) |
| Tablet make/model (3 waiter tablets) | Phase 3 device testing |
| Menu, recipes, ingredients, opening stock (clerk, weekly) | Phase 4 testing with real data |

## 5. What starts after sign-off (Phase 2, foundation)

Project setup and CI; PostgreSQL migrations generated from DATABASE.md; authentication, device registration and RBAC; idempotency, audit and outbox infrastructure; live-update stream; job worker; health checks; Windows services and installer skeleton; Electron shell; test harness (real database, concurrency, printer simulator). Exit criteria: TEST_PLAN.md §4.

## 6. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| Owner, Coffee Lounge | | ☐ Approved ☐ Approved with changes (listed below) ☐ Not approved | |
| Developer, EEREL | | ☐ Confirmed | |

Changes requested:

1. 
2. 
3. 

---

## Approval record

**Gate G1 approved on 19 Oct 2026** by the owner's instruction in the project session: *"G1 approved: accept all six packages and every provisional default as proposed. Start Phase 2."*

- All six packages (1A–1F): **approved as delivered**.
- All provisional decisions in §2 and all review points in [PLAN.md](PLAN.md#open-review-points): **accepted as proposed** (now CONFIRMED in DECISIONS.md).
- Inputs in §4 remain outstanding and are tracked into Phase 2/3.
- A signed paper copy of this sheet can be added to the project file at the owner's convenience.
