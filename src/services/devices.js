'use strict';

const { ZKClient } = require('../zk/client');
const { savePunches, importDeviceUsers } = require('./punches');
const T = require('../util/time');
const { userInfoCommand } = require('./biometrics');

/**
 * Device operations for both connection modes:
 *  - pull: the server connects to the terminal on TCP/UDP 4370 (ZK protocol)
 *  - push: the terminal posts to /iclock/* (ADMS); operations are queued as
 *          commands and delivered when the device next polls.
 */
class DeviceService {
  constructor(db, config, logger = console) {
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.running = new Map(); // deviceId -> Promise
    this.timer = null;
  }

  get(id) {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  }

  log(deviceId, message, level = 'info') {
    this.db.prepare('INSERT INTO device_logs (device_id, level, message) VALUES (?, ?, ?)').run(deviceId, level, message);
    if (level === 'error') this.logger.error(`[device ${deviceId}] ${message}`);
  }

  queueCommand(deviceId, command) {
    const info = this.db
      .prepare('INSERT INTO device_commands (device_id, command) VALUES (?, ?)')
      .run(deviceId, command);
    return info.lastInsertRowid;
  }

  async withClient(device, fn) {
    const zk = new ZKClient({
      ip: device.ip,
      port: device.port || 4370,
      password: device.comm_key || 0,
      transport: device.transport || 'tcp',
      timeout: 15000,
    });
    await zk.connect();
    try {
      return await fn(zk);
    } finally {
      await zk.disconnect();
    }
  }

  /** Connects with ad-hoc parameters (used by "Test connection"). */
  async probe(params) {
    return this.withClient(params, (zk) => zk.getInfo());
  }

  /** Runs one device operation at a time per device. */
  _serial(deviceId, fn) {
    const prev = this.running.get(deviceId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.running.set(deviceId, next);
    next.finally(() => {
      if (this.running.get(deviceId) === next) this.running.delete(deviceId);
    }).catch(() => {});
    return next;
  }

  /** Downloads users + attendance logs from a pull-mode device. */
  sync(deviceId, { clearAfter } = {}) {
    return this._serial(deviceId, async () => {
      const device = this.get(deviceId);
      if (!device) throw new Error('Device not found');
      if (device.mode !== 'pull') {
        this.queueCommand(device.id, 'CHECK');
        return { queued: true, message: 'Push device: CHECK command queued, data arrives on next upload' };
      }
      const started = Date.now();
      try {
        const result = await this.withClient(device, async (zk) => {
          await zk.disableDevice();
          try {
            const info = await zk.getInfo();
            const users = await zk.getUsers();
            const logs = await zk.getAttendance();
            const newUsers = importDeviceUsers(this.db, users);
            const added = savePunches(this.db, device.id, logs);

            const shouldClear = clearAfter ?? !!device.clear_after_sync;
            let cleared = false;
            if (shouldClear && logs.length) {
              await zk.clearAttendance();
              cleared = true;
            }

            let timeSynced = false;
            const today = T.nowLocal().slice(0, 10);
            if (this.config.autoTimeSync && (!device.last_time_sync || device.last_time_sync.slice(0, 10) < today)) {
              await zk.setTime(new Date());
              timeSynced = true;
            }
            return { info, users: users.length, newUsers, logs: logs.length, added, cleared, timeSynced };
          } finally {
            await zk.enableDevice().catch(() => {});
          }
        });

        const now = T.nowLocal();
        this.db
          .prepare(
            `UPDATE devices SET serial_number = COALESCE(?, serial_number), firmware = ?, model = COALESCE(model, ?),
               user_count = ?, log_count = ?, last_seen = ?, last_sync = ?, last_error = NULL,
               last_time_sync = CASE WHEN ? THEN ? ELSE last_time_sync END
             WHERE id = ?`
          )
          .run(
            result.info.serialNumber || null,
            result.info.firmware,
            result.info.deviceName,
            result.users,
            result.cleared ? 0 : result.logs,
            now,
            now,
            result.timeSynced ? 1 : 0,
            now,
            device.id
          );
        const msg = `Synced in ${((Date.now() - started) / 1000).toFixed(1)}s: ${result.logs} logs (${result.added} new), ${result.users} users (${result.newUsers} new)${result.cleared ? ', device log cleared' : ''}`;
        this.log(device.id, msg);
        return { ...result, message: msg };
      } catch (err) {
        this.db.prepare('UPDATE devices SET last_error = ?, last_sync = ? WHERE id = ?').run(err.message, T.nowLocal(), device.id);
        this.log(device.id, `Sync failed: ${err.message}`, 'error');
        throw err;
      }
    });
  }

  info(deviceId) {
    return this._serial(deviceId, async () => {
      const device = this.requirePull(deviceId);
      const info = await this.withClient(device, (zk) => zk.getInfo());
      this.db
        .prepare('UPDATE devices SET serial_number = COALESCE(?, serial_number), firmware = ?, last_seen = ?, last_error = NULL WHERE id = ?')
        .run(info.serialNumber || null, info.firmware, T.nowLocal(), device.id);
      return info;
    });
  }

  requirePull(deviceId) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode !== 'pull') {
      throw Object.assign(new Error('Operation only available for TCP/IP (pull) devices'), { status: 400 });
    }
    return device;
  }

  setTime(deviceId) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      // ADMS terminals take their clock from the server (HTTP Date header +
      // TimeZone option) during the handshake; there is no direct command.
      return Promise.resolve({
        queued: false,
        message: 'ADMS devices take time from the server at handshake. Check ADMS_TIMEZONE, or restart the device to force a handshake.',
      });
    }
    return this._serial(deviceId, async () => {
      await this.withClient(device, (zk) => zk.setTime(new Date()));
      this.db.prepare('UPDATE devices SET last_time_sync = ? WHERE id = ?').run(T.nowLocal(), device.id);
      this.log(device.id, 'Device clock synchronised');
      return { message: 'Device time updated' };
    });
  }

  restart(deviceId) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      this.queueCommand(device.id, 'REBOOT');
      return Promise.resolve({ queued: true, message: 'REBOOT queued' });
    }
    return this._serial(deviceId, async () => {
      const zk = new ZKClient({ ip: device.ip, port: device.port, password: device.comm_key, transport: device.transport });
      await zk.connect();
      await zk.restart();
      this.log(device.id, 'Restart requested');
      return { message: 'Device is restarting' };
    });
  }

  clearLogs(deviceId) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      this.queueCommand(device.id, 'CLEAR LOG');
      return Promise.resolve({ queued: true, message: 'CLEAR LOG queued' });
    }
    // Always download first so nothing is lost.
    return this.sync(deviceId, { clearAfter: true });
  }

  deviceUsers(deviceId) {
    return this._serial(deviceId, async () => {
      const device = this.requirePull(deviceId);
      return this.withClient(device, (zk) => zk.getUsers());
    });
  }

  /** Enrols / updates an employee on a device (fingerprint/face must be enrolled on the terminal). */
  uploadEmployee(deviceId, employee) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      this.queueCommand(device.id, userInfoCommand(employee));
      return Promise.resolve({ queued: true });
    }
    return this._serial(deviceId, async () => {
      const res = await this.withClient(device, (zk) =>
        zk.setUser({ userId: employee.code, name: employee.name, card: employee.card_no })
      );
      this.log(device.id, `Uploaded employee ${employee.code}`);
      return res;
    });
  }

  removeEmployee(deviceId, code) {
    const device = this.get(deviceId);
    if (!device) throw new Error('Device not found');
    if (device.mode === 'push') {
      this.queueCommand(device.id, `DATA DELETE USERINFO PIN=${code}`);
      return Promise.resolve({ queued: true });
    }
    return this._serial(deviceId, async () => {
      const ok = await this.withClient(device, (zk) => zk.deleteUser(code));
      this.log(device.id, `Removed employee ${code}: ${ok ? 'done' : 'not on device'}`);
      return { removed: ok };
    });
  }

  // --------------------------------------------------------------- scheduler

  start() {
    const tick = () => {
      const devices = this.db.prepare(`SELECT * FROM devices WHERE enabled = 1 AND mode = 'pull'`).all();
      const now = T.toMinutes(T.nowLocal()) * 60000;
      for (const d of devices) {
        if (this.running.has(d.id)) continue;
        const every = (d.poll_minutes || this.config.defaultPollMinutes) * 60000;
        const last = d.last_sync ? T.toMinutes(d.last_sync) * 60000 : 0;
        if (now - last >= every) this.sync(d.id).catch(() => {});
      }
    };
    this.timer = setInterval(tick, 30000);
    this.timer.unref();
    setTimeout(tick, 2000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { DeviceService };
