# Coffee Lounge — API & Realtime Contract (Phase 1, package 1B)

> Design specification for review R2. Covers the **Phase 3 order-to-cash slice** (plus the Phase 2 auth endpoints it depends on). Machine-readable contract: [openapi/phase3.yaml](openapi/phase3.yaml). Behaviour of every state-changing call is defined in [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md); permissions in [RBAC.md](RBAC.md). Items depending on R1 answers not yet received are marked **PROVISIONAL**.

## 1. Surfaces

| Surface | Listener | Base path | Clients | Auth |
|---|---|---|---|---|
| Customer API | `http://<host>:8080` | `/api/customer/v1` | Guest phones (table QR, counter QR) | Entry cookie → guest token cookie |
| Staff API | `https://<host>:8443` | `/api/staff/v1` | Waiter tablets/phones, counter PC (Electron) | Device cookie + session cookie |
| Health | both | `/health/live`, `/health/ready` | Installer, diagnostics, connection banner | None (no business data) |

Customer routes are **not mounted** on the staff listener and vice versa. The staff listener also serves the built staff web app at `/` (any non-API path falls back to its `index.html`), so the app and its API share one origin.

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
| Idle sessions | Every authenticated request extends the session idle timer (RBAC.md §4), except a `GET` sent with `X-CL-Background: 1`. Clients send it on reads the user did not trigger (refetch after a live hint, the live stream itself), so an unattended device still locks. Writes always count as activity. |
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
| `POST /rounds` **[I]** | Submit a round (pending approval) | S1/S2 + R1 | Optional `customerName` (counter QR: kept when the order opens the phone's takeaway session). Each phone's first order from the counter QR opens a session of its own (AT-75). A phone holding a token for another visit drops it when it scans a different code |
| `POST /rounds/{roundId}/withdraw` **[I]** | Withdraw own pending round | R5 | Only the submitting guest |
| `GET /session` | Rounds, line statuses, total for this session | — | Table QR: all rounds of the table (PROVISIONAL D-09). Counter QR: own order. `session` also gives `billRequested`, `payBy` (counter QR: pay before this or the order cancels, D-40), `invoiceNo` once paid and `readOnly` |
| `POST /session/bill-request` **[I]** | Ask for the bill | S4 | Table QR only (counter QR: `400`, paid at the counter); asking again is harmless; a prepared bill: `409 STALE_STATE` |
| `GET /events` | SSE stream for this session | — | §7: `session:<own>` and `menu` only; a phone that has only scanned hears `menu`. Ends with `visit_ended` when the visit closes or staff reset the phones |

**Guest rounds (step 3.4):** `POST /rounds` uses the phone's guest token, or for its first order the entry cookie, whose table session it opens or joins (S1, CT-03); the guest token cookie is set only when the order is saved. `GET /session` returns the session with every round of the table (`mine` marks this phone's, D-09) and the accepted total. Limits: 60 requests a minute and 10 submissions a minute per phone address (each phone has its own address on the shop Wi-Fi), and at most 3 rounds waiting per session (`429 RATE_LIMITED`, AT-125). The customer listener also serves the guest app (`guest.html`) at `/t/<token>` and `/order`.

**Paid takeaway (step 3.11):** settling a counter-QR takeaway does not revoke its phone's token: for 2 hours after payment the phone can still read `GET /session` and `GET /events` (`readOnly: true`) to follow its order to pickup; ordering again from the counter QR starts a new visit. Dine-in visits still end at settlement (`401 VISIT_ENDED`, AT-40).

**Guest cookies (step 3.3):** `cl_entry` = `<entryPointId>.<issuedAt>.<HMAC-SHA256>` with a server key kept in `cl.signing_keys`, 12 h; `cl_guest` = the guest token, 24 h at most and revoked with the visit. Both httpOnly, `SameSite=Lax` (they must travel when the camera app opens the QR link), not `Secure` (plain HTTP, SECURITY.md SR-3). `GET /menu` needs a valid entry cookie, else `401 VISIT_ENDED`; `GET /session` answers `404` before the first order and `401 VISIT_ENDED` once the visit is over. Customer routes accept no ids and no unknown query parameters (AT-127).

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
| `POST /sessions/takeaway` **[I]** | `orders.create` | S2 | Counter takeaway session (optional `customerName`); its rounds go straight to the kitchen (R2) and it is billed at the counter like a table |
| `POST /sessions/delivery` **[I]** | `delivery.create` | S3 | `{channel, paymentMode, customerName?, customerPhone?, customerEmail?, address?, landmark?, notes?}` → `{deliveryId, sessionId}`; items are added as staff rounds (`POST /sessions/{id}/rounds`, refused for items not offered for delivery, AT-114) |
| `GET /sessions?status=active&type=` | `orders.read_all` (waiter: own tables) | — | Open sessions list |
| `GET /sessions/{sessionId}` | as above | — | Full session: rounds, lines, counters, live bill summary, delivery |
| `POST /sessions/{sessionId}/transfer` **[I]** | `sessions.transfer` | S9 | Move to another free table |
| `POST /sessions/{sessionId}/reset-guests` | `sessions.reset_guests` | — | Revoke guest phones |
| `POST /sessions/{sessionId}/bill-request` **[I]** | `invoices.read` | S4 | Waiter records that the table asked for the bill |
| `POST /sessions/{sessionId}/cancel` **[I]** | `orders.void` | S8 | Close a session with nothing billable |
| `GET /tables` | `tables.manage` | — | Tables for management (version, availability, when the QR card was printed) and the active entry points. Never returns QR tokens |
| `POST /tables`, `PATCH /tables/{tableId}`, `POST /tables/{tableId}/archive` | `tables.manage` | — | Standard pattern (`expectedVersion`). Blocking, maintenance or archiving a table with an active session → `409 TABLE_OCCUPIED` |
| `POST /qr-entry-points/generate` | `tables.manage` | — | `{tableIds, counter}` → new codes with their link `http://<shop address>:8080/t/<token>` for the print sheet. Shown **once**: only the hash is stored, and each new code retires the one printed before. The address comes from `GUEST_BASE_URL`, else this PC's LAN address |
| `GET /assignable-staff` | `tables.assign` | — | Active waiters, for the assignment picker |

### 5.4 Rounds, approvals, lines, kitchen

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `POST /sessions/{sessionId}/rounds` **[I]** | `orders.create` | R2 | Staff round: **accepted on submit**, reserves stock, prints ticket. Short stock → `422 INSUFFICIENT_STOCK`, nothing saved |
| `GET /approvals` | `orders.accept` | — | Pending rounds **in the caller's acceptance scope** (+ escalated), oldest first, with advisory stock check |
| `POST /rounds/{roundId}/accept` **[I]** | `orders.accept` (scoped) | R3 | Atomic accept. Losers get `409 ROUND_ALREADY_DECIDED` |
| `POST /rounds/{roundId}/reject` **[I]** | `orders.accept` (scoped) | R4 | Reason required (shown to guest) |
| `GET /takeaway/queue` | `orders.accept` | — | Counter-QR orders waiting to be paid, oldest first, with lines, quoted total and `expiresAt` (D-40) |
| `POST /rounds/{roundId}/accept-and-pay` **[I]** | `payments.collect` (+ `orders.accept`, `invoices.lock` checked inside) | R3+I2+P1+I4 | Takeaway only. `{payments: [{method, amount, tendered?, provider?, reference?, confirmed?}]}` adding up to the bill's total (else `BILL_CHANGED` with the total). One transaction: accept (stock, ticket), lock, pay, settle; any failure saves nothing (AT-52). Returns `invoiceNo`, `total`, `change`, `receiptQueued` |
| `POST /lines/{lineId}/pickup` **[I]** | `kitchen.pickup` | L1 | **Picked up** = consumption; `qty` |
| `POST /tickets/{ticketId}/pickup` **[I]** | `kitchen.pickup` | L1 × n | Pick up all remaining quantities on a ticket |
| `GET /sessions/{sessionId}` | `tables.read` | — | Session with every round, its lines and states, and the accepted total |
| `GET /pickup` | `kitchen.pickup` | — | Open kitchen tickets with units still to pick up, oldest first; `uncollected` after `orders.uncollected_alert_minutes` |
| `GET /tickets/{ticketId}` | `kitchen.read` | — | A ticket as the kitchen sees it: where, items, size, choices, notes. **No price, payment or guest field exists in it** (AT-99) |
| `POST /lines/{lineId}/serve` **[I]** | `orders.serve` | L2 | `{qty}` served or collected |
| `POST /lines/{lineId}/cancel` **[I]** | `orders.void` (waiter: own tables) | L3 / L4 | `{qty, made, reason, stepUpId?}`. `made: false` releases the stock; `made: true` consumes it and records prepared-item waste, and needs `orders.void_prepared` or a step-up approval `line.void_prepared`. A correction (or void) ticket follows |
| `POST /lines/{lineId}/void` **[I]** | `orders.void` (waiter: own tables) | L5 | `{qty, reasonCode, note?, stepUpId?}` for picked-up units: waste at the line's cost per unit, no stock back; same approval rule as L4 |

**Pickup as built (step 3.5).** `qty` must not exceed what is open (`409 QTY_EXCEEDS_REMAINING`). Dine-in pickup also counts as served (`orders.pickup_marks_served_dine_in`). Cancel and void are refused once the bill is being prepared (`SESSION_LOCKED_FOR_CHECKOUT`) or the visit is closed; pickup is not. The staff app holds a Picked up tap for 5 seconds with Undo and sends nothing if undone or offline (UI_UX.md R5-3).

**Rounds as built (step 3.4).** Body `{lines: [{variantId, qty 1–20, modifierOptionIds (repeat an id to pick it twice), notes?, quotedUnitPrice?}]}`, at most 30 lines. Prices are computed on the server: size price − the best promotion (D-14) + choices. `quotedUnitPrice` is what the client showed for one unit; if it differs the round is refused with `409 STALE_STATE` and the current `lines[].unitPrice`. Notes keep 120 characters after control characters become spaces (AT-124). At acceptance the promotion chosen at submission applies to the charged price; the price lock (D-08) compares the size price. A staff round that cannot be made answers `422 INSUFFICIENT_STOCK` with `shortages[]` (`itemId`, `name`, `needed`, `available`, `lineNos`) and saves nothing (AT-26). An accept by someone outside the acceptance scope is `403 NOT_IN_ACCEPTANCE_SCOPE` even after the round was decided (AT-48); otherwise later decisions get `409 ROUND_ALREADY_DECIDED` with `status`, `decidedBy`, `decidedAt` (a guest withdrawing is told only the status).
| `POST /lines/{lineId}/serve` **[I]** | `orders.serve` | L2 | Served / collected |
| `POST /lines/{lineId}/cancel` **[I]** | `orders.void` / `orders.void_prepared` | L3/L4 | `qty`, `alreadyMade` (required yes/no), `reason`; step-up if `alreadyMade` and caller lacks `orders.void_prepared` |
| `POST /lines/{lineId}/void-prepared` **[I]** | `orders.void_prepared` | L5 | Spilled/refused after pickup; reason |
| `GET /kitchen/tickets?status=open` | `kitchen.read` | — | Ticket list (no prices) for the pickup screen |
| `POST /tickets/{ticketId}/reprint` **[I]** | `kitchen.reprint` | K5 | Labelled reprint |

### 5.5 Billing, payments, cash

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `GET /bills` | `invoices.read` | — | The counter's open tables: every active session with its bill status, total and due, the ones asking for the bill first (a waiter limited to own tables sees only those) |
| `GET /sessions/{sessionId}/bill` | `invoices.read` | I1 | Live bill (computed) or locked invoice snapshot, with discounts, payments, waiting orders and items not yet picked up |
| `POST /invoices/{invoiceId}/lock` **[I]** | `invoices.lock` | I2 | Returns totals, warnings (unpicked lines), `lockVersion`. `PENDING_ROUNDS_EXIST` while an order waits for approval. A bill of Rs 0 (everything comped) settles at once (`settledNow`) |
| `POST /invoices/{invoiceId}/reopen` **[I]** | `invoices.reopen` | I3 | Free while nothing is paid; with payments a reason and a step-up (`invoice.reopen_with_payments`) from someone else |
| `POST /invoices/{invoiceId}/discounts` **[I]** | `discounts.apply` | — | `{orderLineId \| null, kind: percent \| fixed, value, reason}`; above the caller's limit (all discounts on the same target counted together) `STEP_UP_REQUIRED`, then `stepUpId` (`discount.over_limit`); `DISCOUNT_OVER_LIMIT` if the approver's own limit is lower (D-14). On a locked bill the figures and `lockVersion` are worked out again; refused once part is paid |
| `POST /invoices/{invoiceId}/comps` **[I]** | `discounts.comp` | L6 | `{orderLineId, reason}`: the item is free, its cost still counts (D-21). A separate path so each has one permission |
| `POST /discounts/{discountId}/void` **[I]** | `discounts.apply` (a comp also `discounts.comp`) | — | Before settlement only, with a reason |
| `POST /invoices/{invoiceId}/payments` **[I]** | `payments.collect` | P1 (+I4) | `{lockVersion, method, amount, tendered?, provider?, reference?, confirmed?}`: cash (`tendered`, change worked out; needs the open shift) / card (`reference` = approval code, optional) / transfer (`provider`, `reference`, `confirmed: true`; `confirmed_by` = caller). A reference that looks like a card number is refused. The Idempotency-Key is stored as the payment's key. Returns `settled`, `invoiceNo`, `change`, `receiptQueued` |
| `POST /invoices/{invoiceId}/receipt/reprint` **[I]** | `receipts.reprint` | — | Labelled reprint |
| `POST /invoices/{invoiceId}/refunds` **[I]** | `payments.refund_request` + approver's `payments.refund` via `stepUpId` | P2 | Full/line refund or method correction (PROVISIONAL D-13) |
| `GET /cash-shifts/current` | `cash_shifts.operate` | — | The open shift on the counter till with its figures: float, cash sales, refunds, paid-in/out, expected cash, card and transfer totals, movements |
| `GET /cash-shifts`, `GET /cash-shifts/{shiftId}` | `cash_shifts.operate` | — | Recent shifts, closed ones waiting for approval first; a cashier sees and opens only their own |
| `POST /cash-shifts` **[I]** | `cash_shifts.operate` | — | Open shift with float |
| `POST /cash-shifts/{shiftId}/movements` **[I]** | `cash_shifts.operate` | — | `{kind: paid_in \| paid_out, amount, reason}` on an open shift; a paid-out larger than the expected cash is refused |
| `POST /cash-shifts/{shiftId}/close` **[I]** | `cash_shifts.operate` | — | `{countedCash, varianceReason?, stepUpId?}` → expected, variance. Balanced: approved at once. Otherwise a reason is required, and a step-up (`shift.variance`) from someone other than the cashier approves it now, or it waits as `closed`. Prints the shift report on the receipt printer. Returns `withRiders`: cash and card still with riders, not in the till |
| `POST /cash-shifts/{shiftId}/report/reprint` **[I]** | `cash_shifts.operate` | — | Labelled copy of a closed shift’s report |
| `POST /cash-shifts/{shiftId}/approve` **[I]** | `cash_shifts.approve_variance` | — | `{note?}`: approve a closed shift’s variance (approver ≠ cashier) |

### 5.6 Delivery

| Method & path | Permission | SM | Purpose |
|---|---|---|---|
| `GET /deliveries` | `delivery.create` | — | Board: pending dispatch / out / failed and the last 12 hours' finished ones, phones masked (AT-123), items still to pick up, total and due once the bill is prepared, and what each rider is carrying (`outstanding`) |
| `GET /deliveries/{deliveryId}` | `delivery.create` | — | One delivery with the customer's details in full |
| `POST /deliveries/{deliveryId}/dispatch` **[I]** | `delivery.dispatch` | D1 | `{riderId}`; every item picked up; prepaid must be settled, COD/card bills are prepared (locked) here (AT-89); prints the rider's slip (address, `CASH/CARD TO COLLECT`) on the receipt printer |
| `POST /deliveries/{deliveryId}/return` **[I]** | `delivery.record_return` | D2/D3 | `{outcome: 'delivered', method?, reference?, deliveredAt?}`: an unpaid bill is paid in full with `collected_by_rider_id`, cash into the open shift (AT-54, AT-60); or `{outcome: 'failed', reason}`, raising a `failed_delivery` alert |
| `POST /deliveries/{deliveryId}/resolve` **[I]** | `delivery.resolve_failed` | D4–D6 | `{action: 'reattempt', riderId?}` (new slip) / `{action: 'convert_to_pickup'}` (paid at the counter) / `{action: 'cancel', reason}`: food written off as waste `failed_delivery`, no stock credit; prepaid → `refundDue` (P3-1); an unpaid bill is reopened and the visit closed |
| `GET /riders` | `delivery.dispatch` | — | Active rider profiles (`?all=true` with inactive ones) |
| `POST /riders`, `PATCH /riders/{riderId}` **[I]** | `users.manage` | — | Add a rider `{name, phone?}`; rename, change phone, switch off (`expectedVersion`) |

### 5.7 Menu, printing, system (Phase 3 subset)

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /menu` | `menu.read` | Staff menu with availability and prices. Optional `?orderType=` `dine_in`, `takeaway` or `delivery` (default `dine_in`: takeaway and delivery also need their packaging). A size is unavailable with `unavailableReason` `marked_unavailable` (the manual switch, which wins) or `out_of_stock` (its recipe cannot be covered for one unit); a choice has `available: false` when the ingredient it adds or replaces in is short |
| `POST /menu/variants/{variantId}/availability` | `menu.availability_toggle` | Temporarily unavailable on/off with reason |
| Catalog CRUD: `/menu/categories`, `/menu/items`, `/menu/items/{id}/variants`, `/modifier-groups`, `/modifier-options`, `/promotions`, `/tables`, `/qr-entry-points`, `/riders` | `menu.manage`, `menu.price_change`, `promotions.manage`, `tables.manage`, `riders.manage` | Standard pattern: `GET` list, `POST` create, `PATCH /{id}` with `expectedVersion`, `POST /{id}/archive`. No hard deletes. Price changes write price history. |
| `GET /menu/catalog` | `menu.manage` | Management view of the menu: inactive rows too, with `version` on every row, and all modifier groups |
| `POST /menu/variants/{variantId}/price` | `menu.price_change` | `{expectedVersion, price, reason}`; writes price history. Menu prices are whole rupees (D-16). Changing a modifier option's `priceDelta` through `PATCH /modifier-options/{id}` also needs `menu.price_change` |
| `GET /menu/variants/{variantId}/price-history` | `menu.manage` | Newest first, with who and why |
| `POST /modifier-groups/{groupId}/options` | `menu.manage` | Adds a choice to a group |
| `GET /printers/status` | `kitchen.read` | Per active printer: `ok`, `retrying` or `needs_attention`, open and uncertain job counts, the last error; `kitchenPrinterMissing` (feeds the printer banner) |
| `GET /printers`, `POST /printers`, `PATCH /printers/{id}` | `printers.manage` | Printers (`spooler` with the Windows queue name, or `tcp` with `host:port`), 80 or 58 mm, with the stations and their printer |
| `PUT /stations/{stationId}/printer` | `printers.manage` | `{printerId \| null}`: where kitchen tickets print |
| `PUT /tills/{tillId}/printer` | `printers.manage` | `{printerId \| null}`: where receipts print (step 3.7); `GET /printers` lists the tills |
| `POST /printers/{id}/test` | `printers.manage` | Queue a test page (W-4) |
| `GET /print-jobs?status=open` | `kitchen.reprint` | Jobs not yet printed, and uncertain ones |
| `POST /print-jobs/{jobId}/retry`, `POST /printers/{id}/retry-all` | `kitchen.reprint` | Back to the queue (same job, not a reprint); printed in order, once |
| `POST /print-jobs/{jobId}/resolve-uncertain` | `kitchen.reprint` | `printed` (mark sent) or `reprint` (new labelled copy) |
| `POST /tickets/{ticketId}/reprint` | `kitchen.reprint` | K5: a new copy labelled `REPRINT #n` |
| `GET /system/health` | `system.health` | Services, DB, worker heartbeat, printer, backups, disk, internet (§5.8) |
| `GET /events` | any authenticated staff | SSE stream (§7) |

The OpenAPI file details every endpoint above except the catalog CRUD family, which follows the standard pattern and will be added to the spec in the same form as the Phase 3 build starts.

### 5.8 Health (Phase 2 step 2.6)

| Endpoint | Answers |
|---|---|
| `GET /health/live` | `200 {"status":"live"}` while the process runs |
| `GET /health/ready` | `200 {"status":"ready","database":"ok","warnings":{…}}` once startup checks pass **and** a live database probe answers; `503 SERVER_STARTING` (with blockers) before that; `503 DATABASE_UNAVAILABLE` (`"database":"unreachable"`) if PostgreSQL stops answering later. No error detail is exposed. Probe cached 1 s |
| `GET /api/staff/v1/system/health` | The health page (fields below). Needs a session, so while the database is down it answers `503 DATABASE_UNAVAILABLE`; the page then shows "Database unreachable" from `/health/ready` |

`/system/health` fields:

| Field | Meaning |
|---|---|
| `api` | `ok`, or `degraded` while a readiness warning (e.g. `clock_jumped`) or blocker is present, or the database probe fails |
| `database` | `ok` / `unreachable` (2 s timeout; a database too busy to answer counts as unreachable) |
| `worker` | `ok`; `stale` when the last heartbeat is older than 60 s (worker stopped or crashed); `down` when no worker has ever run. `lastHeartbeatAt` |
| `printer` | `unknown`, `openJobs: 0` until the printing phase |
| `backup` | `lastSuccessAt`/`lastVerifiedAt` are `null` until the backup phase; `usbDrivePresent` is real: the configured `BACKUP_DRIVE_PATH` (`B:\`, H-17) is mounted |
| `disk` | `freePercent` of the volume in `DISK_CHECK_PATH` (default: the install drive) and `status` `ok` / `warning` (≤ 20 % free, H-14 80 % used) / `critical` (≤ 10 % free) / `unknown`. Cached 10 s |
| `internet` | `online` if a TCP connection to `INTERNET_CHECK_TARGET` (default `1.1.1.1:443`; `off` disables) opens within 2 s. Cached 60 s |
| `warnings`, `version`, `checkedAt` | Readiness warnings with their text; server version; time of the check |

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
| 503 | `DATABASE_UNAVAILABLE` | The API is running but cannot reach PostgreSQL (restart, power cut). Show "Reconnecting…" and retry automatically with the **same** `Idempotency-Key`: a write whose reply was lost then replays instead of repeating |

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
| `menu.changed` | Catalogue edit: category, item, size, price, choice or promotion | `menu` |
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
