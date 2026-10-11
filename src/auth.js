'use strict';

const crypto = require('node:crypto');

const COOKIE = 'essl_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function ensureAdmin(db, username, password, logger = console) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  logger.log(`[auth] created admin user "${username}" - change the password after first login`);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth(db, { sessionHours }) {
  const ttl = sessionHours * 3600 * 1000;

  function login(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
    if (!user || !verifyPassword(password, user.password_hash)) return null;
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + ttl);
    return { token, user: { id: user.id, username: user.username } };
  }

  function userFromRequest(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const row = db
      .prepare('SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
      .get(token);
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, username: row.username, token };
  }

  function middleware(req, res, next) {
    const user = userFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    req.user = user;
    next();
  }

  function setCookie(res, token, req) {
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttl / 1000)}${secure}`);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  function logout(token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  function changePassword(userId, current, next) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !verifyPassword(current, user.password_hash)) return false;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return true;
  }

  return { login, logout, middleware, setCookie, clearCookie, changePassword, userFromRequest };
}

module.exports = { createAuth, ensureAdmin, hashPassword, verifyPassword };
