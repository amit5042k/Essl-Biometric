'use strict';

const express = require('express');
const P = require('./parser');
const { savePunches, importDeviceUsers } = require('../services/punches');
const T = require('../util/time');

/**
 * ADMS / iClock "push" protocol. Configure the terminal under
 * Comm. -> Cloud Server Setting (ADMS): server address = this machine,
 * port = this app's port. The device then calls:
 *
 *   GET  /iclock/cdata?SN=..&options=all   handshake, returns options
 *   POST /iclock/cdata?SN=..&table=ATTLOG  attendance logs
 *   POST /iclock/cdata?SN=..&table=OPERLOG users / operation logs
 *   GET  /iclock/getrequest?SN=..          poll for queued commands
 *   POST /iclock/devicecmd?SN=..           command results
 */
function createAdmsRouter({ db, config, logger = console }) {
  const router = express.Router();
  router.use(express.text({ type: () => true, limit: '50mb' }));

  const text = (res, body, status = 200) => res.status(status).type('text/plain').send(body);

  function resolveDevice(req) {
    const sn = String(req.query.SN || req.query.sn || '').trim();
    if (!sn) return { error: 'missing SN' };
    let device = db.prepare('SELECT * FROM devices WHERE serial_number = ?').get(sn);
    if (!device) {
      const info = db
        .prepare(`INSERT INTO devices (name, mode, serial_number, ip, enabled) VALUES (?, 'push', ?, ?, ?)`)
        .run(`ADMS ${sn}`, sn, clientIp(req), config.adms.autoApprove ? 1 : 0);
      device = db.prepare('SELECT * FROM devices WHERE id = ?').get(info.lastInsertRowid);
      logger.log(`[adms] new device ${sn} registered (${device.enabled ? 'enabled' : 'awaiting approval'})`);
      db.prepare('INSERT INTO device_logs (device_id, message) VALUES (?, ?)').run(device.id, `Device registered from ${clientIp(req)}`);
    }
    db.prepare('UPDATE devices SET last_seen = ?, ip = ? WHERE id = ?').run(T.nowLocal(), clientIp(req), device.id);
    return { device };
  }

  function clientIp(req) {
    return String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  }

  // Disabled (unapproved) devices are not acknowledged, so they keep their
  // data and resend it once the device is enabled in the UI.
  function guard(req, res) {
    const { device, error } = resolveDevice(req);
    if (error) {
      text(res, error, 400);
      return null;
    }
    if (!device.enabled) {
      text(res, 'ERROR: device not approved', 403);
      return null;
    }
    return device;
  }

  router.get('/cdata', (req, res) => {
    const device = guard(req, res);
    if (!device) return;
    if (req.query.pushver || req.query.PushVersion) {
      db.prepare('UPDATE devices SET firmware = COALESCE(firmware, ?) WHERE id = ?').run(`push ${req.query.pushver || req.query.PushVersion}`, device.id);
    }
    const lines = [
      `GET OPTION FROM: ${device.serial_number}`,
      `ATTLOGStamp=${device.att_stamp || 'None'}`,
      `OPERLOGStamp=${device.op_stamp || 'None'}`,
      'ATTPHOTOStamp=None',
      'ErrorDelay=30',
      `Delay=${config.adms.delay}`,
      'TransTimes=00:00;14:05',
      'TransInterval=1',
      'TransFlag=TransData AttLog OpLog EnrollUser ChgUser',
      `TimeZone=${config.adms.timeZone}`,
      'Realtime=1',
      'Encrypt=None',
    ];
    text(res, `${lines.join('\r\n')}\r\n`);
  });

  router.post('/cdata', (req, res) => {
    const device = guard(req, res);
    if (!device) return;
    const table = String(req.query.table || '').toUpperCase();
    const stamp = req.query.Stamp || req.query.stamp;
    const body = typeof req.body === 'string' ? req.body : '';

    if (table === 'ATTLOG') {
      const logs = P.parseAttLog(body);
      const added = savePunches(db, device.id, logs);
      db.prepare('UPDATE devices SET last_sync = ?, att_stamp = COALESCE(?, att_stamp), last_error = NULL WHERE id = ?').run(T.nowLocal(), stamp || null, device.id);
      if (logs.length) {
        db.prepare('INSERT INTO device_logs (device_id, message) VALUES (?, ?)').run(device.id, `Received ${logs.length} logs (${added} new)`);
      }
      return text(res, `OK: ${logs.length}`);
    }
    if (table === 'OPERLOG' || table === 'USERINFO') {
      const { users, count } = P.parseOperLog(body);
      if (users.length) importDeviceUsers(db, users);
      if (table === 'OPERLOG' && stamp) db.prepare('UPDATE devices SET op_stamp = ? WHERE id = ?').run(stamp, device.id);
      return text(res, `OK: ${count}`);
    }
    if (table === 'OPTIONS' || table === 'INFO') {
      const info = P.parseDeviceInfo(body);
      db.prepare('UPDATE devices SET firmware = COALESCE(?, firmware), model = COALESCE(?, model), user_count = COALESCE(?, user_count) WHERE id = ?').run(
        info.FWVersion || info.FirmVer || null,
        info.DeviceName || null,
        info.UserCount ? Number(info.UserCount) : null,
        device.id
      );
      return text(res, 'OK');
    }
    // ATTPHOTO, BIODATA, FINGERTMP ... are acknowledged but not stored.
    const lines = body.split(/\r?\n/).filter(Boolean).length;
    return text(res, `OK: ${lines}`);
  });

  router.get('/getrequest', (req, res) => {
    const device = guard(req, res);
    if (!device) return;
    if (req.query.INFO) {
      // INFO=fw version,user count,fp count,att count,ip,...
      const f = String(req.query.INFO).split(',');
      db.prepare('UPDATE devices SET firmware = ?, user_count = ?, log_count = ? WHERE id = ?').run(
        f[0] || device.firmware,
        Number(f[1]) || device.user_count,
        Number(f[3]) || device.log_count,
        device.id
      );
    }
    const cmds = db
      .prepare(`SELECT * FROM device_commands WHERE device_id = ? AND status = 'pending' ORDER BY id LIMIT 10`)
      .all(device.id);
    if (!cmds.length) return text(res, 'OK');
    const mark = db.prepare(`UPDATE device_commands SET status = 'sent', sent_at = ? WHERE id = ?`);
    const now = T.nowLocal();
    for (const c of cmds) mark.run(now, c.id);
    return text(res, `${cmds.map((c) => `C:${c.id}:${c.command}`).join('\r\n')}\r\n`);
  });

  router.post('/devicecmd', (req, res) => {
    const device = guard(req, res);
    if (!device) return;
    const replies = P.parseCommandReplies(req.body);
    const upd = db.prepare(
      `UPDATE device_commands SET status = ?, result = ?, completed_at = ? WHERE id = ? AND device_id = ?`
    );
    const now = T.nowLocal();
    for (const r of replies) {
      upd.run(r.returnCode >= 0 ? 'done' : 'failed', `Return=${r.returnCode}`, now, r.id, device.id);
    }
    return text(res, 'OK');
  });

  // Newer firmwares probe these; acknowledge so they proceed.
  router.all(['/ping', '/registry', '/push', '/fdata', '/querydata'], (req, res) => {
    const device = guard(req, res);
    if (!device) return;
    text(res, 'OK');
  });

  return router;
}

module.exports = { createAdmsRouter };
