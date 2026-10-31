# Known issues and limits

Reviewed with the owner before go-live (TEST_PLAN.md §12). Each has its workaround. Severity: Medium = a workaround exists; Low = cosmetic. Nothing Critical or High may be on this list at go-live.

| # | Issue | Severity | Workaround | Since |
|---|---|---|---|---|
| K-1 | Windows 10 without security updates on a PC that shares the Wi-Fi with guests (D-34, accepted risk) | Medium | Only ports 8080/8443 open; nothing else installed; backups off-site; replacement PC planned | D-34 |
| K-2 | No UPS: a power cut stops the shop until the iMac restarts (D-35, accepted risk) | Medium | Write-safe database settings; the shop is back about 3 minutes after power returns (DRILL-2); paper order pad meanwhile | D-35 |
| K-3 | The installer and the counter app are not code-signed: Windows SmartScreen warns once per install (W-5, P7-7) | Low | The technician confirms "Run anyway" | Phase 2 |
| K-4 | Screens, receipts and PDFs are in English; PDFs print only Latin script (Urdu names show as "?") | Low | Use Latin spellings in item and staff names | Phase 6 |
| K-5 | A guest's phone must be on the shop Wi-Fi to open the QR menu | Low | Staff take the order | Phase 3 |
| K-6 | The cash drawer is not connected (no drawer, D-03); change is counted by hand | Low | — | D-03 |
| K-7 | Riders have no login; the cashier records dispatch and return (D-41) | Low | — | D-41 |
| K-8 | The day-end report is fixed once made: a late correction to that day shows in the reports, not in its day-end | Low | Run the report for the day | P6-9 |
| K-9 | E-mail delivery is at-least-once: very rarely the same report arrives twice (same Message-ID) | Low | Mail clients usually merge them | D-20 |
| K-10 | Not yet measured on the shop's own equipment: everything in docs/phase-7/CHECKLISTS.md (printer, scanner, network, iMac speed, restore on a spare PC, power cut) | — | The visit (step 7.7) | Phase 7 |

Items added during UAT go below with their session and script.
