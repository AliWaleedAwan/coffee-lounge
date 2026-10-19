# Coffee Lounge — Phase 0 Discovery & Architecture Report

| | |
|---|---|
| Status | **Blocker answers received 19 Oct 2026** ([decision record 01](11-decision-record-01.md)). All blockers and follow-ups (D-01…D-07, D-11, D-29, D-33…D-41) answered. Remaining open items are non-blocking. **Awaiting owner go-ahead for Gate G0.** No application code or migrations have been written. |
| Date | 18 October 2026 (updated 19 October 2026) |
| Inputs | EEREL Quotation ERL-2608-0144 (PDF, read in full) · CL-SRS-002 v2.0 · Engineering Master Prompt v2.0 |
| Repository | Greenfield: the project folder contained only the quotation PDF |

## Contents

| # | Document | Covers |
|---|---|---|
| 01 | [Requirements & scope](01-requirements-scope.md) | Quote findings, traceability of every requirement, gaps/conflicts, commercial scope buckets |
| 02 | [Architecture](02-architecture.md) | Stack, modules, Windows services, host options, LAN/HTTPS, realtime, jobs, printing, Electron, offline behaviour, backup, upgrades |
| 03 | [Data model](03-data-model.md) | Conventions, ERD, table catalogue, invariants, atomic operations, lock order, indexes |
| 04 | [Workflows](04-workflows.md) | State machines, QR/waiter/takeaway/delivery flows, cancellations, checkout, inventory flows, idempotency, concurrency, failure recovery |
| 05 | [Inventory costing](05-inventory-costing.md) | WAC vs FIFO worked examples, recipe cost, FEFO, recommendation |
| 06 | [UI/UX](06-ui-ux.md) | Design tokens (contrast-checked), components, navigation, screens per role, journeys, Figma plan |
| 07 | [RBAC & security](07-rbac-security.md) | Permission matrix, auth, QR/session isolation, network/host hardening, audit |
| 08 | [Quality & testing](08-quality-testing.md) | Test layers, measurable acceptance criteria, scenario catalogue, hardware verification |
| 09 | [Roadmap](09-roadmap.md) | Phases, dependencies, deliverables, tests, risks, estimates, client data needed |
| 10 | [Decision register](10-decision-register.md) | All decisions with status, priority and recommended defaults |
| 11 | [Decision record 01](11-decision-record-01.md) | 19 Oct answers, their design consequences, new questions D-33…D-41 |

## Executive understanding

Coffee Lounge needs a single-shop POS and management suite that keeps running on the shop's local network with no internet. Guests order from table QR codes; staff approve those orders before anything reaches the kitchen. Waiters order from tablets, the kitchen works from a display and no-price tickets, and reception settles one consolidated bill per visit in cash or manually recorded card. Ingredient stock is reserved on acceptance and consumed exactly once when an item is prepared. The owner gets permissions control, an operational ledger, an asset register, and reports that reconcile to the underlying transactions.

**Recommended architecture in one paragraph:** one Windows host runs PostgreSQL plus a TypeScript Node.js modular monolith as two Windows services (API and worker). Every device is a browser client over the LAN, except reception/admin, which uses a hardened Electron shell that is only a client. All writes go through authorised HTTP APIs inside PostgreSQL transactions, with row locks, unique source keys and same-transaction idempotency records. Server-Sent Events carry change *hints* only, and clients always refetch authoritative state. A Postgres-backed job queue handles printing, email and reports durably. No Redis, no message broker, no cloud dependency.

## Most important findings

1. **The quote assumed public cloud hosting** ("web-based", Hostinger/GoDaddy, public menu page). The offline LAN + Windows + Electron requirement replaces that model. It needs commercial confirmation (D-01).
2. **The quote has no Kitchen or Cashier/Reception roles**, no fixed-asset register by name, and no barcode, expiry, purchasing, cash-shift, export or scheduled-email features. These are client additions.
3. **The quote expired on 30 Sep 2026.** Scope and price should be reconfirmed before Phase 1.
4. **The SRS status chain is ambiguous.** I propose separate state machines for session, round, line (quantity-aware), ticket, invoice and reservation, with "Ready" defined as the consumption event.
5. **Guest QR ordering is only as reliable as the router.** Client isolation, captive portals and phone Private DNS can silently block it. An on-site router test is a blocker before QR codes are printed.
6. **Costing recommendation:** perpetual weighted-average with FEFO physical picking. Worked example: WAC COGS Rs 13,957.40 vs FIFO Rs 13,745.00 on the same events. FIFO gives identical cups different costs on the same afternoon.
7. **Brand palette check:** terracotta `#B86C50` fails WCAG AA for normal text (3.7:1 on parchment, 3.96:1 for white text). Sage `#637861` misses AA text contrast on parchment by a hair (4.48:1). Darker text variants are proposed.
8. **A physical stock count can legitimately show less than is reserved.** The design records the truth and raises a shortfall alert rather than rejecting the count.

## Assumptions (to confirm)

- **ASSUMPTION:** Shop timezone Asia/Karachi (UTC+5, no DST), currency PKR with whole-rupee prices.
- **ASSUMPTION:** Delivery orders are entered by staff only (no guest delivery channel).
- **ASSUMPTION:** Waiter-entered rounds may go straight to the kitchen for users with acceptance permission (supported by the quote's wording "sending orders to the kitchen").
- **ASSUMPTION:** Expected volume is hundreds (not thousands) of order lines per day.
- **ASSUMPTION:** English UI; Urdu only as item-name text unless requested.
- **ASSUMPTION:** "Resources Management" in the quote includes the fixed-asset register.

## Not claimed

- No hardware integration is claimed to work until tested with the actual models on site.
- Performance, RPO and RTO figures are proposals to verify on the chosen host.
- Email delivery is at-least-once (a duplicate is possible in rare network failures), not exactly-once.
- No operation is possible when the host, LAN or power is down. A paper fallback procedure is recommended instead.

## Decisions requiring owner approval

> **Update 19 Oct 2026:** the nine blockers below have been answered. See [decision record 01](11-decision-record-01.md). The current open list is in the [register](10-decision-register.md). The new blocker is **D-33** (who marks items Ready without a kitchen screen).

**Blockers (original list, now answered):**

1. **D-01** Commercial: reconfirm the expired quote and price the client-added scope (deployment change, kitchen/cashier roles, reservations, lots/expiry, barcode, purchasing, counts, assets, cash shifts, exports, scheduled email).
2. **D-02** Host: dedicated Windows PC (recommended) or reception PC.
3. **D-03** Hardware list: models and connections of printers, drawer, scanners, tablets, KDS screens, router.
4. **D-04** Inventory valuation: weighted-average (recommended) or FIFO.
5. **D-05** Delivery workflow (7 questions in 04-workflows §4.4).
6. **D-06** Insufficient stock on a pending round: reject whole round (recommended launch default) / staff-edit then accept / never automatic partial.
7. **D-07** Who may accept QR orders; whether staff-entered rounds are accepted on submit.
8. **D-11** Router/LAN: guest and staff network setup, fixed host IP, HTTPS approach (needs on-site test).
9. **D-29** Who supplies menu, recipes, ingredients and opening stock, and by when.

**High-impact. Needed before the related build phase:** D-05b takeaway payment timing · D-08 price-lock rule · D-09 guest session joining · D-12 bill request & checkout lock · D-13 refunds/split tender · D-14 discount limits & promotion types · D-15 "Ready = consumption" definition · D-17 receipt formats and per-round reception slip · D-20 email provider · D-21 KPI definitions · D-22 timezone/business-day cutoff · D-23 backup targets & key custody · D-24 shared-device staff login · D-26 bar/kitchen stations · D-30 Figma responsibility.

**Medium. A provisional default is acceptable if approved:** D-10 table transfer/merge · D-16 tax placeholder & cash rounding · D-18 count approval thresholds · D-19 finance scope (no depreciation/payables at launch) · D-25 data retention · D-27 language · D-28 tips · D-31 interpretation of quote wording (ledger "edit", inventory "delete", assets) · D-32 remote owner access.

---

### ⛔ Stop gate

Phase 0 is complete. **No Phase 1 work, code, or migrations will start until the owner confirms the blockers above and approves this report (Gate G0).** Partial approval is fine: for example, approving D-04 and D-06/D-07 lets ERD and workflow finalisation start while hardware and commercial items are resolved.
