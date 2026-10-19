# Coffee Lounge — State Machines & Transactions (Phase 1, package 1A)

> Design specification for review R1. Each transition lists **who** may trigger it (permission + scope from [RBAC.md](RBAC.md)), its **guards** (checked inside the transaction, after locking), its **effects** (all in one transaction), and its **event key** (the idempotency anchor in `order_events` / `delivery_events`). Tables: [DATABASE.md](DATABASE.md). Decisions: [DECISIONS.md](DECISIONS.md).

**General rules**
- Every transition runs in **one PostgreSQL transaction** that locks rows in the global lock order (DATABASE.md §14), re-reads state, checks guards, writes effects, an audit event and an outbox hint, then commits.
- User-triggered transitions carry an `Idempotency-Key`. The event key is `<event_type>:<idempotency-key>`. A retry replays the stored response; a different payload with the same key is refused (`409 IDEMPOTENCY_KEY_REUSED`).
- System-triggered transitions (timers) use deterministic keys such as `expire:round:812`, so a timer that fires twice does nothing the second time.
- A guard failure returns a typed error with the **current state**, so the client can refresh instead of guessing.
- Statuses of different concerns are never merged: session, round, line quantities, ticket, invoice, delivery and print job each have their own machine.

## 1. Dining session (`dining_sessions.status`)

| # | From → To | Trigger | Who | Guards | Effects |
|---|---|---|---|---|---|
| S1 | ∅ → open (dine-in) | First QR scan that submits, or waiter opens table | Guest (table QR) / `orders.create` | Table `active`, no active session (partial unique index) | Create session + invoice (status open). Table shows Occupied. |
| S2 | ∅ → open (takeaway) | Counter-QR submit, or cashier starts takeaway | Guest (counter QR) / `orders.create` | — | Session without table; guest token bound to this session only |
| S3 | ∅ → open (delivery) | Staff enters delivery order | `orders.create` + `delivery.create` | — | Session + `delivery_orders` (pending_dispatch) |
| S4 | open → checkout_requested | Guest "Request bill" or staff | Guest of this session / `invoices.read` | Status open | Flag shown to waiter/cashier. New rounds still allowed, flagged `after_bill_request` (PROVISIONAL D-12) |
| S5 | open / checkout_requested → checkout_locked | Cashier "Prepare bill" (= invoice I2) | `invoices.lock` | No round `pending_approval`; ≥ 1 billable line | See I2 |
| S6 | checkout_locked → open | Reopen bill (= invoice I3) | `invoices.reopen` | Invoice not settled | See I3 |
| S7 | open / checkout_locked → settled | Last payment completes (= invoice I4) | — (consequence) | `paid_total = total` | `closed_at`; guest tokens revoked (`session_closed`); table released |
| S8 | open → cancelled | Staff closes a session with nothing billable | `orders.void` | No accepted lines with billable quantity; no payments | `closed_at`; tokens revoked; invoice left open with total 0 (never numbered) |
| S9 | (dine-in) table move | Transfer | `sessions.transfer` | Target table active and free | Update `table_id`; `session_table_moves` row (PROVISIONAL D-10) |
| T1 | timer | Session open > 3 h | system | — | Stale-session alert to manager (no state change) |

Guest token reset: `sessions.reset_guests` revokes all live tokens of the session (`staff_reset`). The next scan at the table joins the same session as a new device (PROVISIONAL D-09).

## 2. Order round (`order_rounds.status`): approval only

| # | From → To | Trigger | Who | Guards | Effects |
|---|---|---|---|---|---|
| R1 | ∅ → pending_approval | Guest submits (table or counter QR) | Guest token of the session | Session open/checkout_requested; items orderable for this order type; ≤ 3 pending rounds per session; rate limits | Lines priced **server-side** (`unit_price_quoted`); no stock, no ticket; outbox `approvals`, `session:<id>` |
| R2 | ∅ → accepted | Staff submits (waiter/cashier) | `orders.create` (staff rounds go straight to kitchen, D-07) | As R1 **plus** all acceptance guards of R3 | R1 + R3 effects in **one** transaction. If stock is short, nothing is saved; response lists short lines |
| R3 | pending_approval → accepted | Accept | `orders.accept` within scope (below) | Status still pending; session not checkout_locked; acceptance scope; stock available for every recipe line | See §8.2 |
| R4 | pending_approval → rejected | Reject (reason required) | `orders.accept` within scope | Status still pending | Reason visible to guest. Also used when stock is short (D-06: whole round) |
| R5 | pending_approval → cancelled | Guest withdraws own round, or staff cancels | Guest (submitter) / `orders.accept` | Status still pending | No stock/ticket effects |
| R6 | pending_approval → expired | Timer: unpaid counter-QR takeaway after 30 min (D-40) | system | Session is takeaway via counter QR; status still pending | Session → cancelled (S8 rules) |
| T2 | timer | Pending > 3 min (D-36) | system | Status still pending | `escalated_at` set; highlighted to managers + cashiers; cashier scope widens to this round |

**Acceptance scope (D-07), evaluated inside the R3/R4 transaction:**

| Actor role | May accept/reject |
|---|---|
| Owner, Manager | Any round |
| Waiter | Dine-in rounds at tables **currently assigned to them** (`table_assignments`, read under lock) |
| Cashier | Takeaway and delivery rounds; dine-in rounds at **unassigned** tables; any round with `escalated_at` set |

Several staff may see the same round. **Exactly one R3/R4 can succeed**: the row lock + `WHERE status='pending_approval'` guard makes later attempts return `ROUND_ALREADY_DECIDED` with who/when.

**Price lock (PROVISIONAL D-08)** inside R3: for each line, if `catalog_unit_price > unit_price_quoted` and the round is ≤ 30 min old, charge the quoted price (`price_locked = true`). If older, the round can't be accepted as is: staff reject with reason "price changed" and the guest resubmits. If the catalog price fell, charge the lower price.

## 3. Order line quantities (counters on `order_lines`)

Lines have no approval status of their own (they follow their round). After acceptance, four counters move forward only:

| # | Transition | Trigger | Who | Guards (after line lock) | Effects |
|---|---|---|---|---|---|
| L1 | `qty_picked_up += n` | **Picked up** (D-33) | `kitchen.pickup` (waiter, cashier, manager) | `qty_picked_up + qty_cancelled_unprepared + n ≤ qty` | **Consumption** (§8.3). Dine-in with `pickup_marks_served_dine_in`: also `qty_served += n` |
| L2 | `qty_served += n` | Served / Collected / Dispatched | `orders.serve` | `qty_served + n ≤ qty_picked_up` | None on stock |
| L3 | `qty_cancelled_unprepared += n` | Cancel, answer **"not made yet"** | `orders.void` (waiter: own assigned tables) | `qty_picked_up + qty_cancelled_unprepared + n ≤ qty` | Release reservations for n units; correction/void ticket; line no longer billable for n |
| L4 | Cancel, answer **"already made"** | Cancel after kitchen made it but before pickup | `orders.void_prepared` | Same as L3 | **L1 then L5** in one transaction: consume n units, then classify as waste (`prepared_item`) |
| L5 | `qty_cancelled_prepared += n` | Void picked-up items (spilled, remade, refused) | `orders.void_prepared` | `qty_cancelled_prepared + n ≤ qty_picked_up` (served items may be voided, e.g. spilled or refused) | `wastage_records(prepared_item)` with cost from `order_line_costs`; **no stock credit**; not billable |
| L6 | Comp | Give free | `discounts.comp` | Invoice not settled | `discount_applications(kind=comp)` = full line value; cost stays in COGS |
| T3 | timer | Accepted line not picked up after 30 min | system | Open quantity > 0 | "Uncollected" alert on waiter/cashier screens |

Derived display status per line: *Waiting for kitchen* (accepted, nothing picked up) → *Picked up* → *Served* / *Collected*; *Cancelled* when all quantity is cancelled. Guests see "Being prepared" from acceptance until pickup.

**Billable quantity** = `qty − qty_cancelled_unprepared − qty_cancelled_prepared` (comped units stay billable at a 100 % discount, so revenue and comp cost are both visible).

## 4. Kitchen ticket (`kitchen_tickets.status`)

| # | Transition | Trigger | Effects |
|---|---|---|---|
| K1 | ∅ → open (`new` / `supplement`) | R2/R3 acceptance | Ticket lines with display snapshot (no prices); print job `ticket:<id>:copy:1` |
| K2 | ∅ → open (`correction` / `void`) | L3/L4 cancellation | New ticket superseding the original; printed with a **CORRECTION / VOID** banner |
| K3 | open → completed | All its lines fully picked up or cancelled | — |
| K4 | open → cancelled | All its lines cancelled before pickup | — |
| K5 | Reprint | `kitchen.reprint` | New print job, `copy_no = n`, "REPRINT #n"; the ticket itself is unchanged |

## 5. Stock reservation (`stock_reservations`)

| # | Transition | Trigger | Effect on balance (same tx) |
|---|---|---|---|
| V1 | create (active) | R2/R3 for every recipe line × component | `reserved += qty_per_unit × qty` |
| V2 | `qty_consumed += x` | L1 / L4 | `reserved −= x`, `on_hand −= x`, `inventory_value −= x × avg` |
| V3 | `qty_released += x` | L3 | `reserved −= x` |
| V4 | → closed | When consumed + released = reserved | — |

Untracked lines (`stock_mode_snap = 'untracked'`, D-29) create no reservations or movements and are reported under "COGS incomplete". Reservations never expire on a timer (INV-016). A nightly job reports reservations older than 12 h as `stale_reservation` alerts for a manager to resolve with L3/L4.

## 6. Invoice (`invoices.status`) and payments

| # | From → To | Trigger | Who | Guards | Effects |
|---|---|---|---|---|---|
| I1 | ∅ → open | S1/S2/S3 | — | — | Live bill = billable lines computed on read |
| I2 | open → locked | Prepare bill | `invoices.lock` | No pending rounds in the session; warns (doesn't block) on unpicked lines (PROVISIONAL D-12) | Snapshot billable lines into `invoice_lines`; apply discounts within limits; compute subtotal, discounts, `tax_total = 0`, rounding to Rs 1 (PROVISIONAL D-16), total; `lock_version += 1`; session → checkout_locked |
| I3 | locked → open | Reopen | `invoices.reopen` | No payments yet **or** reason + manager approval | Delete unsettled `invoice_lines`; session → open; audit |
| I4 | locked → settled | Payment brings `paid_total` to `total` | `payments.collect` | Client's `lock_version` = current; amount ≤ remaining due | Assign `invoice_no`; `business_date`; session S7; ledger entries; receipt print job |
| P1 | add payment | Take payment | `payments.collect` | Invoice locked; `lock_version` match; amount > 0 and ≤ remaining; cash: open shift; transfer: provider + reference + confirmer | Insert payment (append-only); `paid_total += amount`; maybe I4 |
| P2 | refund / method correction | Refund | Request: `payments.refund_request`; approve: `payments.refund` + step-up | Invoice settled; Σ refunds + amount ≤ Σ payments; approver ≠ requester | `refunds` (+ `refund_lines`); ledger `refund`/`reversal`; refund slip print. **Invoice unchanged.** |

**Takeaway pay-first:** I2 and P1/I4 happen inside **Accept & pay** (§8.5) together with R3.

**COD and card on delivery:** I2 happens at dispatch (D1); P1/I4 happen at rider return (D2).

## 7. Delivery (`delivery_orders.status`)

| # | From → To | Trigger | Who | Guards | Effects |
|---|---|---|---|---|---|
| D0 | ∅ → pending_dispatch | S3 + R2 | `delivery.create` | — | Kitchen ticket printed |
| D1 | pending_dispatch → out_for_delivery | Dispatch | `delivery.dispatch` | All billable lines picked up; rider chosen; prepaid → invoice settled; COD/card → invoice locked (I2 done in the same tx) | `dispatched_at`; lines `qty_served` = picked up (dispatched); receipt printed for the rider |
| D2 | out_for_delivery → delivered | Rider returns: delivered | `delivery.record_return` | COD/card: payment recorded in the same tx (P1 with `collected_by_rider_id`) → invoice settled | `delivered_at` (actual time may be entered) |
| D3 | out_for_delivery → failed | Rider returns: failed | `delivery.record_return` | Reason required | Manager inbox item |
| D4 | failed → out_for_delivery | Re-attempt | `delivery.resolve_failed` | — | New dispatch time; same rider or another |
| D5 | failed → converted_to_pickup | Customer will collect | `delivery.resolve_failed` | — | Session continues as pickup at the counter (payment per takeaway rules) |
| D6 | failed → cancelled | Cancel | `delivery.resolve_failed` | — | Picked-up quantities → L5 waste (`failed_delivery`); prepaid → refund flow P2; invoice: unpaid locked bill is reopened and lines voided |

Riders never log in (D-41); every delivery event records the acting cashier/manager **and** the rider.

## 8. Transaction specifications (critical paths)

### 8.1 Submit round (R1 / R2)
1. Insert `idempotency_keys` row (blocks concurrent duplicates).
2. Resolve session: guest → token → session (never from client input); staff → session id, verify order type and table.
3. Lock `dining_tables` row (dine-in) → lock session; check status.
4. Price every line server-side: variant price + modifier deltas; validate modifier group min/max; order-type eligibility; best promotion (no stacking, PROVISIONAL).
5. Insert round (`round_ref` from `document_counters`), lines, line modifiers, `order_events(round_submitted)`.
6. Staff source: continue with §8.2 steps 3–9 in the same transaction.
7. Outbox: `approvals` (+ `session:<id>`); audit; store response in idempotency row; COMMIT.

### 8.2 Accept round (R3)
1. Idempotency row.
2. Lock session → lock round. Guard: `pending_approval`; session not `checkout_locked`.
3. Acceptance scope: read the table's current assignment / escalation under the lock; check actor scope.
4. Price lock check (D-08) → set `catalog_unit_price`, `unit_price`, `price_locked`, `line_gross`.
5. For `recipe` lines: explode the **active** recipe version for the variant and order type (+ waste factor, + modifier rules effective now) into `order_line_components`; snapshot `recipe_version_id`, `stock_mode_snap`.
6. Aggregate required quantity per inventory item across the round.
7. Lock `inventory_balances` rows in ascending `item_id`. For expiry-tracked items, compute usable = Σ non-expired active lot remaining − reserved; otherwise on_hand − reserved. (Every ingredient of a recipe-mode variant is stock-controlled by rule, RECIPE_INVENTORY.md §2; untracked variants have no components.)
8. Any shortfall → **ROLLBACK** and return `INSUFFICIENT_STOCK` with per-line/per-ingredient detail (staff then reject R4).
9. Insert reservations; `reserved += …`; round → accepted (`decided_by/at`); kitchen ticket (`new` for the session's first accepted round, else `supplement`) + ticket lines; print job; `order_events(round_accepted)`; outbox `kitchen`, `session:<id>`, `table:<id>`, `inventory.availability`; audit; COMMIT.

### 8.3 Picked up (L1)
1. Idempotency row → lock line (via round/session order) → guard counters.
2. For each component: lock balance (ascending item_id); pick lots **FEFO** (expiry-tracked items: non-expired first; if insufficient, use the reserved quantity anyway and flag `expired_lot_used` + alert).
3. Quantity = `qty_per_unit × n`, or the exact remaining reservation when these are the line's last units (RECIPE_INVENTORY.md §6). If `on_hand` is lower than needed (only after a count shortfall), first post an `auto_found_stock` adjustment (COST_VALUATION.md §5). Value per COST_VALUATION.md §4 (drain rule when on_hand reaches 0). Insert `stock_movements(consumption)` with `source_key = consume:<event_key>:item:<id>:lot:<id>`; insert `order_line_costs`; update balance (`on_hand`, `reserved`, `inventory_value`, `last_unit_cost`); update reservation counters and status.
4. Counter update; dine-in → `qty_served` too (setting); ticket K3 if complete; `order_events(picked_up)`; outbox; COMMIT.

### 8.4 Take payment (P1 → I4)
1. Idempotency row → lock invoice → guards (`locked`, `lock_version`, remaining due, open cash shift for cash, transfer fields).
2. Insert payment; `paid_total += amount`.
3. If fully paid: `document_counters('invoice', year)` → `invoice_no`; invoice settled; session settled; revoke guest tokens; ledger entries per payment channel; receipt print job; outbox; audit; COMMIT.

### 8.5 Accept & pay (takeaway pay-first)
One transaction: §8.2 (steps 1–9, acceptance by cashier) → I2 lock → one or more P1 payments → I4 settle → kitchen ticket + receipt print jobs. Any failure rolls back everything; the UI states **"No payment recorded"**.

### 8.6 Dispatch (D1) and rider return (D2)
D1: lock session → delivery order → invoice; guards; (I2 if COD/card); set rider and times; receipt print for rider; COMMIT.
D2: idempotency row → lock delivery order → invoice; (P1 + I4 if COD/card, `collected_by_rider_id`); `delivered`; COMMIT.

## 9. Error codes used by these machines

| Code | When |
|---|---|
| `ROUND_ALREADY_DECIDED` | R3/R4/R5 after another decision (includes who/when) |
| `NOT_IN_ACCEPTANCE_SCOPE` | Waiter not assigned / cashier on assigned, unescalated table |
| `INSUFFICIENT_STOCK` | R2/R3 shortfall (per-line detail) |
| `PRICE_CHANGED_LOCK_EXPIRED` | R3 when price rose and the 30-min lock passed |
| `SESSION_LOCKED_FOR_CHECKOUT` | Submit or accept while bill is locked |
| `PENDING_ROUNDS_EXIST` | I2 with pending rounds |
| `BILL_CHANGED` | P1 with a stale `lock_version` |
| `AMOUNT_EXCEEDS_DUE` | P1 over remaining due |
| `NO_OPEN_CASH_SHIFT` | Cash payment/refund without an open shift |
| `QTY_EXCEEDS_REMAINING` | L1–L5 counter guard |
| `STALE_STATE` | Optimistic version mismatch on catalog/settings edits |
| `IDEMPOTENCY_KEY_REUSED` | Same key, different payload |
| `VISIT_ENDED` | Guest token revoked |
