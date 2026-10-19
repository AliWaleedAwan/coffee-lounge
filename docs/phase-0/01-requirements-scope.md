# 01 — Requirements & Scope Analysis

> Phase 0 deliverable · Status: **Draft for owner approval** · Date: 18 Oct 2026
> Sources inspected: `Quotation/Eerel Quotation.pdf` (ERL-2608-0144, 4 pages), `Coffee_Lounge_Requirements_Specification_v2.md` (CL-SRS-002 v2.0), `Coffee_Lounge_Engineering_Master_Prompt_v2.md` (v2.0).
> Repository state: **greenfield** — `/Users/wolverine/Coffee Shop` contains only the quotation PDF. No code, schema, or existing conventions to preserve.

Labels: **CONFIRMED** (stated in quote or locked decision) · **ASSUMPTION** (architect inference, needs confirmation) · **RECOMMENDED** (professional advice, not contracted) · **BLOCKER** (cannot design/build the affected part until decided) · **OPTIONAL** (only if approved).

Scope tags (from SRS): **[Q]** quotation · **[C]** client-added/confirmed after quotation · **[R]** recommended · **[TBD]** unresolved.

---

## 1.1 Findings from reading the actual quotation PDF

The SRS summarises the quotation, but the PDF itself shows several things that matter. These are evidence-backed and should be reviewed first.

| # | Finding (evidence) | Impact | Classification |
|---|---|---|---|
| F-01 | Quote describes a **"custom, web-based"** system with **"Hosting & Domain … approx. PKR 10,000 (e.g. Hostinger, GoDaddy)"** and a **"Public menu page"** (p.1–2). | The contracted deployment model was **public cloud web hosting**. The current requirement (offline LAN, Windows host, Electron, services) **replaces** that model. Hosting/domain spend is probably unnecessary for core operations, but a Windows host PC, UPS and backup media become client costs instead. | **BLOCKER (commercial)** — confirm the deployment change in writing. |
| F-02 | Quote roles are **Owner, Manager, Waiters (×3), Clerk (Inventory), Customer** (p.3). There is **no Kitchen Staff role and no Cashier/Reception role**. | Kitchen and Reception roles/interfaces (DEC-09) are **client-added [C]**. The quote's KDS is a "display", not necessarily a logged-in role. Checkout/cash-shift UI has no quoted line item. | **[C]** — scope addition, confirm commercially. |
| F-03 | "Digital Ledger (**Resources Management**) — Integrated financial ledger with **view and edit access** granted per role" (p.2). | (a) A **fixed-asset register** is the SRS's *interpretation* of "Resources Management"; the quote doesn't name assets. (b) "**Edit** access" conflicts with immutable financial history. | (a) **ASSUMPTION** → confirm. (b) Resolve as "edit = create entries and authorised corrections via reversal, never mutate posted entries". |
| F-04 | Owner control: "Allow or block adding / **deleting** inventory" (p.3). | Conflicts with append-only stock history. | Resolve as **archive items / reverse movements with audit**, never hard delete posted records. |
| F-05 | Customer page places orders for **"dine-in, takeaway or QR-code table ordering"** (p.1, p.3). Delivery appears only in "Order types: dine-in, takeaway & delivery" (p.3). | A takeaway order from the customer page implies a **non-table customer entry point** (e.g., counter QR). With LAN-only hosting, a customer can only reach it while on the shop's Wi-Fi. Delivery is a staff-entered type, not a customer channel. | **TBD** — confirm takeaway QR channel; delivery = staff-entered only (**ASSUMPTION**). |
| F-06 | "Waiters … **sending orders to the kitchen**" (p.3). | Supports waiter-entered rounds going straight to kitchen (acceptance in the same step) rather than through the QR approval queue. | **ASSUMPTION** → decision D-07. |
| F-07 | "Secure authentication & **encrypted data**" (p.3). | The client may expect encryption at rest. Need to define this: TLS in transit (staff), disk encryption (BitLocker) on host, and encrypted backups. Do not claim column-level encryption unless built. | **[Q]**, definition needed. |
| F-08 | Reporting: daily/weekly/monthly; profit margin "comparing revenue against ingredient **and operating cost**"; shift/day-end summaries (p.3). | Quote covers operating-cost comparison, so a *recorded operating result* is in scope. Hourly/yearly/custom filters, CSV/PDF export and scheduled email are **not** in the quote. | Exports/email/extra filters: **[C]**. |
| F-09 | The SRS says "quote project wording says 'css'". **The quotation PDF has no export wording at all.** | The source of "css/CSV" must be another document (client brief). | **TBD** — confirm where the export requirement came from. |
| F-10 | Quote validity ended **30 Sep 2026**; terms are 50 % advance and on-site visits billed separately (p.4). | Today is 18 Oct 2026, so the quote has expired. Training is described only as a "walkthrough". | **BLOCKER (commercial)**. |
| F-11 | "Three synchronised waiter order-taking screens" (p.1). | This is a deliverable count, not a licence limit. The design does not cap terminals. | **CONFIRMED** (SRS agrees). |
| F-12 | Quote is silent on purchasing, suppliers, barcodes, lots/expiry, stock counts, reservations, cash shifts, assets, exports, scheduled email, Electron and Windows services. | All are **[C]** or **[R]**. Together they are a large scope expansion, roughly doubling the inventory and finance work compared with the quoted add-ons. | **Commercial decision D-01**. |

---

## 1.2 Confirmed decisions (locked, will not be overridden)

DEC-01 … DEC-14 from SRS §1.2 are accepted as written. Two of them interact with the quote:

- **DEC-09 (kitchen + reception roles)** is confirmed by the client but was not quoted (F-02).
- **DEC-12 (delivery at launch)** is quoted as an order type, but no workflow is defined (BLOCKER D-05).

---

## 1.3 Requirement traceability matrix

Legend for "Design status": **Ready** = can be designed in Phase 1 without further input · **Default** = designable with a recommended default awaiting approval · **Blocked** = needs a decision first.

### Menu & recipes

| ID | Requirement (short) | Source | Design status | Notes |
|---|---|---|---|---|
| MENU-001 | Categories/items CRUD + archive, media, sort, price, availability, order-type eligibility | Q | Ready | Archive, never delete if referenced. |
| MENU-002 | Variants/sizes, modifiers, extras, exclusions, notes, discounts/promotions | Q | Default | Promotion *types* are undefined → D-14. |
| MENU-003 | Versioned recipe per sellable variant, yield/waste factor, prep instructions | C | Ready | |
| MENU-004 | Modifiers adjust recipe quantities and price | C | Ready | Modeled as recipe deltas (add/replace/remove). |
| MENU-005 | Block enabling a stock-consuming variant without a recipe | R | Ready | Explicit "non-stock" flag for exceptions. |
| MENU-006 | Immutable price/recipe/modifier snapshot on accepted lines | C | Ready | |
| MENU-007 | Controlled UOM conversions within one dimension | C | Ready | Per-item density conversions forbidden unless explicitly defined. |
| MENU-008 | Allergen/dietary tags, no inference | R | Ready | OPTIONAL display. |

### Tables, QR, sessions

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| TABLE-001 | Table ID, display name, opaque QR token | C (QR ordering is Q) | Ready | |
| TABLE-002 | QR opens local URL on shop Wi-Fi; no public DNS | C | **Blocked** on LAN survey | D-11 (Wi-Fi segmentation, client isolation, host address). |
| TABLE-003 | Server resolves table; client can't override | C | Ready | |
| TABLE-004 | Multiple devices share a session without exposing prior guests | C | Default | Auto-join vs join-code → D-09. |
| TABLE-005 | One active session per table | C | Ready | Partial unique index. |
| TABLE-006 | Available / Occupied / Checkout Requested / Settled | C | Ready | Table state is **derived** from session state. |
| TABLE-007 | Settled session immutable; new diners new session | C | Ready | |
| TABLE-008 | Customer access expires with session | C | Ready | Guest tokens bound to session ID. |
| TABLE-009 | Stale/abandoned sessions, blocked tables, transfer/merge | R/TBD | Default | Recommend: transfer = yes (audited); merge = **not at launch**. D-10. |

### Orders

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| ORD-001 | Orders from QR, waiter, reception; dine-in/takeaway/delivery | Q/C | Default/Blocked | Delivery blocked (D-05). |
| ORD-002 | QR orders Pending Staff Approval, no stock/kitchen | C | Ready | |
| ORD-003 | Atomic approval with revalidation and reservation | C | Ready | |
| ORD-004 | No silent partial approval; partial policy TBD | C/TBD | Default | D-06. |
| ORD-005 | Idempotent acceptance | C | Ready | |
| ORD-006 | Validated status transitions | C | Ready | **Conflict:** the listed single chain mixes round and line states and uses "Delivered" for both serving and delivery orders. Proposal splits them (see 04-workflows §4.2). |
| ORD-007 | Add-on rounds share session/bill, new KOT | C | Ready | |
| ORD-008 | Post-acceptance changes via revisions/voids | C | Ready | |
| ORD-009 | Actor/time/before-after/reason/causation | C | Ready | |
| ORD-010 | Separate fulfilment, invoice, table states | C | Ready | |
| ORD-011 | Reconnect shows authoritative state | C | Ready | |
| ORD-012 | Checkout lock prevents unnoticed additions | C | Default | D-12. |
| ORD-013 | Bill request blocks/permits new items | R/TBD | Default | D-12. |
| ORD-014 | Customer contact only where relevant | Q | Ready | |
| ORD-015 | Delivery flow defined before build | C | **Blocked** | D-05. |
| ORD-016 | Collision-free order/bill numbers | C | Ready | Single DB → DB sequences/counters. |
| ORD-017 | No silent price increase between submit and accept | R | Default | D-08. |

### Kitchen

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| KDS-001 | New/preparing/ready/completed lanes | Q | Ready | |
| KDS-002 | Configurable ticket template | C | Default | Paper width depends on printer model (D-03). |
| KDS-003 | Never selling prices or payment data | C | Ready | Enforced structurally (template context has no price fields). |
| KDS-004 | New ticket per round; auditable corrections/voids | C | Ready | |
| KDS-005 | Prepared ≠ served; consume at Prepared exactly once | C | Ready | "Prepared" = moved to **Ready** lane (definition to approve, D-15). |
| KDS-006 | Live updates; resync on reconnect | Q/C | Ready | |
| KDS-007 | Durable print jobs, labelled reprints | C | Default | Hardware-dependent (D-03). |
| KDS-008 | Station routing (bar/kitchen), timers, sounds | R/TBD | Default | Ask: are drinks made at a bar station that uses the KDS? (Q-list). |

### Inventory

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| INV-001 | on_hand / reserved / available per item (and lot) | Q/C | Ready | Quote covers stock control; reservation model is C. |
| INV-002 | Reserve from snapshot, non-expired only | C | Ready | |
| INV-003 | Consume + release in one transaction | C | Ready | |
| INV-004 | Cancel-before-prep releases | C | Ready | |
| INV-005 | Cancel-after-prep keeps consumption, classify waste/comp | C | Ready | |
| INV-006 | Source/actor on every movement | C | Ready | |
| INV-007 | Block unavailable items | C | Ready | |
| INV-008 | No direct on-hand edits | C | Ready | Conflicts with quote wording F-04, resolved by archive/reversal. |
| INV-009 | Purchases, receiving, suppliers, pack conversions | C | Default | Purchase **orders** are [R]; receipts (GRN) are [C]. |
| INV-010 | Barcode exact SKU lookup | C | Default | Scanner model needed (D-03). |
| INV-011 | Batch/lot, expiry | C | Ready | Per-item opt-in tracking. |
| INV-012 | Low/zero/near-expiry/expired/overstock alerts | Q (low stock) + C | Ready | |
| INV-013 | Wastage records with cost basis | Q/C | **Blocked** for cost basis | Costing method D-04. |
| INV-014 | Stock counts with variance approval | C | Default | Approval threshold D-18. |
| INV-015 | FEFO picking (not a costing method) | R/TBD | Default | Recommended. |
| INV-016 | Reservations survive restarts; no blind timeout release | C | Ready | |
| INV-017 | Additions/omissions/sizes/packaging; no float drift | C | Ready | |

### Checkout & payments

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| PAY-001 | One consolidated invoice per session | C | Ready | |
| PAY-002 | Cashier opens bill, applies authorised discounts | C | Default | Discount limits D-14. |
| PAY-003 | Cash + manual card record; no card data | C | Ready | |
| PAY-004 | Receipt contents | C | Default | Paper/format D-17. |
| PAY-005 | Tax/service zero; historical stability | C | Ready | Store `tax_total = 0` columns now; no tax engine (D-16). |
| PAY-006 | Server-side idempotent payment | C | Ready | |
| PAY-007 | No finalisation with unresolved lines | C | Default | D-12. |
| PAY-008 | Settlement closes session, releases table | C | Ready | Optional "needs cleaning" state D-10. |
| PAY-009 | Original/reprint receipts; drawer opens only on authorised events | Q/C | Default | Hardware D-03. |
| PAY-010 | Post-settlement refunds/corrections policy | R/TBD | Default | D-13. |
| PAY-011 | Cash shifts, float, variance approval | R | Default | Quote's "shift/day-end reports" depend on this, so recommend treating as in scope. |

### Finance, assets

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| FIN-001 | Operational ledger with source references | Q (A2) | Ready | |
| FIN-002 | Not statutory accounting | C | Ready | |
| FIN-003 | Expense records | Q/C | Ready | Attachment storage on host disk (size limit). |
| FIN-004 | Fixed-asset register | Q?/C | Default | F-03 — confirm it is part of "Resources Management". |
| FIN-005 | Asset fields and history | C | Default | |
| FIN-006 | Permissioned, audited corrections | C | Ready | |
| FIN-007 | Depreciation/payables/accruals | R/TBD | Default | Recommend **out of launch scope** (D-19). |
| FIN-008 | Reports reconcile to transactions | C | Ready | |

### Reporting

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| RPT-001 | Owner dashboard KPIs | Q | Default | COGS-dependent KPIs blocked on D-04. |
| RPT-002 | Item/category/type, usage, waste, margin, shift/day-end | Q | Default | |
| RPT-003 | Hourly…custom filters, secondary filters | Q (daily/weekly/monthly) + C | Ready | |
| RPT-004 | Chart set | Q (charts) + C (specific set) | Ready | |
| RPT-005 | CSV + PDF export | C | Default | F-09. |
| RPT-006/007 | Scheduled email PDF, offline queue | C | Default | SMTP provider D-20. |
| RPT-008 | RBAC on reports/exports/schedules | Q/C | Ready | |
| RPT-009 | KPI definitions | C | Default | D-21. |
| RPT-010 | Drill-down, incomplete-data explanation | R | Ready | |
| RPT-011 | Explicit shop timezone | C | Default | ASSUMPTION Asia/Karachi (UTC+5, no DST); business-day cutoff D-22. |

### Operations / infrastructure / NFR

| ID | Requirement | Source | Design status | Notes |
|---|---|---|---|---|
| OPS-001 | Separate kitchen/reception print routes | Q/C | Default | D-03. |
| OPS-002 | Customer status updates from committed events | C | Ready | |
| OPS-003 | Audit of prices, recipes, stock, discounts, bills, permissions, finance, assets | Q | Ready | |
| OPS-004 | Owner settings | Q/C | Ready | |
| OPS-005 | Diagnostics/health screen | R | Ready | Recommended; low cost, high support value. |
| §5 | Offline LAN, Windows services, Electron, installer | C | **Blocked** on host (D-02) | Replaces quoted cloud hosting (F-01). |
| §8 | NFRs (latency, realtime lag, RPO/RTO) | C | Default | Measured targets after hardware benchmark. |
| Backup | Automated backup | Q | Default | Target media + off-site policy D-23. |

---

## 1.4 Missing, ambiguous, or conflicting requirements

| # | Gap / conflict | Why it matters | Proposed handling |
|---|---|---|---|
| G-01 | **Hosting model conflict** (F-01): quote = public web hosting; now = offline LAN. | Changes deployment, security, installer and support model. | Commercial confirmation; architecture assumes LAN-only. |
| G-02 | **Waiter-entered orders and approval** — the SRS only says QR orders need approval. | Determines whether waiters can send directly to kitchen (quote F-06 suggests yes). | Recommend: staff-entered rounds by a user with `orders.accept` are accepted on submit (same atomic transaction). D-07. |
| G-03 | **Who is the "kitchen" in a coffee shop?** Most items are made at the espresso bar by baristas. | Station routing, KDS placement, printer count. | Ask: stations (bar / food kitchen), screens per station, whether baristas use KDS or paper only. |
| G-04 | **ORD-006 status chain** merges round and line states; "Delivered" means both "served to table" and "delivery order completed". | Ambiguous states cause bugs and reporting errors. | Separate state machines; rename line handover to **Served**; reserve **Delivered** for delivery fulfilment. |
| G-05 | **"Prepared" vs "Ready"** — KDS lanes say Ready, inventory rules say Prepared. | Consumption trigger must be unambiguous. | Define: moving a line (or quantity) to **Ready** = Prepared = consumption event. D-15. |
| G-06 | **Delivery fee vs "no service charges"**. | Is a delivery fee a charge type that conflicts with DEC-13? | Treat delivery fee (if any) as a separate fee line, not a service charge. Part of D-05. |
| G-07 | **Takeaway payment timing** (pay first vs pay on collection) and whether takeaway gets a "session". | Affects invoice/session model and cashier flow. | Model every order as belonging to a session (dine-in sessions have a table; takeaway/delivery don't). Payment timing is part of D-05/D-12. |
| G-08 | **Physical count lower than reserved quantity.** If a count finds less milk than open orders have reserved, `available` goes negative. | Hard CHECK constraint would block recording the truth. | Allow the adjustment (truth wins), raise a **reservation shortfall** alert, block new acceptances for that item, require manager action. D-18. |
| G-09 | **Discount and promotion types undefined** (quote: "Discount & promotion management"). | Unbounded scope (happy hour, combos, BOGO, coupons…). | Launch: manual line/bill discounts (% or fixed, with reason and limits) plus scheduled item/category promotions. Combos/BOGO/coupons only if approved. D-14. |
| G-10 | **Tips/gratuity** not mentioned anywhere. | Cash drawer reconciliation and receipts. | Ask; default: no tip capture at launch. |
| G-11 | **Cash rounding** (PKR coins) and whether paisa amounts appear. | Totals, change, reconciliation. | ASSUMPTION: whole-rupee prices; configurable cash rounding to nearest Rs 1 recorded as a rounding line. D-16. |
| G-12 | **Language/locale** — English only, or Urdu (RTL) for the customer menu? | Fonts, layout, translation effort. | Ask. Default: English UI, menu item names may contain Urdu text (Unicode fonts bundled). |
| G-13 | **Ledger "edit access"** and **"deleting inventory"** wording (F-03, F-04). | Conflicts with immutability rules. | Interpret as create/correct-by-reversal and archive. Needs owner acknowledgement. |
| G-14 | **Staff authentication on shared terminals** — the 3 waiter terminals may be shared devices. | Per-user audit requires fast user switching. | Registered device + personal PIN quick-switch; full password on personal devices. D-24. |
| G-15 | **Remote owner access** (from home over the internet) is not stated. | Common owner expectation; conflicts with LAN-only security posture. | **Out of scope** unless approved; possible later via VPN (e.g., WireGuard/Tailscale) as a change request. |
| G-16 | **Camera barcode scanning** on tablets needs a browser *secure context* (HTTPS). | Plain `http://192.168.x.x` disables camera APIs. | Prefer HID USB/Bluetooth scanners (work as keyboards, no HTTPS needed). Camera scanning only with local-CA HTTPS on staff devices. |
| G-17 | **Data retention / customer PII deletion** not defined. | Delivery orders store phone/address. | Proposed: retain transactional data indefinitely; delivery PII redaction after N months (configurable). D-25. |
| G-18 | **Figma deliverable** — quoted at PKR 30,000, design approved before development. | The design files must be produced by a designer in Figma; this report gives the plan and specs. | Confirm who produces the Figma files and the review cadence. |
| G-19 | **Multiple tenders on one invoice** (part cash, part card). | One consolidated bill (DEC-08) doesn't say one payment. | Recommend allowing multiple tenders per invoice; **split bills not supported** at launch. D-13. |
| G-20 | **Revenue vs COGS timing** — revenue at settlement, COGS at preparation; they can fall on different business days. | Margin reports could mismatch. | Margin reports attribute COGS to the invoice's settlement date; inventory reports use movement date. D-21. |

---

## 1.5 Scope summary for commercial review

| Bucket | Contents |
|---|---|
| **Quoted (Package 3)** | Figma design; customer menu/QR ordering (dine-in, takeaway); 3 waiter terminals; KDS + KOT; owner dashboard/reports (daily/weekly/monthly, item/category/type, usage, waste, margin, shift/day-end, charts); manager dashboard; role/permission panel; thermal printer + cash drawer; backend/DB/auth/testing/deployment; inventory with recipes, usage deduction, wastage, low-stock alerts; digital ledger with per-role view/edit; audit log; modifiers/variants; discounts/promotions; delivery order type; automated backup; responsive UI. |
| **Client-added, needs commercial confirmation** | Offline LAN + Windows host + Electron + Windows services/installer; kitchen and cashier roles/screens; staff approval queue + stock reservations; batches/expiry/FEFO; barcode; suppliers and purchase receipts; stock counts with approvals; fixed-asset register (if not covered by "Resources Management"); cash shifts; CSV/PDF export; scheduled email; hourly/yearly/custom filters; detailed audit with before/after values; extended analytics. |
| **Recommended, optional** | Purchase orders; supplier returns; depreciation; station routing and bump bars; prep timers/sounds; tamper-evident audit hash chain; diagnostics page; allergen tags; VPN remote owner access. |
| **Excluded** (SRS §1.3) | Double-entry GL, tax filing, payment gateway, multi-branch/cloud sync, loyalty, auto-approval, operation without power/host/LAN, courier integrations. |
