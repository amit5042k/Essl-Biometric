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
- **Punch logs**: de-duplicated storage of every punch, filters, CSV export, manual punches (regularisation)
  with reason.
- **Rules**: shifts with grace time, early-exit grace, half/full-day thresholds, weekly offs, overtime, night shifts
  (crossing midnight), holidays, leaves (CL/SL/EL/OD/LWP).
- **Reports**: live dashboard, daily attendance (in/out, hours, late, early, OT), monthly muster roll with
  P/A/HD/MP/WO/HO/L codes and payable days, per-employee report. All exportable to CSV (opens in Excel).
- Single admin login (scrypt-hashed password, HTTP-only session cookie). SQLite storage, no external database.

## Requirements

- Node.js **20.12 or newer** (Windows, Linux or macOS)
- Network access from the server to the devices (pull mode) or from the devices to the server (push mode)

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
3. In the app's page add environment variables: `ADMIN_PASSWORD`, `ADMS_TIMEZONE=330`, and
   `DB_PATH=/home/<cpanel-user>/essl-data/attendance.db` (a folder outside `public_html`).
4. Click **Run NPM Install**, then **Restart**.
5. Do **not** enable "Force HTTPS redirect" for this subdomain: most terminals send ADMS data over plain HTTP on
   port 80. You can still open the web UI with `https://`.
6. On each device: **Comm. → Cloud Server Setting** → server address `attendance.yourcompany.com`, port `80`,
   HTTPS off, then approve the device on the **Devices** page.

Shared hosting stops idle Node apps; that is fine for push mode because each device upload wakes it up. If
**Run NPM Install** fails while building `better-sqlite3`, the plan cannot run native modules — use Option B.

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

`ADMS_TIMEZONE` is sent to the device during the handshake (`330` = IST, +05:30).

## How attendance is calculated

- A shift's attendance day starts **4 hours before the shift start**. A 09:30 shift collects punches from 05:30 to
  05:30 the next day, so a late checkout after midnight counts for the previous day; a 22:00–06:00 night shift is
  credited to the day it started.
- First punch = **In**, last punch = **Out**. Repeat punches within 1 minute are ignored.
- Work time ≥ *full day* → **P**; ≥ *half day* → **HD**; otherwise **A**. A single punch on a past day is **MP**
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
| GET/POST | `/punches`, `/punches.csv` | punch logs, manual punch |
| GET | `/reports/daily?date=` · `/reports/daily.csv` | daily attendance |
| GET | `/reports/monthly?month=YYYY-MM` · `/reports/monthly.csv` | muster roll |
| GET | `/reports/employee?code=&from=&to=` | one employee |
| CRUD | `/shifts`, `/holidays`, `/leaves` | rules |

## Notes and limits

- Fingerprint and face templates are not copied between devices; enrol biometrics on each terminal. Uploading an
  employee creates the user record (ID, name, card) so they can be enrolled there.
- Pull mode reads the full device log on every sync (the protocol has no "since" filter). Duplicates are ignored.
  For devices with very large logs, enable *Clear device logs after each sync* — logs are only cleared after they
  have been saved.
- Device times are stored as the device's local wall-clock time; keep device clocks correct (auto time sync is on by
  default for pull devices).
