# Coffee Lounge: owner and administrator guide

For you, the owner, and anyone you make a manager. Staff training sheets are in [TRAINING.md](TRAINING.md); what to do when something goes wrong is in [RUNBOOKS.md](RUNBOOKS.md). Every name in **bold** is a menu item, tab or button exactly as it appears on screen.

## 1. What runs where

| Thing | Where | Notes |
|---|---|---|
| The server (database, API, background worker) | The counter iMac, as Windows services that start by themselves | The PC must stay on during service. Nothing else is installed on it: no browsing, no e-mail (D-34) |
| The counter app | Full screen on the iMac, under the Windows account **Counter** | Opens the staff app; can save the app's own exports and bill files to Downloads, nothing else |
| Staff tablets and phones | Any browser on the shop Wi-Fi, at `https://192.168.100.250:8443` | Each device is registered once (§3) and trusts the shop certificate (installed at setup) |
| Guest phones | The QR code on each table, plain Wi-Fi | They can only see the menu, order and ask for the bill |
| The backup drives A and B | USB drive `B:` on the iMac, swapped every Monday | One is always at your home (§6) |
| Your USB key | At your home, with a printed copy of the backup key | The shop certificate key and the backup key. **Without it no backup can be opened** |

## 2. People, roles and permissions

- **Users & roles** → **People**: add a person (user name, display name, roles), reset a password or PIN. A new person changes the password at first login.
- **Users & roles** → **Roles**: what each role may do. Owner-only permissions (marked 🔒) cannot be given to anyone else: roles, financial settings, the mailbox, backups and restores.
- A single person can be given or refused one permission on top of their roles (overrides); the preview shows exactly what they will be able to do.
- Refund approvers: by default only you (I-14). A manager can be given `payments.refund` on **Roles**.

## 3. Devices

- **Devices** → **Create code**: an 8-digit code, valid 24 hours, for one device. On the new device, open the shop address and type the code on **Register this device**.
- Personal phones of staff are registered as "personal"; you can revoke any device on **Devices** and it is logged out at once.

## 4. Settings

| Setting | Where | Who |
|---|---|---|
| Shop name, address, phone, receipt footer, brand colour | **Settings** → **Shop and branding** | Owner, manager |
| Guest ordering hours, thresholds and lists (refund reasons, asset places …) | **Settings** | Owner, manager; financial ones owner only |
| Printers, test print | **Settings** → **Printers** | Owner, manager |
| The mailbox for scheduled e-mails (I-17) | **Settings** → **E-mail (scheduled reports)**: provider's server, port, your address, an **app password** you create at your provider; **Send a test** | You only |
| The off-site copy of the backups (I-22) | **Settings** → **Off-site copy of the backups**: endpoint, region, bucket, key ID and secret key; **Test** | You only |

Passwords and keys you type there are stored encrypted and are never shown again. To change one, type the new one; leave it empty to keep the saved one.

## 5. Reports and e-mails

- **Reports** opens on the overview (today against the same day last week). Every tile and chart opens the report behind it; reports open down to the bills and lines.
- **Download CSV** / **Download PDF** on any report (needs `reports.export`). On the counter iMac the file goes to Downloads.
- **Reports** → **Day-end**: the report of a finished business day (a business day runs 04:00 to 03:59). It is made once at 04:25 and never changes; print it on the receipt printer or download the PDF.
- **Reports** → **E-mails**: which report goes to whom and when. The suggested start (I-18): the day-end daily at 08:00 to you; sales by day weekly on Monday. Without internet the e-mails wait and go when it is back; the list shows each e-mail's status and **Try again now**.

## 6. Backups (BACKUP_RECOVERY.md)

What happens by itself:

| When | What |
|---|---|
| Every few minutes | The latest changes are copied, encrypted, to the backup drive |
| 04:35 every night | A full encrypted backup of the day, plus the bill photos |
| Monday 04:50, and when a different drive is plugged in | A full copy of the database for restoring to a point in time |
| Sunday | The backup is restored into a scratch database and six checks run on it |
| Every 15 minutes, when online | The newest backup to your off-site bucket |

What you do:

1. **Every Monday:** swap the backup drives (unplug A, plug in B, take A home). The red banner "Backup drive missing" appears on every device if no drive is in for 5 minutes.
2. **Check System health** now and then: the backup drive, the last backup, the weekly test restore, the off-site copy.
3. **Once a year (and before go-live):** the key check, DRILL-4: open last night's backup with the key from your USB key ([CHECKLISTS.md](CHECKLISTS.md)).

A red banner about backups on any device: see RUNBOOKS.md §4.

## 7. Restores: only for disasters

A wrong discount, refund or stock entry is **never** fixed with a restore: correct it with a reversing entry. A restore puts the whole shop back to an earlier time and everything since is lost.

- **The iMac died; the backup drive is fine:** RUNBOOKS.md §6 (a replacement PC, about 2 hours).
- **The database is damaged, the PC is fine, or you must go back to a time:** RUNBOOKS.md §7 (`restore.ps1`, with your USB key).

## 8. Upgrades

A new version comes as `CoffeeLounge-Setup-<version>.exe`. Run it outside trading hours, as Administrator. It refuses while bills or the cash shift are open (close them first). It keeps a copy of the current version and of the database first, and if anything fails it puts both back by itself and says **ROLLED BACK** in its log. Nothing ever updates by itself.

## 9. Audit log

**Audit log**: who did what, on which device, before and after, with the reason and who approved. Filter by person, record or date. It cannot be changed or deleted by anyone.
