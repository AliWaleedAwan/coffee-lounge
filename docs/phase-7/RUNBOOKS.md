# Runbooks

Short, numbered steps for the moments that matter. Print §1 and §2 and keep them at the counter.

## 1. Opening

1. Switch on the iMac (and the router if it was off). The counter app opens by itself (about 3 minutes after power-on).
2. If the counter app shows **Server unavailable**, wait 2 minutes; then §5.
3. Check the receipt printer has paper; **Settings** → **Printers** → **Test print** if in doubt.
4. Cashier: **Bills & payments** → **Opening float (Rs)** → **Open shift**.
5. A red banner on the screen? Read it: backups (§4), printer (§3), connection (§5).

## 2. Closing

1. Settle every bill; check **Bills & payments** is empty.
2. Close the cash shift with the counted cash (difference: reason; a manager approves).
3. Leave the iMac **on** overnight: the day-end report (04:25) and the backups (04:35) run while the shop is closed. If it must be switched off, do it from Windows **Shut down**, never by the power button or the plug.
4. **Mondays:** swap the backup drives (§4.1).

## 3. Printer

| What you see | Do |
|---|---|
| "Printer problem" banner, tickets waiting | Check paper, lid, cable, power. The jobs wait and print by themselves when it is back; nothing is lost or doubled |
| Out of paper mid-service | Load paper; the ticket being printed prints again, labelled REPRINT if it had already gone out |
| A ticket is needed again | **Open print jobs** → reprint (labelled REPRINT #n) |
| The printer is dead | **Settings** → **Printers** → turn it off; tickets show on **Pickup** and bills can be taken without receipts; print them later |

## 4. Backups

### 4.1 The Monday swap
1. Unplug the drive in the iMac (labelled A or B). 2. Plug in the other one (same port). 3. Take the first one home. The system recognises the drive and makes a full copy on it within a few minutes; **System health** shows it.

### 4.2 Red banners
| Banner | Do |
|---|---|
| "Backup drive missing" | Plug in a CL-BACKUP drive. Nothing is lost: the copies wait on the iMac and catch up |
| "Backups are failing" / "Last night's backup failed" | Open **System health** for the reason (drive full, drive read-only, unplugged during the backup). Plug in the other drive if it is the drive; tell the technician if it persists |
| "The weekly test restore found a problem" | Tell the technician the same day; keep both drives as they are (do not swap) |
| "No backup for more than a day" | Is the iMac left on overnight? Is a drive in? |

## 5. Network and connection

| What you see | Do |
|---|---|
| **Reconnecting…** on a device | Wait: changes are paused, not lost. Then check that device's Wi-Fi |
| Guests cannot open the QR menu | Are they on the shop Wi-Fi (not mobile data)? Router on? Take orders by waiter meanwhile |
| Every device says the server is unavailable | Is the iMac on? Is its network cable in? Restart the iMac from Windows **Restart**; wait 3 minutes |
| Internet is down | Nothing to do: the shop works without internet. E-mails and the off-site copy wait and go later |

Never type the router or Wi-Fi password into anything but the router itself; send the technician a photo with passwords covered.

## 6. The iMac died; the backup drive is fine (BACKUP_RECOVERY.md §5.1, about 2 hours)

1. Switch to the paper order pad.
2. A Windows 10/11 PC (64-bit, 8 GB+). The technician applies the host checklist (CHECKLISTS.md §1), at least the fixed address 192.168.100.250, so the printed QR codes keep working.
3. Plug in the backup drive (as `B:`) and the **owner's USB key**.
4. As Administrator: `CoffeeLounge-Setup.exe -CaExportDir <USB key folder> -RestoreFrom latest`. It installs, restores last night's backup, checks it, and re-issues the server certificate from the shop root on the USB key, so staff devices reconnect without changes.
5. Register the counter app, install the printer driver, test print.
6. Enter the paper-pad orders.
7. Then, with the technician, bring it up to the last minutes: §7 with `-PointInTime latest`.

## 7. Restore to a point in time on this PC (BACKUP_RECOVERY.md §5.3, §5.4)

Everything recorded after the chosen time is lost. Owner only.

1. Outside service. Plug in the owner's USB key and the backup drive.
2. As Administrator: `powershell -ExecutionPolicy Bypass -File "C:\Program Files\CoffeeLounge\setup\restore.ps1" -KeyFile E:\coffee-lounge-backup-key.txt -PointInTime "2026-11-02 14:30"` (or leave out `-PointInTime` for the latest), type RESTORE.
3. It stops the services, keeps the old database folder, replays to the time, runs the six checks and starts the services. Read its last lines: "Integrity: every check passed".
4. Keep the old folder (`pgdata-before-restore-…`) until the shop has checked its records.

## 8. Upgrade

1. Outside trading hours; bills settled and the cash shift closed.
2. As Administrator: run the new `CoffeeLounge-Setup-<version>.exe`.
3. It ends with "Upgrade finished: health checks green", or "ROLLED BACK" with the old version running as before. Either way the shop opens normally; send the technician the install log in `C:\ProgramData\CoffeeLounge\logs`.
