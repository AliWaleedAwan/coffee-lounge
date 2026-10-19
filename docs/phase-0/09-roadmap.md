# 09 — Phased Implementation Roadmap

> Phase 0 · Each phase ends at an **approval gate**. Effort figures are **indicative estimates** for 1 senior full-stack engineer + part-time designer/QA. They assume decisions arrive on time and will be re-estimated at each gate. They are not a commitment and don't change the commercial quote (D-01).

## 9.1 Overview

```mermaid
flowchart LR
  P0[Phase 0<br/>Discovery<br/>✔ this report] --> G0{{Gate G0}}
  G0 --> P1[Phase 1<br/>UX + architecture design]
  P1 --> G1{{Gate G1}}
  G1 --> P2[Phase 2<br/>Foundation]
  P2 --> P3[Phase 3<br/>Order-to-cash slice]
  P3 --> P4[Phase 4<br/>Recipe-to-stock slice]
  P4 --> P5[Phase 5<br/>Finance & oversight]
  P5 --> P6[Phase 6<br/>Analytics & exports]
  P6 --> P7[Phase 7<br/>Production readiness + UAT]
  P7 --> GL{{Go-live}}
```

Phases 3 and 4 are deliberately sequential. Acceptance reserves stock, so Phase 3 builds the reservation/consumption *mechanics* against a minimal ingredient model, and Phase 4 completes purchasing, lots, counts and valuation on top.

## 9.2 Phase details

### Phase 1 — UX & architecture design (≈ 3–4 weeks)
| | |
|---|---|
| **Depends on** | G0 approval; D-01, D-02 (direction), D-04, D-07, D-12 answered; D-05/D-06 answered or explicitly deferred |
| **Deliverables** | Figma foundations, components, all role screens + states + clickable prototypes (§6.9); final ERD with constraints; state machines; OpenAPI draft for Phase 3 endpoints; SSE event contract and error codes; deployment and LAN diagrams; printing plan per actual hardware; backup/restore design; final `docs/` set (DECISIONS, ARCHITECTURE, ERD, RBAC, ORDER_STATE_MACHINE, RECIPE_INVENTORY, COST_VALUATION, UI_UX, LOCAL_LAN_HOSTING, PRINTING_HARDWARE, SECURITY, BACKUP_RECOVERY, TEST_PLAN) |
| **Tests** | Prototype usability sessions (AC-UX-1); contrast audit; ERD review against every invariant in §3.4 |
| **Risks** | Late hardware info → printing plan provisional; design iteration rounds |
| **Gate G1** | Owner signs off designs per role, ERD, state machines, permission matrix |

### Phase 2 — Platform foundation (≈ 2–3 weeks)
| | |
|---|---|
| **Depends on** | G1 |
| **Deliverables** | Monorepo, CI, lint/type/dependency rules; Fastify app with two listeners; config & secrets; migrations framework + base schema (identity, RBAC, devices, audit, settings, idempotency, outbox, document counters); auth (password, PIN, device registration, sessions, step-up); RBAC guard + permission catalog + effective-permission service; audit writer; SSE hub with replay; graphile-worker; health endpoints; logging/correlation IDs; Electron shell (hardened); WinSW service definitions; dev installer prototype; test harness (real DB, concurrency harness, printer simulator) |
| **Tests** | Auth/RBAC route × role matrix; idempotency replay tests; SSE reconnect tests; service auto-start on a clean Windows VM (AT-47) |
| **Risks** | Windows service + local-CA HTTPS setup friction; Electron certificate trust |
| **Exit** | Owner can log in on Electron, create users/roles, register a device, see system health |

### Phase 3 — Order-to-cash vertical slice (≈ 5–7 weeks)
| | |
|---|---|
| **Depends on** | Phase 2; D-06, D-07, D-08, D-09, D-12, D-13, D-14 (launch subset), D-15, D-16, D-17, D-24; minimal ingredient/recipe data model from Phase 4 design |
| **Deliverables** | Menu/variants/modifiers/promotions (launch subset); tables + QR generation/printing sheet; customer QR app; waiter app (floor plan, composer, approvals); approval queue; atomic acceptance with reservation; KDS + kitchen tickets + templates; ready/served with consumption; cancellations/voids/comps; live bill, lock, payments (cash/manual card, split tender), receipts, reprints, drawer kick; cash shifts; takeaway (D-05b) |
| **Tests** | AT-01…AT-12, AT-16, AT-17, AT-24…AT-28, AT-34…AT-37, AT-40…AT-43; concurrency suite C-1…C-6; printer simulator tests |
| **Risks** | Hardware printing behaviour differs from simulator; Wi-Fi guest reachability; partial-quantity KDS UX complexity |
| **Exit / demo** | End-to-end dine-in day simulated with multiple devices on a LAN with the internet unplugged (AT-15) |

### Phase 4 — Recipe-to-stock vertical slice (≈ 4–5 weeks)
| | |
|---|---|
| **Depends on** | Phase 3; **D-04 approved**; D-18; recipe/menu/opening stock data (D-29) |
| **Deliverables** | Inventory items, UOMs/pack sizes, barcodes; recipe versions + modifier recipe rules; suppliers, purchase receipts; lots/expiry + FEFO; waste; stock counts with approvals; opening balances; alerts (low/zero/near-expiry/expired/overstock/shortfall); approved valuation (WAC or FIFO), `order_line_costs`; nightly reconciliation; movement history UI |
| **Tests** | AT-13, AT-14, AT-19, AT-29…AT-33; property tests for conservation and rounding; reconciliation job |
| **Risks** | Quality and completeness of client recipe data; barcode formats on local supplier products |
| **Exit** | Real recipes loaded; a full receiving → selling → count cycle reconciles |

### Phase 5 — Finance & oversight (≈ 2–3 weeks)
| | |
|---|---|
| **Depends on** | Phase 3–4; D-19, D-21 |
| **Deliverables** | Operational ledger (automatic postings from sales/refunds/purchases; manual entries/reversals); expenses with attachments; asset register + events + maintenance; manager approvals inbox; audit viewer; settings completion; RBAC hardening review |
| **Tests** | AT-18, AT-23, AT-38, AT-39; ledger ↔ source reconciliation |
| **Risks** | Owner expectations of "profit" exceeding recorded data. Mitigated by labelled definitions |

### Phase 6 — Analytics & exports (≈ 3–4 weeks)
| | |
|---|---|
| **Depends on** | Phase 5; D-20, D-21, D-22 |
| **Deliverables** | KPI definitions module; owner/manager dashboards; report library with filters and drill-down; CSV and branded PDF exports; scheduled email with queue, retries, status UI |
| **Tests** | AT-20, AT-21, AT-44; AC-RPT-1 reconciliation for every KPI; AC-PERF-4 with a year of synthetic data |
| **Risks** | Report scope creep; PDF layout fidelity |

### Phase 7 — Production readiness & UAT (≈ 3–4 weeks incl. on-site)
| | |
|---|---|
| **Depends on** | All; D-02, D-03 hardware on site; D-11 router; D-23 backup targets |
| **Deliverables** | Final installer/upgrader/uninstaller; host provisioning checklist; local CA + certificates; backup jobs + encrypted off-device copy + restore drill; hardware verification sheet (§8.4); load test on target host; fault drills; staff training per role + owner/admin guide; runbooks; KNOWN_ISSUES; UAT sign-off |
| **Tests** | AT-15, AT-16, AT-17, AT-22, AT-45…AT-47; AC-PERF-*; AC-REC-* |
| **Risks** | On-site network surprises; hardware incompatibility; training time during trading hours |

**Indicative total:** ≈ 22–30 weeks elapsed for the team assumed above, excluding decision waiting time. A second engineer could shorten Phases 3–6 by ~30 %, but not Phase 1 or on-site work.

## 9.3 Top technical risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | Guest phones cannot reach the host (client isolation, captive portal, Private DNS) | Medium | High (QR ordering fails) | On-site router test in Phase 1; IP-based QR URL; router config guide; fallback: waiter ordering |
| R-2 | Sonic SNC-101 isn't ESC/POS-compatible enough, or its connection/driver misbehaves under a Windows service | Medium | High (the only printer: kitchen tickets and receipts) | Self-test page + port photo now; test RAW spooler printing from a service account in Phase 2 |
| R-3 | **Decided:** reception PC is the host. Shutdowns, crashes or misuse take down every device | Medium | High | Mitigations in 02 §2.6; staff training; restore runbook |
| R-3a | **No UPS** + frequent power cuts → full outages; possible data loss on abrupt cuts | **High** | High | D-35: UPS for PC + router; WAL archive to USB; nightly dump; AT-56 drill |
| R-3b | **Windows 10 out of support** on a host shared with guest Wi-Fi | High | High | D-34: paid extended updates or replacement; strict hardening |
| R-3c | 2011 iMac hardware failure | Medium | High | Tested restore onto another Windows PC before go-live |
| R-3d | No kitchen screen (decided D-33: Picked up by waiter/cashier) → consumption recorded at pickup; forgotten pickups or wrong cancel answers distort stock | Medium | Medium | Uncollected-item alerts; "Was it already made?" on cancel; nightly stale-reservation report |
| R-4 | Recipe/menu/opening stock data arrives incrementally (**decided D-29: clerk updates weekly**) and may be incomplete at go-live | High | High (wrong availability, incomplete COGS) | Items without a recipe run as **non-stock** (no blocking, no consumption) until their recipe and opening count are entered. Stock control is switched on per item. Reports show a "COGS coverage %" so margins are never presented as complete when they aren't. Fast recipe entry UI + CSV import templates. |
| R-11 | Printer compatibility unknown (D-03 deferred by owner) | Medium | High | Collect port photo + self-test page before Phase 3 printing work; simulator until then |
| R-5 | Scope expansion vs expired quote | High | High | **Owner decided (D-01) to keep the quote as is.** Risk accepted by the owner; the effort estimates in §9.2 are unchanged. |
| R-6 | Staff adoption at peak (approval queue slows service) | Medium | Medium | Fast-path accept, waiter auto-accept, prototype testing with staff |
| R-7 | Local-CA HTTPS onboarding on staff tablets | Medium | Medium | Documented one-time setup; supported device list |
| R-8 | Power/host failure during service | Low–Medium | High | UPS, auto-start, paper fallback procedure, backup/restore drills |
| R-9 | Owner expects statutory "net profit" | Medium | Medium | Clear KPI definitions and labels (D-21) |
| R-10 | Electron/Node/PostgreSQL version churn during the project | Low | Low | Pin versions; upgrade only between phases |

## 9.4 Information needed from the client before / during Phase 1

1. Signed decision register (10-decision-register).
2. Hardware list: make/model/connection of every printer, drawer, scanner, tablet, KDS screen, router, and the host candidate.
3. Router admin access or model + photos of its guest-network settings; floor plan with table numbers.
4. Full menu: categories, items, sizes, prices, modifiers, photos (if any).
5. Recipes per variant with quantities, plus packaging per order type.
6. Ingredient list with purchase pack sizes, typical suppliers, sample barcodes, shelf-life rules.
7. Opening stock count date and procedure.
8. Sample receipt/kitchen ticket expectations; logo if available.
9. Staff list by role; shift pattern; business hours; day-end time.
10. Expense categories and the assets to register.
