'use strict';

const path = require('node:path');

/** True when running as the packaged single executable (essl-attendance.exe). */
const isSea = (() => {
  try {
    return require('node:sea').isSea(); // eslint-disable-line global-require
  } catch {
    return false;
  }
})();

// Folder for .env and data/: next to the .exe, or the project root.
const appRoot = isSea ? path.dirname(process.execPath) : path.join(__dirname, '..');

/** Web UI files packed into the executable (see tools/build-exe.js). */
const UI_FILES = ['index.html', 'app.js', 'style.css'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function embeddedUi() {
  const sea = require('node:sea'); // eslint-disable-line global-require
  const files = new Map(UI_FILES.map((f) => [`/${f}`, Buffer.from(sea.getAsset(`public/${f}`))]));
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const name = req.path === '/' ? '/index.html' : req.path;
    const body = files.get(name);
    if (!body) return next();
    res.type(TYPES[path.extname(name)]).send(body);
  };
}

module.exports = { isSea, appRoot, UI_FILES, embeddedUi };
