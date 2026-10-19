# Coffee Lounge — API & Realtime Contract (Phase 1, package 1B)

> Design specification for review R2. Covers the **Phase 3 order-to-cash slice** (plus the Phase 2 auth endpoints it depends on). Machine-readable contract: [openapi/phase3.yaml](openapi/phase3.yaml). Behaviour of every state-changing call is defined in [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md); permissions in [RBAC.md](RBAC.md). Items depending on R1 answers not yet received are marked **PROVISIONAL**.

## 1. Surfaces

| Surface | Listener | Base path | Clients | Auth |
|---|---|---|---|---|
| Customer API | `http://<host>:8080` | `/api/customer/v1` | Guest phones (table QR, counter QR) | Entry cookie → guest token cookie |
| Staff API | `https://<host>:8443` | `/api/staff/v1` | Waiter tablets/phones, counter PC (Electron) | Device cookie + session cookie |
| Health | both | `/health/live`, `/health/ready` | Installer, diagnostics | None (no business data) |

Customer routes are **not mounted** on the staff listener and vice versa.

## 2. Conventions

| Topic | Rule |
|---|---|
| Format | JSON (`application/json; charset=utf-8`). Errors: `application/problem+json` (§6). |
| IDs | Strings in JSON (`"812"`), opaque to clients. |
| Money | Decimal strings with 2 places: `"650.00"`. Never JSON numbers. |
| Stock quantities | Decimal strings in base units: `"150.0000"`. Item quantities on orders are integers. |
| Time | ISO-8601 UTC instants (`2026-10-19T09:41:07Z`). Business dates as `YYYY-MM-DD` (shop business day, 04:00 cutoff, PROVISIONAL D-22). |
| Versioning | URL major version (`/v1`). Additive changes only within a version. |
| Pagination | Cursor-based: `?limit=50&cursor=<opaque>`; response `{ "items": [...], "nextCursor": "…" \| null }`. |
| Correlation | Clients may send `X-Correlation-Id` (UUID); the server always returns one and logs it. |
| CSRF | Staff mutations require header `X-CL-Request: 1` + same-origin `Origin`. Cookies are `SameSite=Strict`. |
| Concurrency | Catalog/settings edits send `expectedVersion`; bill-dependent calls send `lockVersion`. Mismatch → `409`. |
| Server prices | Clients send `quotedUnitPrice` only so the server can detect drift. The **server always computes** prices, totals, discounts and tables. |
| Rate limits | Customer: 10 submissions/min per guest, 60 requests/min per IP. Login/PIN: lockout rules (RBAC §4). → `429 RATE_LIMITED` with `Retry-After`. |

## 3. Idempotency

**Required header** `Idempotency-Key: <uuid v4>` on every endpoint marked **[I]** below: anything that creates orders, moves stock, or moves money.

| Rule | Behaviour |
|---|---|
| Key generation | Client creates the key when the user **commits the intent** (taps Submit/Accept/Pay) and stores it until a definitive response arrives, including across page reloads |
| First request | Executed; key and response stored **in the same DB transaction** as the effect |
| Retry after success | Same status + body returned, with header `Idempotent-Replayed: true`. No second effect. |
| Concurrent duplicate | Waits for the first to finish, then replays its response |
| Same key, different body | `409 IDEMPOTENCY_KEY_REUSED` |
| First attempt failed (rolled back) | No record kept; a retry executes normally |
| Retention | 24 h |
| Scope | Per endpoint family + actor (`round.submit`, `payment.create`, …) |

## 4. Authentication flows

**Staff device registration (once per device):** a manager creates a one-time registration code on the counter PC → the device opens `https://<host>:8443/register`, enters the code → `POST /devices/register` sets a long-lived httpOnly device cookie. Personal phones are registered the same way (`ownership: personal`) after the shop certificate is installed (D-39).

**Staff login:** `POST /auth/login` (username + password, registered device required) → session cookie. `POST /auth/pin-switch` switches user on the same device with a PIN. `GET /auth/me` returns the user, roles, **effective permissions with scopes**, and the device. The UI builds navigation from this.

**Step-up approval:** `POST /auth/step-up` with `{action, entityType, entityId, approverUsername, approverPin, reason}` → `{stepUpId}`, valid **2 minutes**, for one use, on the same device. The protected call then includes `stepUpId`.

**Guest access:**
1. `GET /api/customer/v1/entry/{qrToken}` validates the printed QR token and sets an **entry cookie** (entry point id, signed, 12 h). **Browsing never opens a session or occupies a table.**
2. If the table already has an active session, the response also issues a **guest token** cookie bound to that session (auto-join, PROVISIONAL D-09).
3. On first submit with no active session, the server creates the session (dine-in: table becomes Occupied; counter QR: new takeaway session) and issues the guest token.
4. When the session closes (settled, cancelled, expired) or staff reset guests, the token is revoked → `401 VISIT_ENDED`. Scanning again starts fresh.

## 5. Endpoint catalog

Permission column refers to [RBAC.md](RBAC.md). **[I]** = Idempotency-Key required. **SM** = transition id in ORDER_STATE_MACHINE.md.

### 5.1 Customer API (`/api/customer/v1`)

| Method & path | Purpose | SM | Notes |
|---|---|---|---|
| `GET /entry/{qrToken}` | Resolve QR, set entry cookie (+ guest token if joining) | — | Returns entry kind, table label, shop branding, joined session summary |
| `GET /menu` | Menu for this entry's order type with live availability | — | Unavailable items included with `available: false` and reason |
| `POST /rounds` **[I]** | Submit a round (pending approval) | S1/S2 + R1 | Optional `customerName` (counter QR) |
| `POST /rounds/{roundId}/withdraw` **[I]** | Withdraw own pending round | R5 | Only the submitting guest |
| `GET /session` | Rounds, line statuses, total for this session | — | Table QR: all rounds of the table (PROVISIONAL D-09). Counter QR: own order |
| `POST /session/bill-request` **[I]** | Ask for the bill | S4 | Table QR only |
| `GET /events` | SSE stream for this session | — | §7 |

### 5.2 Staff API (`/api/staff/v1`): authentication & devices

| Method & path | Permission | Purpose |
|---|---|---|
| `POST /devices/register` | one-time code | Register device |
| `POST /devices/registration-codes` | `devices.manage` | Create a one-time code (10 min) |
| `GET /devices`, `POST /devices/{id}/revoke` | `devices.manage` | List / revoke (immediately ends its sessions) |
| `POST /auth/login`, `POST /auth/pin-switch`, `POST /auth/logout` | — | Sessions |
| `GET /auth/me` | — | User, effective permissions + scopes, device |
| `POST /auth/step-up` | approver's permission | One-use approval token |

### 5.3 Floor, tables, sessions

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `GET /floor` | `tables.read` | — | Tables with derived state, assigned waiter, pending/escalated counts, uncollected counts, session summary |
| `PUT /tables/{tableId}/assignment` | `tables.assign` | — | Assign waiter (ends previous assignment) |
| `DELETE /tables/{tableId}/assignment` | `tables.assign` | — | End assignment (table becomes unassigned → cashier queue) |
| `POST /tables/{tableId}/sessions` **[I]** | `orders.create` | S1 | Open dine-in session (guest count optional) |
| `POST /sessions/takeaway` **[I]** | `orders.create` | S2 | Counter takeaway session (optional customer name) |
| `POST /sessions/delivery` **[I]** | `delivery.create` | S3 | Delivery session: channel, optional customer fields, payment mode |
| `GET /sessions?status=active&type=` | `orders.read_all` (waiter: own tables) | — | Open sessions list |
| `GET /sessions/{sessionId}` | as above | — | Full session: rounds, lines, counters, live bill summary, delivery |
| `POST /sessions/{sessionId}/transfer` **[I]** | `sessions.transfer` | S9 | Move to another free table |
| `POST /sessions/{sessionId}/reset-guests` | `sessions.reset_guests` | — | Revoke guest phones |
| `POST /sessions/{sessionId}/bill-request` **[I]** | `invoices.read` | S4 | Waiter records that the table asked for the bill |
| `POST /sessions/{sessionId}/cancel` **[I]** | `orders.void` | S8 | Close a session with nothing billable |

### 5.4 Rounds, approvals, lines, kitchen

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `POST /sessions/{sessionId}/rounds` **[I]** | `orders.create` | R2 | Staff round: **accepted on submit**, reserves stock, prints ticket. Short stock → `422 INSUFFICIENT_STOCK`, nothing saved |
| `GET /approvals` | `orders.accept` | — | Pending rounds **in the caller's acceptance scope** (+ escalated), oldest first, with advisory stock check |
| `POST /rounds/{roundId}/accept` **[I]** | `orders.accept` (scoped) | R3 | Atomic accept. Losers get `409 ROUND_ALREADY_DECIDED` |
| `POST /rounds/{roundId}/reject` **[I]** | `orders.accept` (scoped) | R4 | Reason required (shown to guest) |
| `POST /rounds/{roundId}/accept-and-pay` **[I]** | `orders.accept` + `payments.collect` | R3+I2+P1+I4 | Takeaway pay-first in one transaction; body includes payments |
| `POST /lines/{lineId}/pickup` **[I]** | `kitchen.pickup` | L1 | **Picked up** = consumption; `qty` |
| `POST /tickets/{ticketId}/pickup` **[I]** | `kitchen.pickup` | L1 × n | Pick up all remaining quantities on a ticket |
| `POST /lines/{lineId}/serve` **[I]** | `orders.serve` | L2 | Served / collected |
| `POST /lines/{lineId}/cancel` **[I]** | `orders.void` / `orders.void_prepared` | L3/L4 | `qty`, `alreadyMade` (required yes/no), `reason`; step-up if `alreadyMade` and caller lacks `orders.void_prepared` |
| `POST /lines/{lineId}/void-prepared` **[I]** | `orders.void_prepared` | L5 | Spilled/refused after pickup; reason |
| `GET /kitchen/tickets?status=open` | `kitchen.read` | — | Ticket list (no prices) for the pickup screen |
| `POST /tickets/{ticketId}/reprint` **[I]** | `kitchen.reprint` | K5 | Labelled reprint |

### 5.5 Billing, payments, cash

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `GET /sessions/{sessionId}/bill` | `invoices.read` | I1 | Live bill (computed) or locked invoice snapshot |
| `POST /invoices/{invoiceId}/lock` **[I]** | `invoices.lock` | I2 | Returns totals, warnings (unpicked lines), `lockVersion` |
| `POST /invoices/{invoiceId}/reopen` **[I]** | `invoices.reopen` | I3 | Reason; step-up if payments exist |
| `POST /invoices/{invoiceId}/discounts` **[I]** | `discounts.apply` / `discounts.comp` | — | Line or bill discount; `stepUpId` if above limit (PROVISIONAL D-14) |
| `POST /discounts/{discountId}/void` **[I]** | `discounts.apply` | — | Before settlement only |
| `POST /invoices/{invoiceId}/payments` **[I]** | `payments.collect` | P1 (+I4) | Cash (`tendered`) / card (`reference` optional) / transfer (`provider`, `reference`, `confirmedBy` = caller); `lockVersion` required |
| `POST /invoices/{invoiceId}/receipt/reprint` **[I]** | `receipts.reprint` | — | Labelled reprint |
| `POST /invoices/{invoiceId}/refunds` **[I]** | `payments.refund_request` + approver's `payments.refund` via `stepUpId` | P2 | Full/line refund or method correction (PROVISIONAL D-13) |
| `GET /cash-shifts/current` | `cash_shifts.operate` | — | Open shift on the counter till with running expected cash |
| `POST /cash-shifts` **[I]** | `cash_shifts.operate` | — | Open shift with float |
| `POST /cash-shifts/{shiftId}/movements` **[I]** | `cash_shifts.operate` | — | Paid-in / paid-out with reason |
| `POST /cash-shifts/{shiftId}/close` **[I]** | `cash_shifts.operate` | — | Counted cash → expected, variance; warns about outstanding COD |
| `POST /cash-shifts/{shiftId}/approve` **[I]** | `cash_shifts.approve_variance` | — | Approve variance (approver ≠ cashier) |

### 5.6 Delivery

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `GET /deliveries?status=` | `delivery.create` | — | Board: pending dispatch / out / failed, outstanding COD per rider |
| `POST /deliveries/{deliveryId}/dispatch` **[I]** | `delivery.dispatch` | D1 | Rider, bill locked (COD/card) or settled check (prepaid); prints rider receipt |
| `POST /deliveries/{deliveryId}/return` **[I]** | `delivery.record_return` | D2/D3 | `outcome: delivered` (+ payment for COD/card) or `failed` (+ reason) |
| `POST /deliveries/{deliveryId}/resolve` **[I]** | `delivery.resolve_failed` | D4–D6 | `reattempt` / `convert_to_pickup` / `cancel` |
| `GET /riders` | `delivery.dispatch` | — | Active rider profiles |

### 5.7 Menu, printing, system (Phase 3 subset)

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /menu` | `menu.read` | Staff menu with availability and prices |
| `POST /menu/variants/{variantId}/availability` | `menu.availability_toggle` | Temporarily unavailable on/off with reason |
| Catalog CRUD: `/menu/categories`, `/menu/items`, `/menu/items/{id}/variants`, `/modifier-groups`, `/modifier-options`, `/promotions`, `/tables`, `/qr-entry-points`, `/riders` | `menu.manage`, `menu.price_change`, `promotions.manage`, `tables.manage`, `riders.manage` | Standard pattern: `GET` list, `POST` create, `PATCH /{id}` with `expectedVersion`, `POST /{id}/archive`. No hard deletes. Price changes write price history. |
| `GET /print-jobs?status=open` | `printers.manage` or `kitchen.reprint` | Failed / uncertain jobs |
| `POST /print-jobs/{jobId}/retry` | same | Retry a failed job (same job, not a reprint) |
| `POST /print-jobs/{jobId}/resolve-uncertain` | same | `printed` (mark sent) or `reprint` (new labelled copy) |
| `GET /system/health` | `system.health` | Services, DB, worker heartbeat, printer, backups, disk, internet |
| `GET /events` | any authenticated staff | SSE stream (§7) |

The OpenAPI file details every endpoint above except the catalog CRUD family, which follows the standard pattern and will be added to the spec in the same form as the Phase 3 build starts.

## 6. Errors

`application/problem+json`:

```json
{
  "type": "https://coffeelounge.local/errors/insufficient-stock",
  "title": "Not enough stock to accept this round",
  "status": 422,
  "code": "INSUFFICIENT_STOCK",
  "detail": "Oat milk: need 300 ml, available 120 ml",
  "correlationId": "4a1c…",
  "currentState": { "roundStatus": "pending_approval" },
  "shortages": [ { "lineId": "9912", "itemName": "Oat milk", "required": "300.0000", "available": "120.0000", "uom": "ml" } ]
}
```

| HTTP | Code | Meaning / client action |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `fields[]` lists problems; fix input |
| 401 | `UNAUTHENTICATED` | Log in again |
| 401 | `VISIT_ENDED` | Guest: show "This visit has ended. Scan again." |
| 403 | `DEVICE_NOT_REGISTERED` | Register this device |
| 403 | `FORBIDDEN` | Missing permission |
| 403 | `NOT_IN_ACCEPTANCE_SCOPE` | Waiter not assigned / cashier on an assigned, unescalated table |
| 403 | `STEP_UP_REQUIRED` | Collect approver PIN, retry with `stepUpId` |
| 404 | `NOT_FOUND` | Unknown or out-of-scope id (no existence leak) |
| 409 | `ROUND_ALREADY_DECIDED` | Includes `decidedBy`, `decidedAt`, outcome; refresh |
| 409 | `SESSION_LOCKED_FOR_CHECKOUT` | Ask cashier |
| 409 | `PENDING_ROUNDS_EXIST` | Resolve approvals before locking the bill |
| 409 | `BILL_CHANGED` | `lockVersion` stale: reload bill |
| 409 | `QTY_EXCEEDS_REMAINING` | Refresh line |
| 409 | `STALE_STATE` | `expectedVersion` mismatch: reload and reapply |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Client bug: new intent needs a new key |
| 409 | `TABLE_OCCUPIED` | Transfer/open to an occupied table |
| 422 | `INSUFFICIENT_STOCK` | `shortages[]`: reject the round (D-06) or remove items (staff round) |
| 422 | `PRICE_CHANGED_LOCK_EXPIRED` | Reject; guest resubmits (PROVISIONAL D-08) |
| 422 | `AMOUNT_EXCEEDS_DUE` | Includes `remainingDue` |
| 422 | `NO_OPEN_CASH_SHIFT` | Open a shift first |
| 422 | `DISCOUNT_OVER_LIMIT` | Includes `limitPercent`; step-up |
| 422 | `REFUND_EXCEEDS_PAID` | Includes `refundable` |
| 422 | `CARD_NUMBER_NOT_ALLOWED` | Reference looks like a card number |
| 429 | `RATE_LIMITED` | Wait `Retry-After` |
| 500 | `INTERNAL_ERROR` | Unexpected failure; details are logged under the correlation ID, never sent to the client. Retry or report the correlation ID |
| 503 | `SERVER_STARTING` | Show "Server starting…", retry automatically |

## 7. Realtime (Server-Sent Events)

**Endpoints:** `GET /api/staff/v1/events` and `GET /api/customer/v1/events` (`text/event-stream`). One stream per browser tab.

**Message format:**

```text
id: 104233
event: round.decided
data: {"entity":{"type":"round","id":"812","version":3},"topics":["approvals","session:301","table:5"],"at":"2026-10-19T09:41:07Z"}
```

`id` is the outbox sequence. **Payloads are hints only**: no prices, statuses or totals. On receipt the client invalidates the matching queries and refetches through the API.

| Event | Emitted when | Topics |
|---|---|---|
| `round.submitted` | R1/R2 | `approvals`, `session:<id>`, `table:<id>` |
| `round.decided` | R3/R4/R5/R6 | `approvals`, `session:<id>`, `table:<id>`, `kitchen` (accepted) |
| `round.escalated` | T2 | `approvals` |
| `line.changed` | L1–L6 | `session:<id>`, `kitchen`, `table:<id>` |
| `ticket.changed` | K1–K5 | `kitchen` |
| `session.changed` | S1–S9, bill request, guest reset | `floor`, `session:<id>`, `cashier` |
| `table.changed` | Assignment, availability | `floor`, `approvals` |
| `invoice.changed` | I1–I4, discounts | `session:<id>`, `cashier` |
| `payment.recorded` | P1, P2 | `cashier`, `session:<id>` |
| `delivery.changed` | D0–D6 | `deliveries`, `cashier` |
| `availability.changed` | Stock-driven or manual availability change | `menu` |
| `print_job.changed` | Failure, uncertain, recovery | `printers` |
| `alert.raised` | Uncollected item, stale session/reservation, stock alerts | `alerts` |
| `resync` | Client's `Last-Event-ID` older than retention (24 h) | (direct) |

**Who receives what** (filtered on the server by permission; the API still enforces scope on every fetch):

| Subscriber | Topics |
|---|---|
| Guest | `session:<own>` and `menu`, nothing else |
| Waiter | `floor`, `approvals` (rounds in scope + escalated), `kitchen`, `session:*` for assigned tables, `menu`, `alerts` (uncollected on own tables) |
| Cashier | `floor`, `approvals` (cashier scope), `kitchen`, `cashier`, `deliveries`, `printers`, `menu`, `alerts` |
| Manager / Owner | All topics |

**Reliability rules:** heartbeat comment every 15 s · browser reconnects automatically with `Last-Event-ID` · replay from the outbox if within 24 h, else `resync` · after 2 missed heartbeats the UI shows "Reconnecting…" and disables Accept, Pick up, Lock and Pay until it has refetched · nothing is ever decided from an event alone.

## 8. Example: accept a QR round

```http
POST /api/staff/v1/rounds/812/accept HTTP/1.1
Host: 192.168.100.250:8443
Idempotency-Key: 6f0e2c7a-1b8e-4d1c-9a39-0a2f1e9d1c55
X-CL-Request: 1
Content-Type: application/json

{}
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "round": { "id": "812", "ref": "R-1019-042", "status": "accepted", "decidedBy": {"id":"7","name":"Sara"}, "decidedAt": "2026-10-19T09:41:07Z" },
  "lines": [ { "id": "9912", "name": "Cappuccino", "variant": "Regular", "qty": 2, "unitPrice": "650.00", "priceLocked": false, "lineGross": "1300.00" } ],
  "ticket": { "id": "118", "no": "K-1019-118", "kind": "new", "printJob": { "id": "551", "status": "queued" } }
}
```

A second waiter pressing Accept a moment later receives `409 ROUND_ALREADY_DECIDED` with `decidedBy: Sara`, and no second ticket or reservation is created.

## 9. Open points for review R2

1. Guest token lifetime while a session stays open: proposed **12 h** sliding.
2. Step-up token validity: proposed **2 min**, single use, same device.
3. Customer rate limits (10 submissions/min per guest, max 3 pending rounds per session). Are they too strict for large groups?
4. Should the guest see **who** accepted their order (waiter's first name)? Proposed: no, only "Accepted".
