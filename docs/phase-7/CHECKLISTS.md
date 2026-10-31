# Printable checklists for the visit (step 7.7)

Fill in on paper; send photos of each page and of the evidence. **Never photograph a password:** cover it, or blur the screenshot. Columns: ✓ done · reading or result · photo/evidence · initials. Sources: WINDOWS_DEPLOYMENT.md §3, LOCAL_LAN_HOSTING.md §7, PRINTING_HARDWARE.md §8, BACKUP_RECOVERY.md §7, TEST_PLAN.md §9.

## 1. Host (HOST-H1…H18) — the iMac

| # | Check | ✓ | Reading | Evidence | By |
|---|---|---|---|---|---|
| H-1 | Static IP 192.168.100.250/24, gateway and DNS 192.168.100.1 | ☐ | | `ipconfig` photo | |
| H-2 | Network profile: Private | ☐ | | | |
| H-3 | Firewall: only 8080 and 8443 open, local subnet | ☐ | | | |
| H-4 | Sleep and hibernation off | ☐ | | | |
| H-5 | Fast Startup off | ☐ | | | |
| H-6 | Restart after power failure (Boot Camp control panel, if offered) | ☐ | offered: yes / no | | |
| H-7 | Boots straight to Windows | ☐ | | | |
| H-8 | Write safety: `pg_test_fsync` run; `wal_sync_method` as chosen | ☐ | ops/s per method | output photo | |
| H-9 | Accounts: Owner (administrator), Counter (standard user) | ☐ | | | |
| H-10 | Counter logs in by itself after a power cut | ☐ | | | |
| H-11 | Counter app opens full screen at login (W-6) | ☐ | | | |
| H-12 | Remote Desktop, sharing, discovery off | ☐ | | | |
| H-13 | Defender on, `pgdata` excluded | ☐ | | | |
| H-14 | Disk warnings at 80 / 90 % on System health | ☐ | free GB | | |
| H-15 | Time zone Asia/Karachi; clock right | ☐ | clock vs phone | | |
| H-16 | No browser, e-mail or other software in use | ☐ | | | |
| H-17 | Backup drives A and B: letter `B:`, label CL-BACKUP, NTFS | ☐ | sizes | | |
| H-18 | SSD health (SMART) | ☐ | status | | |

## 2. Network (SITE-N1…N9) — before printing QR codes

| # | Test | Pass condition | ✓ | Result | By |
|---|---|---|---|---|---|
| N-1 | iMac cable out and in; router rebooted | Keeps 192.168.100.250; pages reload | ☐ | | |
| N-2 | Android guest phone on 2.4 GHz and 5 GHz opens the test QR | Menu < 3 s | ☐ | s / s | |
| N-3 | iPhone with Private Relay / Private DNS opens the test QR | Menu loads | ☐ | | |
| N-4 | A guest phone at every table and the counter | Menu loads; signal noted | ☐ | table list | |
| N-5 | Guest phone tries `https://192.168.100.250:8443` | Certificate warning; `DEVICE_NOT_REGISTERED` | ☐ | | |
| N-6 | Guest phone tries port 5432 | Refused | ☐ | | |
| N-7 | Staff Android and iPhone after the certificate install | No warnings | ☐ | | |
| N-8 | Internet line unplugged | N-1…N-7 still work (AT-15) | ☐ | | |
| N-9 | Router power-cycled during an order | "Reconnecting…", then recovers; no duplicate (AT-58) | ☐ | | |

## 3. Hardware (HW-01…HW-10)

| # | Check | ✓ | Result | Evidence | By |
|---|---|---|---|---|---|
| HW-01 | SNC-101 rear ports | ☐ | | photo | |
| HW-02 | Self-test page: firmware, interface, code page, ESC/POS | ☐ | | photo | |
| HW-03 | Windows driver; queue name | ☐ | | screenshot | |
| HW-04 | RAW print from the worker's service account (AT-85) | ☐ | | test print | |
| HW-05 | Kitchen ticket matches the approved golden (I-5) | ☐ | | photo | |
| HW-06 | Receipt matches; totals right-aligned | ☐ | | photo | |
| HW-07 | Partial cut | ☐ | | | |
| HW-08 | Paper-out detected (or recorded as not detectable) | ☐ | | screenshot | |
| HW-09 | Unplugged during a print → retry → nothing lost or doubled (AT-16) | ☐ | | log | |
| HW-10 | Scanner: Enter suffix; 5 real products scan; J7 (receive 3 items) timed by a person | ☐ | s | scan log | |

## 4. Drills (DRILL-1…4) and measurements

| # | Drill | Pass condition | ✓ | Result | By |
|---|---|---|---|---|---|
| DRILL-1 | Restore onto the spare PC (RUNBOOKS.md §6), timed | Up within 2 h (AC-REC-2); six checks pass; QR codes and staff devices work (AT-22) | ☐ | h:mm | |
| DRILL-2 | Plug pulled from the iMac during order entry and payment (no UPS) | Back ≤ 3 min after boot (AC-REC-1); nothing committed lost; retries doubled nothing; WAL intact (AT-56) | ☐ | min | |
| DRILL-3 | Backup drive swap | Base backup on the new drive; archiving green | ☐ | | |
| DRILL-4 | Owner opens last night's backup with the key from the USB key (`age -d -i …`) | Opens | ☐ | | |
| AC-PERF-1/2 | Load script from a laptop on the shop Wi-Fi (`scripts/load.ts`, 30 min) | p95 ≤ 300 ms, p99 ≤ 1 s; live p95 ≤ 1 s, p99 ≤ 2 s | ☐ | ms | |
| AC-PERF-3 | Guest menu first load on a mid-range Android | ≤ 2.5 s | ☐ | s | |
| AC-PERF-4 | `phase6-reports.test.ts` with a synthetic year on the iMac | Month reports ≤ 3 s | ☐ | ms | |

The load test and the synthetic year run on a test install only, before your real data is loaded; the shop is then installed fresh.
