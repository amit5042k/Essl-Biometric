# eSSL Attendance Management System

A Node.js attendance management system for **eSSL Classic** (K21, K30, X990, MB160, iClock series, …) and
**eSSL Orcus** (face/fingerprint) biometric terminals. It supports both ways these devices can talk to a server:

| Mode | How it works | Use when |
|------|--------------|----------|
| **TCP/IP (pull)** | The server connects to the device on port **4370** (ZK binary protocol, TCP or UDP) and downloads users and punches on a schedule. | Device and server are on the same LAN / VPN. |
| **ADMS / Cloud (push)** | The device connects to the server over HTTP (`/iclock/*`) and uploads punches in real time. | Orcus and newer Classic firmware, devices at remote sites, behind NAT, or on 4G. |

## Features

- **Devices**: add/test/sync TCP/IP devices, auto-registration of ADMS devices (with an approval step), device info
  (serial, firmware, user/log counts), clock sync, restart, clear logs (always after a download), activity log,
  ADMS command queue.
- **Employees**: master data, departments, shift assignment, CSV import, auto-import of users enrolled on devices,
  upload employees (ID, name, card) to devices.
- **Transfer employees between machines** (e.g. Classic → Orcus): tick employees on the Employees page and send
  them to one or more machines. The user record (ID, name, card) is always created; fingerprint / face / palm
  templates go along when the target uses the same algorithm. Only the selected employees are transferred.
- **Punch logs**: de-duplicated storage of every punch, filters, CSV export, manual punches (regularisation)
  with reason.
- **Rules**: shifts with grace time, early-exit grace, half/full-day thresholds, weekly offs, overtime, night shifts
  (crossing midnight), holidays, leaves (CL/SL/EL/OD/LWP).
- **Reports**: live dashboard, daily attendance (in/out, hours, late, early, OT), monthly muster roll with
  P/A/HD/MP/WO/HO/L codes and payable days, per-employee report. All exportable to CSV (opens in Excel).
- Single admin login (scrypt-hashed password, HTTP-only session cookie). SQLite storage, no external database.

## Guide

A complete illustrated guide (features, screen tour, attendance rules, setup, what is done and what is left) is in
[docs/eSSL-Attendance-Guide.pdf](docs/eSSL-Attendance-Guide.pdf).

## Requirements

- Node.js **22 or newer** recommended: it has SQLite built in, so nothing needs compiling. Node 20.12+ also
  works but then installs the `better-sqlite3` module, which must be compiled or downloaded for your system.
- Network access from the server to the devices (pull mode) or from the devices to the server (push mode)

## Windows program (.exe)

For a single Windows PC there is no need to install Node.js:

1. Unzip `essl-attendance-windows.zip` to a permanent folder, e.g. `C:\essl-attendance`.
2. Double-click `essl-attendance.exe`. A console window opens and the browser shows the app at
   `http://localhost:3000` (sign in with `admin` / `admin123`, then change the password).
3. Keep the console window open while the app is in use; closing it stops the app.

Data is kept in the `data` folder next to the `.exe` (back it up). An optional `.env` next to the `.exe`
changes settings (rename `.env.example`). The program is unsigned, so Windows SmartScreen asks once
(*More info → Run anyway*), and Windows Firewall asks to allow network access (allow *Private networks* so
machines and other PCs can reach it). `README-Windows.txt` in the zip has the details.

**Building it** (on any OS with Node 22+ and curl, internet access to nodejs.org):

```bash
npm install
npm run build:exe          # dist/essl-attendance.exe, dist/essl-attendance-windows.zip
```

The script bundles the app with esbuild, packs it and the web UI into a Node *single executable application*
blob, downloads the official `node.exe` of the same Node version from nodejs.org (SHA-256 checked), removes its
signature and injects the blob. On Linux it also builds `dist/essl-attendance-linux-x64` for testing.

## Install and run

```bash
npm install
cp .env.example .env     # then edit ADMIN_PASSWORD etc.
npm start
```

Open `http://<server-ip>:3000` and sign in with `ADMIN_USER` / `ADMIN_PASSWORD` (default `admin` / `admin123`
if not set; change it under **Settings**). The admin account is created only on the first start.

To keep it running as a service, use e.g. `pm2 start app.js --name essl`, or NSSM on Windows.

## Deploying on GoDaddy

**Important:** a server on the internet cannot open connections to devices inside your office LAN. When the app is
hosted on GoDaddy, use **ADMS / Cloud (push)** mode on the devices. TCP/IP (pull) mode only works from a hosted server
if each device is reachable from the internet (port forwarding on the office router, or a VPN), which is not
recommended.

### Option A – cPanel shared hosting (only if your cPanel has "Setup Node.js App")

1. In cPanel open **Setup Node.js App → Create Application**:
   - Node.js version: **20** or newer (the highest offered)
   - Application mode: Production
   - Application root: e.g. `essl-attendance`
   - Application URL: a domain or subdomain, e.g. `attendance.yourcompany.com`, at its **root** (no sub-path) —
     the devices always call `/iclock/...`
   - Application startup file: `app.js`
2. Upload the project files (everything except `node_modules/` and `data/`) into the application root with
   File Manager or FTP.
3. In the app's page add environment variables: `ADMIN_PASSWORD`, `TIMEZONE=Asia/Kolkata`, and
   `DB_PATH=/home/<cpanel-user>/essl-data/attendance.db` (a folder outside `public_html`).
4. Click **Run NPM Install**, then **Restart**.
5. Do **not** enable "Force HTTPS redirect" for this subdomain: most terminals send ADMS data over plain HTTP on
   port 80. You can still open the web UI with `https://`.
6. On each device: **Comm. → Cloud Server Setting** → server address `attendance.yourcompany.com`, port `80`,
   HTTPS off, then approve the device on the **Devices** page.

Shared hosting stops idle Node apps; that is fine for push mode because each device upload wakes it up. With
Node 22 or newer selected, the built-in SQLite is used and nothing has to compile. On Node 20, *Run NPM Install*
must build `better-sqlite3`; if that fails, choose Node 22 (or use Option B).

### Option B – GoDaddy VPS / dedicated server (recommended)

```bash
# Ubuntu, as a sudo user
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential nginx
git clone <this repo> essl-attendance && cd essl-attendance
npm ci --omit=dev
cp .env.example .env && nano .env        # set ADMIN_PASSWORD, PORT=3000
sudo npm i -g pm2 && pm2 start app.js --name essl && pm2 save && pm2 startup
```

Put nginx in front (`proxy_pass http://127.0.0.1:3000;` for `server_name attendance.yourcompany.com`), keep
plain HTTP on port 80 working for `/iclock/` and add HTTPS for the UI if you like. Open ports 80/443 in the
firewall. Point the devices at the domain, port 80.

### Backups

All data is in the single SQLite file (`DB_PATH`, default `data/attendance.db`). Copy it regularly (stop the app or
use `sqlite3 attendance.db ".backup backup.db"`).

## Connecting devices

### TCP/IP (pull) — Classic & Orcus

1. On the device: **Menu → Comm. → Ethernet**: set a static IP, subnet and gateway.
2. **Comm. → PC Connection / Comm Key**: note the Comm Key (default `0`).
3. In the app: **Devices → Test connection** with the IP, then **Add device** (mode *TCP/IP*).
4. The server downloads logs every `POLL_MINUTES` (per-device override available) and synchronises the device clock
   once a day. **Sync now** downloads immediately.

Use protocol **UDP** only for old firmware that does not accept TCP. Allow port 4370 through any firewall between
the server and the device.

### ADMS / Cloud server (push) — Orcus and newer Classic firmware

1. On the device: **Menu → Comm. → Cloud Server Setting** (sometimes *ADMS*):
   - Server address: the server's IP or domain name
   - Server port: the app's `PORT` (default `3000`)
   - Disable *HTTPS* and *Proxy* on the device (terminate TLS in a reverse proxy if needed)
2. The device appears on the **Devices** page as `ADMS <serial>`. Edit it, give it a name and tick **Enabled**.
   Until then the server does not acknowledge its uploads, so nothing is lost — the device re-sends once approved.
   Set `ADMS_AUTO_APPROVE=true` to skip the approval step on a trusted network.
3. Punches arrive in real time. Employee uploads, *Clear logs*, *Restart* and *Re-upload all* are queued and
   delivered the next time the device polls (every few seconds).

**Time zone:** the machines keep local time, so the app works in `TIMEZONE` (default `Asia/Kolkata`) whatever
the server's own clock zone is (VPS and shared hosting usually run on UTC). The matching offset is sent to ADMS
devices during the handshake; override it with `ADMS_TIMEZONE` (`330` = IST, +05:30) only if needed.

## How attendance is calculated

- A shift's attendance day starts **4 hours before the shift start**. A 09:30 shift collects punches from 05:30 to
  05:30 the next day, so a late checkout after midnight counts for the previous day; a 22:00–06:00 night shift is
  credited to the day it started.
- First punch = **In**, last punch = **Out**. Repeat punches within 1 minute are ignored.
- **Half day by time** (optional, per shift): set *First half ends at* and *Second half starts at*. The first half
  counts if the person arrives on time (within the late grace, or *First half still counts if late by up to*) and
  leaves at or after the first-half end; the second half counts if they arrive by the second-half start and stay
  until the shift ends (within early-exit grace). Both → **P**, one → **HD**, neither → **A**. The two times can
  differ, e.g. a school 08:10–14:40 where teaching staff's first half ends 11:35 and second half starts 11:05,
  while non-teaching staff split at 11:25. Use *Employees → tick → Bulk edit* to set the shift, designation or department of many people.
- Otherwise (no half-day times): work time ≥ *full day* → **P**; ≥ *half day* → **HD**; otherwise **A**.
- **Timing changes** (Shifts → *Add timing change*): a period (from–to, or open-ended) or a single day with its
  own start/end and optional half-day times, applied to one or more shifts. Each day uses the most specific change
  that covers it (a single day beats a period), so past days are re-checked automatically. Empty half-day times
  keep the shift's own.
- **Dual shift**: a timing change can add an evening session (e.g. 08:00–12:00 + 16:00–19:00). Punches before the
  middle of the break count for the morning, the rest for the evening; a session counts with an in and out punch,
  in within the late allowance and out within early-exit grace. Both → **P**, one → **HD**, none → **A** (remark
  says which session and why). Hours exclude the break; late/early minutes add up over both sessions. A single punch on a past day is **MP**
  (missed punch, counted as present so it can be regularised with a manual punch); on the current day it is shown
  as present.
- **Late** if In is after shift start + grace; **early exit** if Out is before shift end − grace.
- **OT** (if enabled on the shift) = work time beyond the shift length; all work on weekly offs / holidays is OT.
- Days without punches become **HO** (holiday), **WO** (weekly off), **L** (approved leave) or **A**.
- Payable days = present days (a half day counts 0.5) + leave + weekly offs + holidays.

## Trying it without hardware

Two simulators are included:

```bash
npm run simulate:zk              # fake TCP/IP terminal on port 4370 (add a pull device 127.0.0.1:4370)
npm start
npm run simulate:adms            # fake ADMS terminal posting to http://localhost:3000 (approve it, then run again)
```

The simulators implement the protocols as this app understands them. They are for trying the app and for tests,
not a substitute for testing against your actual device model and firmware.

## Tests

```bash
npm test
```

Covers the ZK protocol client (connect, comm-key auth, chunked buffered reads, users, attendance, time), the ADMS
endpoints, pull sync through the HTTP API and the attendance rules.

## Project layout

```
src/
  server.js              Express app + scheduler start-up (app.js at the root starts it)
  config.js              settings from environment / .env
  db.js                  SQLite schema
  auth.js                admin login and sessions
  zk/                    ZK binary protocol client (TCP/UDP 4370)
  adms/                  ADMS / iClock push endpoints and parsers
  services/devices.js    device operations + polling scheduler
  services/attendance.js shift/attendance calculation
  services/punches.js    punch storage, user import
  routes/api.js          REST API used by the web UI
public/                  web UI (plain HTML/JS, no build step)
docs/                    PDF guide; docs/guide-src/ has the source of pages added later
tools/                   ZK and ADMS device simulators
test/                    node:test suites
```

## REST API

All endpoints are under `/api` and require the session cookie from `POST /api/login`
(`{ "username": "...", "password": "..." }`). Main endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST/PUT/DELETE | `/devices`, `/devices/:id` | device CRUD |
| POST | `/devices/test` | probe a TCP/IP device |
| POST | `/devices/:id/sync` · `/time` · `/restart` · `/clear-logs` | device actions |
| POST | `/devices/:id/upload-employees` | `{ codes: [...] }` or all active employees |
| GET/POST/PUT/DELETE | `/employees`, `/employees/:id`; POST `/employees/bulk` | employee master |
| GET | `/biometrics/summary`, `/biometrics/:code` | stored template counts / list (no template data) |
| POST | `/biometrics/copy` | `{ codes, sourceDeviceId?, targetDeviceIds, types: ["finger","face","palm"] }` |
| POST | `/biometrics/fetch` | `{ deviceId, codes? }` read templates from a device into the app |
| DELETE | `/biometrics/:code` | delete stored templates of one employee |
| GET/POST | `/punches`, `/punches.csv` | punch logs, manual punch |
| GET | `/reports/daily?date=` · `/reports/daily.csv` | daily attendance |
| GET | `/reports/monthly?month=YYYY-MM` · `/reports/monthly.csv` | muster roll |
| GET | `/reports/employee?code=&from=&to=` | one employee |
| CRUD | `/shifts`, `/holidays`, `/leaves` | rules |

## Notes and limits

- **Transferring employees** (Employees → tick employees → *Transfer to machines*):
  - The user record is always created/updated on each target; biometrics are added when compatible.
  - TCP/IP machines are read on the spot; ADMS machines upload templates by themselves when someone enrols
    (use *Re-upload all* on the Devices page to collect templates enrolled earlier).
  - TCP/IP targets receive fingerprints only; face and palm templates can only be sent to ADMS targets.
  - Templates only work between machines using the same algorithm (e.g. ZKFinger 10, the same face engine).
    The app reads each machine's fingerprint/face algorithm version (TCP/IP: on sync; ADMS: from the device's
    INFO / options / BIODATA uploads), shows it on the Devices page, and skips templates whose version differs
    from the target unless *Send even when versions differ* is ticked. Unknown versions are sent with a warning.
  - Classic ↔ Orcus: user records and (if both have a fingerprint sensor with the same algorithm) fingerprints
    can be copied; face templates cannot, because the face engines differ.
  - Copies of the templates are kept in the database so they can be sent later; they can be deleted per
    employee (click the count in the *Biometrics* column). Treat the database file as sensitive personal data.
- Pull mode reads the full device log on every sync (the protocol has no "since" filter). Duplicates are ignored.
  For devices with very large logs, enable *Clear device logs after each sync* — logs are only cleared after they
  have been saved.
- **Device clocks.** Punch times come from the machine's clock, so a drifting clock shifts attendance.
  - TCP/IP machines: every sync compares the machine's clock with the server and corrects it when it is off by
    more than `TIME_DRIFT_SECONDS` (default 60), plus once a day. *Sync time* corrects it on demand and says by
    how much it was off.
  - ADMS machines (e.g. Orcus) take the server time only when they connect (HTTP `Date` header + `TimeZone`; push
    3.x firmware may also ask `/iclock/rtdata?type=time`, which the app answers). Between restarts the clock can
    drift. The app estimates the drift from real-time punches and shows it on the Devices page. *Re-sync clock*
    restarts the machine; *Restart daily at* (device settings) does that automatically at a quiet time.
