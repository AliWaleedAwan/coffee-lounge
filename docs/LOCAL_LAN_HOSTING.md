# Coffee Lounge — Local Network & Hosting (Phase 1, package 1C)

> Design specification for review R3. Applies to the decided setup (D-02, D-11): the counter iMac is the server, and guests and staff share one Wi-Fi on a PTCL Huawei EchoLife HG8145V5. Router settings marked **VERIFY** must be confirmed from your screenshots (passwords blurred) or during the on-site check. Router menu names differ between firmware versions, so this guide names *settings*, not exact menu paths.

## 1. Network layout

```text
            Internet (optional — PTCL fibre)
                       │
        ┌──────────────┴──────────────┐
        │  Huawei HG8145V5 (ONT/router)│  192.168.100.1
        │  DHCP pool 192.168.100.2–.199│
        └──┬────────────────────────┬──┘
   Ethernet│ cable                  │ Wi-Fi (one SSID, 2.4 + 5 GHz)
           │                        ├── Guest phones ............ http://192.168.100.250:8080
  ┌────────┴─────────┐              ├── 3 shop tablets .......... https://192.168.100.250:8443
  │ Counter iMac      │              └── Waiters' own phones ...... https://192.168.100.250:8443
  │ 192.168.100.250   │
  │ (static, outside  │──USB── Sonic SNC-101 printer
  │  DHCP pool)       │──USB── Sonic SNC-930D scanner
  └───────────────────┘──USB── Backup drive
```

## 2. Addressing plan

| Item | Value | Why |
|---|---|---|
| Router | `192.168.100.1` (PTCL default) | Unchanged |
| DHCP pool | `.2` – `.199` (**VERIFY** current range; shrink if needed) | Leaves `.200`–`.254` free for fixed addresses |
| Counter iMac (server) | **`192.168.100.250`**, set **on the PC itself** (static IPv4, gateway `.1`, DNS `.1`) | ISP-managed routers can be reset remotely, which can wipe DHCP reservations. A PC-side static address outside the pool survives that. |
| Printer, scanner | USB to the iMac | No network address needed |
| QR code URL | `http://192.168.100.250:8080/t/<token>` | IP-based: guest phones using Private DNS / DNS-over-HTTPS can't resolve local names |
| Staff address | `https://192.168.100.250:8443` | Bookmarked on each staff device during registration |

If the server address ever changes, every QR code must be reprinted. The address is therefore treated as permanent.

## 3. Router checklist (on-site, with the owner)

The owner keeps the router and Wi-Fi passwords. They are never written into project files or sent to the developer.

| # | Setting | Required value | Why |
|---|---|---|---|
| R-1 | Router admin password | **Changed from the default** | Guests share the Wi-Fi and can reach `192.168.100.1` |
| R-2 | WPS | **Off** | Prevents push-button/PIN joining |
| R-3 | Wi-Fi security | WPA2-PSK (AES) or WPA2/WPA3 mixed | Encrypted Wi-Fi |
| R-4 | AP / client / SSID isolation on the main SSID | **Off** (**VERIFY**) | If on, guest phones can't reach the server and QR ordering fails |
| R-5 | DHCP range | Ends below `.250` (**VERIFY**) | Avoid address clash with the server |
| R-6 | Band steering / same SSID on 2.4 & 5 GHz | Either is fine | Test both bands in §6 |
| R-7 | Guest network feature | **Not used** (would usually enable isolation) | D-11: one shared Wi-Fi |
| R-8 | Remote management from the internet (WAN-side admin) | Off, if the ISP allows changing it | Reduces exposure |
| R-9 | Ethernet port for the iMac | Any LAN port, cable labelled "SERVER — do not unplug" | Wired is more stable than Wi-Fi |

**Screenshots requested (passwords blurred):** DHCP server settings; WLAN basic and advanced settings for each band; any isolation option.

## 4. Server firewall (Windows Defender Firewall on the iMac)

| Rule | Direction | Port | Scope | Profile |
|---|---|---|---|---|
| CoffeeLounge Customer | Inbound allow | TCP 8080 | Local subnet `192.168.100.0/24` | Private |
| CoffeeLounge Staff | Inbound allow | TCP 8443 | Local subnet | Private |
| PostgreSQL | **No inbound rule**; PostgreSQL listens on `127.0.0.1` only | 5432 | — | — |
| Everything else inbound | Blocked (default) | — | — | All |

The installer creates these rules and sets the network profile of the Ethernet connection to **Private**. File and printer sharing, network discovery and Remote Desktop are turned **off**.

## 5. Staff HTTPS with a shop certificate (D-39)

**How it works:** the installer creates a private **Coffee Lounge Root CA** on the counter PC. It then issues the server certificate for `192.168.100.250` (Subject Alternative Name = that IP, Extended Key Usage = server authentication, validity **730 days**, within Apple's 825-day limit). The root CA's private key is copied to the owner's backup USB key and **deleted from the server** after setup; the owner needs it again only for renewal every two years.

**One-time install of the root certificate on each staff device:**

| Device | Steps (to verify per model during setup) |
|---|---|
| Counter PC (Electron) | Automatic: the Electron app trusts only this root for the server address (certificate pinning) |
| Android tablets/phones | Open `http://192.168.100.250:8080/staff-cert` → download → Settings → Security → *Install a certificate* → *CA certificate*. Chrome then trusts the staff address. |
| iPhone / iPad | Open the same page in Safari → install the profile → Settings → General → *VPN & Device Management* → install → then General → About → *Certificate Trust Settings* → enable full trust |

Only the **public** root certificate is offered on the customer port; it gives no access by itself. Staff APIs still require device registration + login.

**Personal phones:** the owner of the phone can remove the certificate at any time. Removing it simply stops the staff app working on that phone. Revoking the device in the app is immediate either way.

**Guests stay on plain HTTP.** Guest phones can't be asked to trust a private certificate. The customer API exposes only menu, own-order and request-bill functions. The guest cookie is bound to one visit and expires when it closes. This residual risk is recorded in SECURITY.md (SR-3).

## 6. Realtime and connection behaviour on this network

- One live-update stream per open screen. The staff listener uses HTTP/2, so stream count isn't an issue. Guest phones use one HTTP/1.1 stream each.
- Expected load: 3 tablets + ~6 waiter phones + 1 counter PC + up to ~30 guest phones. This is well within the router's and server's capacity, but **VERIFY** in the load test (AC-PERF-1) because consumer ONT Wi-Fi varies.

## 7. On-site acceptance test (before printing QR codes)

| # | Test | Pass condition |
|---|---|---|
| N-1 | iMac cable unplugged/replugged, router rebooted | iMac keeps `192.168.100.250`; staff and guest pages reload |
| N-2 | Android guest phone on 2.4 GHz and on 5 GHz opens the test QR | Menu loads in < 3 s |
| N-3 | iPhone guest phone (with Private Relay / Private DNS on) opens the test QR | Menu loads (IP URL bypasses DNS) |
| N-4 | Guest phone at **every table** and at the counter | Menu loads; signal survey noted |
| N-5 | Guest phone tries `https://192.168.100.250:8443` | Certificate warning; even if bypassed, staff API returns `DEVICE_NOT_REGISTERED` |
| N-6 | Guest phone tries `192.168.100.250:5432` | Connection refused |
| N-7 | Staff Android + iPhone after certificate install | Staff app loads without warnings |
| N-8 | PTCL line unplugged (internet off) | Everything in N-1…N-7 still works |
| N-9 | Router power cycle during an order | Devices show "Reconnecting…", then recover; no duplicate order after retry |

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Guest QR spins forever, staff tablets fine | Client isolation on, or guest on another SSID/band | Check R-4; check which SSID the phone joined |
| Nothing loads on any device | Server PC off/booting, or cable out | Power on / reconnect; wait for "server ready" |
| Staff app shows certificate warning | Root certificate not installed/trusted on that device | Repeat §5 for that device |
| Everything worked until the ISP visited | Router reset to defaults | Re-apply §3 checklist; server IP is unaffected (set on the PC) |
| Pages load slowly at far tables | Weak Wi-Fi | Move router or add a Wi-Fi extender/access point in **bridge** mode (same subnet) |
