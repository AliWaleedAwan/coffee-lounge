# User acceptance (step 7.8; TEST_PLAN.md §10)

Two scripted service sessions of about 90 minutes with your staff on the real equipment; the second with the internet unplugged. Each script is ticked by the person named, and signed at the end. A problem found is written in §3 with its severity (TEST_PLAN.md §12): Critical or High must be fixed and re-tested before go-live; Medium and Low go to KNOWN_ISSUES.md with a workaround.

## 1. Scripts

| ID | Who | Steps | ✓ | Signed |
|---|---|---|---|---|
| UAT-01 | Staff acting as guests | QR orders at 4 tables; an add-on round; one item rejected as out of stock; a counter-QR takeaway paid at the counter | ☐ | Owner |
| UAT-02 | Waiters | Their own tables; approvals; a staff round; pickups with one **Undo**; moving a table | ☐ | Manager |
| UAT-03 | Cashier | Bills; a discount within the limit and one over it (manager PIN); cash, card and JazzCash; a split payment; a refund request approved by the owner | ☐ | Owner |
| UAT-04 | Cashier and a rider | Two deliveries (cash on delivery and prepaid); one fails and is resolved (refund due) | ☐ | Manager |
| UAT-05 | Clerk | A real delivery received with lots and expiry; a waste entry; a blind count with one difference approved | ☐ | Owner |
| UAT-06 | Owner | The day-end report; the margin with its COGS coverage; the ledger; an audit search; a PDF and a CSV export | ☐ | Owner |
| UAT-07 | Everyone | Printer out of paper mid-service; the router rebooted; the counter PC switched off at the plug | ☐ | Owner |
| UAT-08 | Owner | The restore drill's result reviewed (CHECKLISTS.md §4); the backup key check | ☐ | Owner |

At the end of each session: the reconciliation checks on that day's data — the nightly stock check reports nothing (AC-INV-1) and the day's money agrees: bills, payments, refunds, the cash shift and the ledger (AC-FIN-3, the day-end report). AC-UX-1: journeys J1–J8 done by at least 4 of 5 staff without help, within their target times.

## 2. Sign-off

| Session | Date | Internet | All scripts passed | Open Critical/High | Owner | Manager |
|---|---|---|---|---|---|---|
| 1 | | on | ☐ | | | |
| 2 | | **off** | ☐ | | | |

## 3. Problems found

| # | Session / script | What happened | Severity | Fixed in | Re-tested |
|---|---|---|---|---|---|
| | | | | | |
