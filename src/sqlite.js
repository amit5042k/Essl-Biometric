'use strict';

/**
 * SQLite access with the small part of the better-sqlite3 API the app uses
 * (prepare/get/all/run, exec, pragma, transaction, close).
 *
 * Uses Node's built-in node:sqlite when available (Node 22.5+): nothing to
 * compile, so it also works inside the Windows .exe and on hosts that cannot
 * build native modules. Falls back to better-sqlite3 on older Node versions.
 * Set SQLITE_DRIVER=better-sqlite3 to force the fallback.
 */

function loadBuiltin() {
  if (process.env.SQLITE_DRIVER === 'better-sqlite3') return null;
  // Hide the one-time "SQLite is an experimental feature" warning.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (String(warning?.message ?? warning).includes('SQLite is an experimental feature')) return;
    return emit.call(this, warning, ...rest);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } catch {
    return null;
  } finally {
    process.emitWarning = emit;
  }
}

const DatabaseSync = loadBuiltin();

// Named parameters a statement uses: @name, :name or $name.
const PARAM = /[@:$]([A-Za-z_][A-Za-z0-9_]*)/g;

class Statement {
  constructor(raw, sql) {
    this.raw = raw;
    this.names = new Set([...sql.matchAll(PARAM)].map((m) => m[1]));
  }

  // better-sqlite3 ignores unused named values; node:sqlite rejects them.
  args(args) {
    const a = args[0];
    if (args.length === 1 && a && typeof a === 'object' && !Array.isArray(a) && !Buffer.isBuffer(a)) {
      const only = {};
      for (const k of Object.keys(a)) if (this.names.has(k)) only[k] = a[k];
      return [only];
    }
    return args;
  }

  get(...args) {
    const row = this.raw.get(...this.args(args));
    return row ? { ...row } : undefined; // plain object, like better-sqlite3
  }

  all(...args) {
    return this.raw.all(...this.args(args)).map((row) => ({ ...row }));
  }

  run(...args) {
    const r = this.raw.run(...this.args(args));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
}

class BuiltinDatabase {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }

  prepare(sql) {
    return new Statement(this.raw.prepare(sql), sql);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  pragma(text) {
    this.raw.exec(`PRAGMA ${text}`);
  }

  /** Same contract as better-sqlite3: returns a function running fn in a transaction (nested = savepoint). */
  transaction(fn) {
    return (...args) => {
      const sp = `sp${this.depth}`;
      this.raw.exec(this.depth ? `SAVEPOINT ${sp}` : 'BEGIN');
      this.depth += 1;
      try {
        const result = fn(...args);
        this.depth -= 1;
        this.raw.exec(this.depth ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (err) {
        this.depth -= 1;
        this.raw.exec(this.depth ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
        throw err;
      }
    };
  }

  close() {
    this.raw.close();
  }
}

function openDatabase(file) {
  if (DatabaseSync) return new BuiltinDatabase(file);
  const Better = require('better-sqlite3'); // eslint-disable-line global-require
  return new Better(file);
}

module.exports = { openDatabase, driver: DatabaseSync ? 'node:sqlite' : 'better-sqlite3' };
