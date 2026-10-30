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
| `GET /entry/{qrToken}` | Resolve QR, set entry cookie (+ guest token if joining) | — | Returns entry kind, table label, `branding` (shop name, brand colour), `hours` (guests order by QR within `shop.business_hours`; `orderingOpen` false outside them), joined session summary. Outside the hours `POST /rounds` answers `400` with when ordering opens |
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
| `GET /users`, `POST /users`, `POST /users/{id}/status` | `users.manage` | People with roles, status and whether a PIN is set; add a person (temporary password, optional PIN, roles; only an owner adds an owner); disable or enable (the last active owner stays, AT-39) |
| `POST /users/{id}/credentials` | `users.manage` | `{password, pin?}`: a forgotten password or PIN (step 5.5). The person must change the password at the next login; their sessions end; not for yourself (use the account page); an owner only by an owner. Audited `user.credentials_reset` (no secrets) |
| `GET /access/catalog` | `users.manage` | Every permission (module, description, scope kind, 🔒) and every role with its grants and its RBAC.md policies (○ grantable, ✕ forbidden) |
| `GET /users/{id}/effective-permissions` | `users.manage` | What the person may do and where each permission comes from (`role:<key>`, `override:grant`), with scopes (AT-38) |
| `GET /users/{id}/permission-overrides` | `users.manage` | The person's overrides with effect, reason and who set them |
| `PUT /users/{id}/permission-overrides/{key}`, `DELETE …?reason=` | `roles.manage` 🔒 | `{effect: grant \| deny, reason}`; deny wins over any role; protected permissions stay the owner's |
| `PUT /users/{id}/roles` | `roles.manage` 🔒 | `{roles, reason}`: the person's roles; the owner role is also the owner flag, and the last active owner cannot lose it (AT-39). Audited `user.roles` with before and after |
| `PUT /roles/{role}/permissions/{key}`, `DELETE …?reason=` | `roles.manage` 🔒 | `{reason}`: give or take a permission from everyone with the role; ✕ and 🔒 are refused by the database (`403`), the owner role is not edited (`400`). Audited `role.grant` / `role.revoke` |

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
| `GET /refunds/bills?q=&date=` | `payments.refund_request` | — | Settled bills to refund from (step 5.2), newest first (50): by invoice or order number, table or guest name, or business date; with `total` and `refunded` |
| `GET /invoices/{invoiceId}/refunds` | `payments.refund_request` | — | The bill for refunding: `invoice` (paid, refunded, business date, where), `lines` (qty, net, `refundedQty`, `refundedAmount`), `payments` (as taken and as corrected: `method`, `provider`, `reference`, `refunded`, `refundable`, `inOpenShift`), `refunds` and corrections with requester and approver, `refundDue` of a cancelled prepaid delivery; `reasons` the owner offers (`refunds.reasons`, step 5.6) |
| `POST /invoices/{invoiceId}/refunds` **[I]** | `payments.refund_request` + approver's `payments.refund` via `stepUpId` (D-13) | P2 | Settled bills only (`409 STALE_STATE`); the invoice never changes. **Refund** `{kind: 'refund', paymentId, amount, reason, reference?, lines?: [{invoiceLineId, qty, amount}], stepUpId}` (step-up `refund.approve`): back by that payment's method as it now stands (a transfer needs the transaction ID; a card number → `422 CARD_NUMBER_NOT_ALLOWED`); never more than the payment less its refunds, nor more pieces or money than a line had (`422 REFUND_EXCEEDS_PAID` with `refundable` / `refundableQty`); the lines never add up to more than the amount. Cash is paid from the open shift (`422 NO_OPEN_CASH_SHIFT`), never more than the till should hold (`400`, step 5.7), and lowers its expected cash. **Method correction** `{kind: 'method_correction', paymentId, method, provider?, reference?, reason, stepUpId}` (step-up `payment.correct`): the whole payment, only before any refund of it; to or from cash only while the payment's own shift is open. Numbered `RF-YYYY-NNNNN` (gapless per year), audited `payment.refund` / `payment.correct` with reason and approver, a refund slip printed; a refund that covers a cancelled prepaid delivery's refund due closes its alert (P5-5). Returns `{refundId, refundNo, kind, amount, method, provider, businessDate, slipQueued}` (201) |
| `POST /refunds/{refundId}/slip/reprint` **[I]** | `payments.refund_request` | — | Labelled reprint of the refund slip |
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
| `POST /riders`, `PATCH /riders/{riderId}` **[I]** | `riders.manage` (step 5.6; was `users.manage`) | — | Add a rider `{name, phone?}`; rename, change phone, switch off (`expectedVersion`) |

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
| `GET /branding` | any signed-in staff | `{shopName, primary}` for every screen's header and buttons (step 3.12) |
| `GET /settings` | `settings.manage` | Every owner setting with its value, `version`, label, group, hint and whether it can be changed here (time zone and business-day cutoff are set at installation), and the branding with its `version` |
| `PATCH /settings/{key}` | `settings.manage` | `{value, expectedVersion}`; checked against the setting's rule, audited (`settings.update` with before and after), effective at once (AT-130). Money and control settings (cash rounding, stock-count approval thresholds; `financial: true` in the list) also need the owner-only `settings.financial` (`403`, RBAC review F-4). List settings (`refunds.reasons`, `assets.categories`, `assets.locations`, step 5.6) take 1–30 names, each once |
| `PUT /settings/branding` | `settings.manage` | `{expectedVersion, shopName, addressLine, phone, footer, primary}`: the receipt wording and the brand colour together; a colour under 4.5:1 for white button text or on the page is refused (AT-130) |
| `GET /operations` | `reports.sales` | Live operations for managers: tables, waiting and escalated orders, open tickets and bills, today's sales, takeaway waiting to pay, deliveries, the cash shift, and the inbox with links: escalated orders, shift variances, failed deliveries, refunds due (opening the prefilled refund, P5-5), uncollected items, long-open tables, printers, ledger mismatches, and (step 5.5) stock counts waiting for approval and critical stock alerts (out of stock, expired, short for orders taken, not matching movements; one line per kind). Refunds have no waiting requests: they are approved on the spot by step-up (D-13) |
| `POST /alerts/{alertId}/acknowledge` | `reports.sales` | Note an alert as seen; it stays in the inbox, below the unseen ones, until resolved |
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

### 5.9 Inventory and recipes (Phase 4 steps 4.1–4.9): items, suppliers, receiving, waste, counts, cost corrections, alerts, recipes, import

Item, pack, barcode and supplier edits move no stock, so they need no `Idempotency-Key`; posting, reversing, returning and correcting a receipt, recording waste, and starting, submitting, approving, sending back or cancelling a count do **[I]**. Edits carry `expectedVersion` (`409 STALE_STATE`). Quantities are decimal strings in the item's base unit (`g`, `ml`, `pcs`) with four places. The OpenAPI file covers Phase 3; these endpoints are specified here.

| Method & path | Permission | Purpose |
|---|---|---|
| `GET /inventory/items?q=&category=&includeArchived=` | `inventory.read` | Items by part of the name or SKU, or an exact active barcode; archived ones only with `includeArchived=true`. Each with its settings, `stockControlActive`, `onHand`, `reserved`, active pack and barcode counts, `version`; plus the `categories` in use |
| `GET /inventory/items/{itemId}` | `inventory.read` | One item with its `packs` (`name`, `qtyBase`, `isActive`, `version`), active `barcodes` (`code`, `packSizeId`, `packName`, `version`) and, for lot-tracked items, `lots` with stock in FEFO order (`lotCode`, `expiryDate`, `qtyReceived`, `qtyRemaining`, `origin`, `status`, `receiptNo`, `expired`, `nearExpiry`; step 4.3) |
| `GET /inventory/scan?code=` | `inventory.read` | What a scanned code names (AT-14): `{code, match: {itemId, sku, name, baseUom, pack: {id, name, qtyBase} \| null} \| null}`. `match: null` is an unknown code ("Link to item"). A code is 1–64 printable characters without spaces |
| `POST /inventory/items` | `inventory.items_manage` | `{sku, name, baseUom, category?, trackLots?, trackExpiry?, lowThreshold?, overstockThreshold?, nearExpiryDays?}`. The SKU is kept upper-case and never reused; expiry needs lots; overstock must be above low (RECIPE_INVENTORY.md §3). A new item is outside stock control until its opening count (D-29) |
| `PATCH /inventory/items/{itemId}` | `inventory.items_manage` | `{expectedVersion, …the same settings, name?}`; `null` clears a threshold. The base unit changes only while no pack, movement, recipe component or modifier rule uses the item. Switching `trackLots` on for an item with stock turns that stock into one lot; with `trackExpiry` it needs `existingStockExpiry` (P4-3). Switching it off keeps the quantity and drops the lot detail |
| `POST /inventory/items/{itemId}/archive` | `inventory.items_manage` | `{expectedVersion}`. Refused while anything is on hand or reserved, or an active recipe or modifier rule uses it (the message names them). Frees its barcodes and retires its packs (D-31) |
| `POST /inventory/items/{itemId}/pack-sizes` | `inventory.items_manage` | `{name, qty, uom}` with `uom` any unit of the item's dimension (`l` for an item in `ml`, `kg` for `g`); stored as `qtyBase` (`1 l` → `1000.0000`, AT-31). Another dimension is refused (AT-32). Names are unique among an item's active packs |
| `PATCH /inventory/pack-sizes/{packId}` | `inventory.items_manage` | `{expectedVersion, name?, isActive?}`. What a pack holds never changes (a new size is a new pack); stopping a pack frees its barcodes |
| `POST /inventory/items/{itemId}/barcodes` | `inventory.items_manage` | `{code, packSizeId?}` (a pack of this item; without one a scan means one base unit). A code with an active owner is refused with `409 BARCODE_IN_USE`, naming the owner, also when two people link it at once |
| `POST /purchase-receipts/{receiptId}/returns` **[I]** | `inventory.receive` | `{lineId, qty, uom?, reason, refundAmount?, refundChannel?, refundReference?}` (step 4.4, AT-110): stock back to the supplier against that line, never more than the line brought in less what already went back; for a lot-tracked item out of the line's own lot, otherwise from what is available. A `supplier_return` movement at the current average; a refund posts its cash-in ledger entry in the same transaction (step 5.1). Returns `qtyBase`, `value`, `returnedSoFar`. A receipt with returns can no longer be reversed. `GET /purchase-receipts/{id}` shows `returnedQty` per line and the `returns` (value and refund only with cost rights) |
| `POST /purchase-receipts/{receiptId}/cost-corrections` **[I]** | `inventory.cost_adjust` (owner) | `{lineId, correctLineCost, reason}` (step 4.6, AT-68): what the line really cost. Δ against the cost on record (line cost plus earlier corrections) is split per COST_VALUATION.md §6: Δ × min(1, on hand ÷ received) into stock value (never below zero; nothing when nothing is on hand), the rest purchase price variance today. Returns `delta`, `toInventory`, `toVariance`, `lineCostNow`. Earlier movements and line costs never change (AT-19). A corrected receipt can no longer be reversed. Receipt lines show `lineCostNow` to those with cost rights |
| `POST /inventory/waste` **[I]** | `inventory.waste` | `{itemId, qty, uom?, reasonCode, note?, lotId?}` (step 4.4, AT-109): ingredient waste at the current average; reasons `spilled`, `remade`, `expired`, `damaged`, `quality`, `other` (needs a note); for a lot-tracked item from the named lot or earliest expiry first; not more than the book quantity (a count instead). Waste only from expired lots is recorded as `expired_lot`. `value` is `null` without `inventory.cost_view` |
| `GET /inventory/waste?date=` | `inventory.read` | A business day's waste (default today), newest first: ingredients, expired lots, prepared items and failed deliveries, with lot, reason, who; `value` only with `inventory.cost_view` |
| `POST /stock-counts` **[I]** | `inventory.count` | `{scope: 'all' \| 'category' \| 'items', category?, itemIds?, blind? (default true), note?}` (step 4.5): a count of the stock-controlled items in scope, numbered `CNT-YYYY-NNNNN`. One count is open at a time |
| `GET /stock-counts`, `GET /stock-counts/{countId}` | `inventory.read` | Recent counts; one count with the items in scope (lots of lot-tracked items) and its lines. While a blind count is being counted, book quantities, variances and lot quantities are `null`; `varianceValue` only with `inventory.cost_view` |
| `POST /stock-counts/{countId}/lines` | `inventory.count` | `{itemId, lotId?, countedQty, uom?, newLotExpiry?}` enters or re-enters a line; its book quantity is taken now (per lot for lot-tracked items; without `lotId` a lot-tracked item's line is stock found in no known lot, book 0). A line is over the limits when its variance is above `inventory.count_variance_pct` or `inventory.count_variance_amount` (D-18). `DELETE /stock-counts/{countId}/lines/{lineId}` removes one while counting |
| `POST /stock-counts/{countId}/submit` **[I]** | `inventory.count` | Posts at once when no line is over the limits (`{status: 'posted'}`), else waits for approval (`{status: 'submitted', needsApproval}`) |
| `POST /stock-counts/{countId}/approve` **[I]** | `inventory.count` + `inventory.count_approve`, or `stepUpId` of a `count.variance` step-up on this device | Never the submitter (`403`). Posts every line's variance as a `count_adjustment` delta (P4-5); a shortfall larger than what is left (sold since the line was counted) posts only what is there, flagged `count_clamped`; below reserved still posts, raising the shortfall alert (AT-29) |
| `POST /stock-counts/{countId}/send-back` **[I]** | as approve | `{reason, lineIds?}`: back to counting; the named lines (default: those over the limits) must be counted again |
| `POST /stock-counts/{countId}/cancel` **[I]** | `inventory.count` | A count still being counted is cancelled; nothing moves |
| `GET /inventory/overview` | `inventory.read` | Step 4.7: what needs attention: `out`, `low`, `short` (on hand below reserved), `overstock` (items with on hand, reserved, available, threshold), `expired` and `expiring` lots, open `alerts`, `stockControl {counted, total}` (D-29), `stockValue` only with `inventory.cost_view` |
| `GET /inventory/alerts` | `inventory.read` | Open and seen inventory alerts (balance mismatch first), each with item, lot, `detail` and `manual` (closed by a person) |
| `POST /inventory/alerts/{alertId}/acknowledge` | `inventory.read` | Noted as seen; it stays listed until closed |
| `POST /inventory/alerts/{alertId}/close` | `inventory.read` (+ rules) | `{note}`. Only alerts that never clear by themselves: `balance_mismatch` (the owner only, after investigating; AT-94), `found_stock` and an `expired` lot used in an order (anyone with `inventory.count`). Every other kind closes with the stock (`400`) |
| `GET /inventory/items/{itemId}/movements?from=&to=&type=` | `inventory.read` | The item's movements, newest first (300): type, change, on hand after, source (GRN, count, order, waste, opening), reason, flags, note, who, lot shares; value and unit cost only with `inventory.cost_view` |
| `GET /recipes` | `recipes.read` | Step 4.8: every menu item and size with `stockMode` (`untracked`/`recipe`), active and draft version numbers |
| `GET /recipes/variants/{variantId}` | `recipes.read` | A size's versions (draft, active, retired) with components (ingredient, base quantity, waste factor, order types, whether counted), the modifier rules in force for it, and the item's choices |
| `POST /recipes/variants/{variantId}/draft` | `recipes.manage` | The size's draft: the existing one, or a new one copied from the active recipe (one draft at a time) |
| `PUT /recipes/versions/{versionId}` | `recipes.manage` | `{expectedVersion, prepInstructions?, components: [{itemId, qty, uom?, wastePercent?, forDineIn, forTakeaway, forDelivery}]}` replaces a draft's components; each ingredient once, in any unit of its dimension, waste 0–under 100 %, at least one order type |
| `POST /recipes/versions/{versionId}/activate` | `recipes.manage` | Activates the draft; the active version retires for future acceptances, earlier sales keep theirs (AT-19). Refused, naming them, while an ingredient is not counted (AT-63). Ingredients are locked for share so one cannot be archived meanwhile |
| `POST /recipes/variants/{variantId}/stock-mode` | `recipes.manage` | `{mode}`: `recipe` needs an active recipe; `untracked` sells with no stock (D-29, AT-61) |
| `POST /recipes/rules`, `POST /recipes/rules/{ruleId}/retire` | `recipes.manage` | A modifier recipe rule from now on: `{optionId, variantId?, action: add \| remove \| replace \| scale, itemId, replacementItemId?, qty?, uom?, scaleFactor?}` (added or replacing ingredients must be counted; a replacement keeps the same kind of unit); retiring ends it from now, sales already made keep its effect |
| `POST /recipes/preview` | `recipes.read` | `{variantId, orderType, optionIds, draft?}`: what one unit takes, exploded exactly as acceptance does (AT-64) |
| `GET /imports/templates` | `inventory.read` | Step 4.9: the eight templates in the weekly order (`items`, `packs`, `opening`, `suppliers`, `menu`, `modifiers`, `recipes`, `modifier-rules`) with their exact header, the permission each needs and whether the caller has it |
| `POST /imports/{template}/preview` | `inventory.read` + the template's permission | `{csv}` (the file's text, ≤ 2,000 rows). Runs the import in a transaction that is always rolled back: `{rows, errors: [{row, column?, message}], changes: [{row, action: create \| update \| unchanged, what}], summary}`. Nothing is saved (AT-82) |
| `POST /imports/{template}/apply` **[I]** | as preview | Imports the file only if it has no error, else `400` with every `errors` row and nothing saved. Existing rows are matched (SKU; pack name per item; menu item and size by name; choice group and option by name; supplier by name) and updated, not duplicated; prices changed by import are in price history and need `menu.price_change`; opening stock once per item (`inventory.opening_balance`); recipes become new drafts (an existing draft is replaced; the active recipe is untouched); an identical modifier rule is left alone, a different one for the same choice, size, action and ingredient replaces it from now. `EX-` SKUs are refused. Audited as `import.apply` |
| `POST /inventory/barcodes/{barcodeId}/deactivate` | `inventory.items_manage` | `{expectedVersion}`. The code is free to link again; the row stays for history |
| `GET /suppliers?includeInactive=` | `inventory.read` | Active suppliers by name (inactive ones too on request) |
| `POST /suppliers`, `PATCH /suppliers/{supplierId}` | `suppliers.manage` | `{name, phone?, email?, address?, notes?}`; edits with `expectedVersion`, `isActive: false` instead of deleting. Names are unique among active suppliers |
| `POST /purchase-receipts` **[I]** | `inventory.receive` | Posts a receipt in one transaction (RECIPE_INVENTORY.md §7): `{supplierId?, supplierInvoiceRef?, note?, paidNow, paymentChannel?, paymentReference?, startStockControl?: [itemId], lines: [{itemId, packSizeId + packQty \| qty + uom?, lineCost, lotCode?, expiryDate?}]}`. Packs convert to the base unit (`qtyBase`), unit cost = line cost ÷ base quantity to 8 dp, stock and average updated, alerts and availability refreshed, then the gapless `GRN-YYYY-NNNNN` is taken last. An expiry-tracked item needs an expiry date not in the past; lot and expiry only for items that track them. An item without its opening count is refused unless listed in `startStockControl` (its shelf was empty, D-29; needs `inventory.stock_control_activate`). `paidNow` needs `paymentChannel` (`cash`, `card`, `transfer`); a reference that looks like a card number → `422 CARD_NUMBER_NOT_ALLOWED`. A receipt paid now posts its ledger entry in the same transaction; reversing it posts the reversal of that payment (step 5.1). Returns `receiptNo`, `totalCost` and per line `qtyBase`, `unitCost`, `onHandAfter` |
| `GET /purchase-receipts?date=&supplierId=` | `inventory.read` | Posted and reversed receipts, newest first (100). `totalCost` is `null` unless the caller has `inventory.receive` or `inventory.cost_view` |
| `GET /purchase-receipts/{receiptId}` | `inventory.read` | One receipt with its lines (pack, packs, base quantity, lot, expiry), payment and reversal; costs as above |
| `POST /purchase-receipts/{receiptId}/reverse` **[I]** | `inventory.receive` | `{reason}`. The whole receipt, only while each item still has its quantity **available** (on hand − reserved), so accepted orders stay covered; otherwise refused, pointing to waste or a supplier return. Each line leaves as a `reversal` movement: exactly at its own cost when nothing else has moved the item since (quantity, value and last cost return to what they were), else at the current average (flag `at_average`, COST_VALUATION.md §3) |

### 5.10 Ledger (Phase 5 step 5.1)

Every money movement has one entry (FINANCE_REPORTING.md §4), posted by the database in the same transaction as its source: a payment, cash paid in or out of a shift, a receipt paid now (and its reversal), a supplier refund, a refund to a guest (step 5.2), an expense and its void (step 5.3; cash from the till is the shift's paid-out without an entry of its own), and for a payment-method correction the reversal of the payment's last entry plus a new one by the right method. Entries are never edited (D-31): a manual entry is corrected by reversing it. Numbers `LE-YYYY-NNNNNN` follow the entry id (unique, not gapless).

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /ledger?from=&to=&channel=` | `ledger.read` | Defaults: `to` = today's business date, `from` = the first of its month; `from` after `to` → `400`. Returns `balances` per channel (transfers per provider: `opening` before `from`, `in`, `out`, `closing` at the end of `to`) and the range's `entries` in posting order (`entryNo`, `entryType`, `direction`, `amount`, `channel`, `provider`, `businessDate`, `sourceType`, `sourceId`, `source` as people name it, `link` to its page when it has one, `memo`, `reversesEntryNo`, `reversedByEntryNo`, `createdBy`, `balanceAfter` of the entry's channel), at most 3000 (`truncated`). Balance per channel = Σ of its entries for any range (AT-121) |
| `POST /ledger/entries` **[I]** | `ledger.manage` | `{direction: in\|out, amount, channel: cash\|card\|transfer\|other, provider? (transfer only, required for it), memo (3–300)}`. Posted on today's business date as `adjustment`, audited `ledger.adjustment` with the reason; e.g. the starting balance of a channel (P5-8). Returns `{id, entryNo}` (201) |
| `POST /ledger/entries/{entryId}/reverse` **[I]** | `ledger.manage` | `{reason}`. Manual entries only (others follow their source: a refund, a voided expense, a reversed receipt → `400`); once (`409 STALE_STATE` after). Posts a `reversal` of the same amount the other way, today, audited `ledger.reverse`. Returns `{id, entryNo}` (201) |

The nightly `ledger:reconcile` (04:15) checks that every payment, cash movement, receipt paid now (and the reversal of a reversed one) and supplier refund has exactly its entry with its amount, and that every automatic entry has its source; each problem opens one `ledger_mismatch` operational alert. It never corrects anything.

### 5.11 Expenses (Phase 5 step 5.3)

What the shop pays that is not stock (FINANCE_REPORTING.md §3: ingredients are received as stock). An expense is never edited (D-31): it is voided, or corrected by voiding and recording again in one step. Numbers `EXP-YYYY-NNNNN`, gapless per year.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /expense-categories` | `expenses.read` | All categories with `isActive` and how many expenses use them (a starter list is seeded, I-12) |
| `POST /expense-categories` **[I]** | `expenses.manage` | `{name}` (2–60, unique ignoring case and spaces) |
| `PATCH /expense-categories/{id}` | `expenses.manage` | `{name?, isActive?}`; a category is switched off, never deleted. Audited |
| `GET /expenses?from=&to=&categoryId=&status=` | `expenses.read` | Defaults: this business month to today. Newest first (1000), each with category, payee, reference, note, business date, `paidVia` (`cash`, `card`, `transfer` + `provider`, `other`), `fromTill`, `status`, `attachment` (type, size) or null, who recorded or voided it and why, `replacesNo` / `replacedByNo`; `totals` per category and `total` of what is recorded (voided excluded) |
| `GET /expenses/{id}` | `expenses.read` | One expense as above |
| `POST /expenses` **[I]** | `expenses.manage` | `{categoryId, amount, paidVia, provider? (transfer only, required for it), payee?, reference?, note?, businessDate? (today or up to 31 days back), fromTill?}`. `fromTill` (cash only, today only) takes it from the open shift's till: also that shift's paid-out, so expected cash follows (`422 NO_OPEN_CASH_SHIFT` without one, P5-6; never more than the till should hold, `400`, step 5.7). One ledger entry `expense` out by its channel and category. Audited. Returns `{id, expenseNo, businessDate, paidOutOfShift}` (201) |
| `POST /expenses/{id}/void` **[I]** | `expenses.manage` | `{reason}`. Once (`409` after). The expense stays as it was, marked voided; the ledger gets a `reversal` in (AT-107). A till expense whose shift is still open is paid back in (`backInTill`) |
| `POST /expenses/{id}/correct` **[I]** | `expenses.manage` | `{reason, …the fields of POST /expenses}`: voids it and records the new one in one transaction, the new one naming the one it replaces; the attached bill carries over (AT-23). Returns `{voidedNo, id, expenseNo, businessDate}` (201) |
| `PUT /expenses/{id}/attachment` | `expenses.manage` | The bill itself as the body, `Content-Type` `image/jpeg`, `image/png` or `application/pdf`, at most 5 MB; its real type is read from its first bytes (`400` otherwise). Kept under `FILES_DIR` (P5-3), the database holds path, type, size and SHA-256; a replaced file stays on disk and both are in the audit. Only while recorded (`409` once voided) |
| `GET /expenses/{id}/attachment` | `expenses.read` | The file with its type, `X-Content-Type-Options: nosniff`, a sandboxing CSP and `no-store`; `404` when none, missing on disk or not matching its SHA-256 |

### 5.12 Asset register (Phase 5 step 5.4)

What the shop owns (D-31): the row is the asset as it is now, and every change is an event in its history (AT-106, AT-23). Disposal is a status, never a delete. No depreciation (D-19).

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /assets?q=&status=&category=` | `assets.read` | `status` `active` (not disposed), `in_use`, `in_repair`, `retired` or `disposed`; `q` searches tag, name and place. Each asset with supplier, who looks after it, `version`, `lastMaintenance`, `nextDue`; plus the `categories` and `locations` in use |
| `GET /assets/choices` | `assets.manage` | Active people and suppliers for the form |
| `GET /assets/{id}` | `assets.read` | `asset`, its `history` (`acquired`, `moved`, `condition_changed`, `value_corrected`, `status_changed`, `details_changed` with before/after, `maintenance`, `disposed`; who, when, why) and `maintenance` records |
| `POST /assets` **[I]** | `assets.manage` | `{assetTag?, name, category, quantity?, purchaseDate?, purchasePrice?, supplierId?, location?, condition? new/good/fair/poor, responsibleUserId?, notes?}`. An empty tag takes the next `AST-NNNN` (P5-4); tags are unique ignoring case. History starts with `acquired`. Returns `{id, assetTag}` (201) |
| `POST /assets/{id}/changes` **[I]** | `assets.manage` | `{version, reason?, changes: {…the fields above, status? in_use/in_repair/retired}}`. Refused if someone changed it first (`409`, with the current `version`) or it is disposed (`409`). Each difference is an event; a changed price is `value_corrected` and needs the reason. Nothing different, nothing recorded. Returns `{id, version, events}` |
| `POST /assets/{id}/maintenance` **[I]** | `assets.manage` | `{performedOn (not in the future), description, vendor?, cost?, nextDue? (after performedOn), expenseNo?}`: the expense that paid for it (step 5.3), recorded and not linked to another maintenance. Records are never edited. Returns `{id}` (201) |
| `POST /assets/{id}/dispose` **[I]** | `assets.manage` | `{how: sold/scrapped/donated/lost/returned, reason}`. The asset stays with its history and never changes again. Money from a sale is a manual ledger entry (§5.10) |

`POST /imports/assets/preview` and `/apply` take `09_assets.csv` (P5-7) with the step-4.9 rules (§5.9) and need `assets.manage`. The tag is required in the file (it is how a re-import finds the asset); re-importing records the differences as events with the reason "Imported from 09_assets.csv"; a disposed asset is refused.

### 5.13 Audit log (Phase 5 step 5.5)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /audit?from=&to=&userId=&action=&entityType=&entityId=&before=&limit=` | `audit.read` | Newest first, `limit` up to 200 (default 100), `before` = the `nextBefore` of the previous page. `from`/`to` are the shop's calendar days; `userId` matches the actor or the approver; `action` matches an action (`payment.refund`) or a family (`payment`). Each item: `at`, `actorKind`, `actor`, `device`, `action`, `entityType`, `entityId`, `before`, `after`, `reason`, `approvedBy`, `ip`, `correlationId` (AT-95). Read only |
| `GET /audit/filters` | `audit.read` | The actions and record types recorded so far, and the people |

### 5.14 Reports (Phase 6)

Every report is one definition shared by the screen and, from step 6.5, the CSV and PDF exports (P6-2): its rows, and totals worked out from those rows at full precision (AC-RPT-1). Money and percentages come as decimal strings with 2 decimals, costs at full precision, counts as numbers; `null` means "does not apply" (e.g. a margin without sales). Columns with costs or margins (`profit`) are only returned with `reports.profit`.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /reports` | session | The reports the caller may open: `key`, `title`, and whether cost columns will show |
| `GET /reports/sales-by-day?from=&to=&orderType=&categoryId=&itemId=` | `reports.sales` | One row per business date (quiet days included): orders, items, gross, discounts, refunds, net sales, average order, cash rounding, collected; with `reports.profit` also COGS, COGS coverage %, waste, stock variance, price variance, gross profit after waste, gross margin %, recorded expenses, recorded operating result or "Needs recipes" (FINANCE_REPORTING.md §3). Defaults: this business month to today; at most 400 days. Filtering by order type, category or item leaves out the shop-wide figures (waste, variances, expenses, rounding; collected also by category or item) |
| `GET /reports/sales-by-item?…` | `reports.sales` | One row per menu item sold, best sellers first: sold, gross, discounts, refunds (as far as refunds name their items), net sales; with `reports.profit` COGS, coverage, gross profit, margin |
| `GET /reports/sales-by-hour?…` | `reports.sales` | Sales after discounts by the shop's clock hour of settlement, all 24 hours in business-day order from the 04:00 cutoff (refunds stay on their own date, FINANCE_REPORTING.md §1) |
| `GET /reports/overview?from=&to=` | `reports.sales` | The owner overview (step 6.2; default today): `tiles` (Net sales, Orders, Average order; with `reports.profit` Gross margin % after waste, Waste cost, Recorded operating result) each with `value`, `compare` (the same weekdays a week earlier, P6-8), `change` %, a `note` (margin over recipe items, "Needs recipes") and the `report` it opens, whose total it equals (AT-20); `byDay`, `byHour`, `topItems`, `topByMargin` (with `reports.profit`), open `alerts` counts |
| `GET /reports/bills?…` | `reports.sales` | The settled bills behind the sales (step 6.3): date, invoice, where, settled by, items, gross, discounts, net of lines, rounding, bill total; COGS with `reports.profit`. Each row's `id` opens its lines |
| `GET /reports/bill-lines?invoiceId=` | `reports.sales` | One bill's lines: qty, gross, discounts, net, refunded, COGS (with `reports.profit`) and whether the line had a recipe |
| `GET /reports/sales-by-category?…` | `reports.sales` | As sales by item, one row per menu category |
| `GET /reports/menu-engineering?…` | `reports.profit` | Per item: sold, share of items, contribution and per item, class Star / Plowhorse / Puzzle / Dog by the 70 % rule; items without a recipe say "No recipe" |
| `GET /reports/discounts?from=&to=&staffId=&kind=` | `reports.sales` | Every promotion, discount and comp (on the bill's settlement date) and refund (on its own date): invoice, reason, by, approved by, amount; `kind` promotion, discount, comp or refund |
| `GET /reports/payment-mix?from=&to=` | `reports.sales` | Cash, card, bank, JazzCash, Easypaisa: payments and amount taken (by the method as corrected), refunds and amount paid back, collected |
| `GET /reports/deliveries?from=&to=&riderId=&status=` | `reports.sales` | Deliveries taken in the period: order, channel, payment, rider, outcome, attempts, bill, paid, refund due (no customer details) |
| `GET /reports/operating-result?from=&to=` | `reports.profit` | The recorded operating result as signed lines that add up to it: net sales, COGS, waste, stock and price variance, expenses by category; total shown only at 95 % COGS coverage, with the D-19 wording |
| `GET /reports/ledger?from=&to=&channel=` | `ledger.read` | Ledger entries as a report: in, out and each channel's balance after the entry |
| `GET /reports/expenses?from=&to=&categoryId=` | `expenses.read` | Recorded expenses of the period, by expense category |
| `GET /reports/inventory-usage?from=&to=&stockCategory=&inventoryItemId=` | `reports.inventory` | Step 6.4. Per stock item, from the stock ledger by business date: received, used, wasted, counted (+/−), returned to the supplier, net, in its base unit (quantities are never added across items, so their totals are blank); with `inventory.cost_view` also received, used, waste, variance and net value. Used value = COGS, waste and variance value = the sales report's (AC-RPT-1) |
| `GET /reports/waste?from=&to=&stockCategory=&inventoryItemId=&kind=` | `reports.inventory` | Every waste record: date, item, kind (ingredient, prepared item, expired lot, failed delivery), reason, qty and unit (or units sold), lot, by; value with `inventory.cost_view` |
| `GET /reports/stock-on-hand?stockCategory=` | `reports.inventory` | Each active stock item now: on hand, held for accepted orders, available, status (Low, Out of stock, Not counted yet); unit cost and value with `inventory.cost_view`, whose total equals Σ inventory balances. The period is ignored (stock is as it stands) |
| `GET /reports/stock-counts?from=&to=` | `reports.inventory` | Posted stock counts: date, count, scope, counted by, approved by, lines, lines that differed; variance value (shortage positive) with `inventory.cost_view` |
| `GET /reports/purchases?from=&to=&supplierId=` | `reports.inventory` | Purchase receipts: date, receipt, supplier, lines, posted or reversed, paid how (or on credit), receipts counted; cost with `inventory.cost_view` (a reversed receipt is listed and counts for nothing) |
| `GET /reports/staff-activity?from=&to=&staffId=` | `reports.staff` | Per person: bills settled and their total, payments taken, orders accepted, discounts and comps given, refunds asked and approved, waste recorded. Taken adds up to the payment mix |
| `GET /reports/audit-log?from=&to=&staffId=&entityType=` | `audit.read` | The audit log as a report (shop clock): who, device, action, record, reason, approved by; at most 20,000 events. Before/after values stay on the Audit log page; CSV with the 6.5 exports |
| `GET /reports/staff` | `reports.sales` | Names for the "settled by", "person" and "who" filters (the filter is not offered to someone without `reports.sales`) |

The sales reports also take `staffId`: bills settled by that person (refunds: asked for by them). `GET /reports` lists each report's other `filters` and marks `drillOnly` reports (bill lines).

Each report answers `{key, title, period, filters, columns: [{key, label, kind, profit?, total?, formula?}], rows (with an `id` where a row opens the next level, e.g. the item), totals, footer: {period, businessDay, filters (with names), formulas, notes, generatedAt}}`. `400` for a reversed or too long period or an unknown filter value.

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
| 409 | `BARCODE_IN_USE` | The code already has an active owner, named in `detail` and `owner`: remove it there first, or scan the right item |
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
| `inventory.changed` | Inventory item, pack size or barcode added, changed or archived (Phase 4) | `inventory` |
| `receipt.changed` | Purchase receipt posted or reversed (stock also announces `availability.changed`) | `inventory` |
| `supplier.changed` | Supplier added or changed | `inventory` |
| `count.changed` | Stock count started, submitted, posted, sent back or cancelled | `inventory` |
| `alert.changed` | Inventory alert noted as seen or closed by a person | `alerts`, `inventory` |
| `alert.raised` | Uncollected item, stale session/reservation, stock alerts, ledger mismatches | `alerts` |
| `refund.recorded` | Refund or payment-method correction | `cashier`, `ledger`, `alerts` |
| `expense.changed` | Expense recorded, voided, corrected or its bill attached; category changed | `expenses`, `ledger` (and `cashier` when the till is involved) |
| `asset.changed` | Asset registered, changed, serviced or disposed | `assets` |
| `ledger.changed` | Manual ledger entry or reversal (automatic entries arrive with their source's event) | `ledger` |
| `resync` | Client's `Last-Event-ID` older than retention (24 h) | (direct) |

**Who receives what** (filtered on the server by permission; the API still enforces scope on every fetch):

| Subscriber | Topics |
|---|---|
| Guest | `session:<own>` and `menu`, nothing else |
| Waiter | `floor`, `approvals` (rounds in scope + escalated), `kitchen`, `session:*` for assigned tables, `menu`, `alerts` (uncollected on own tables) |
| Cashier | `floor`, `approvals` (cashier scope), `kitchen`, `cashier`, `deliveries`, `printers`, `menu`, `alerts` |
| Inventory clerk | `inventory`, `menu`, `alerts` |
| Manager / Owner | All topics (`ledger` only with `ledger.read`) |

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
