'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { openDatabase, driver } = require('../src/sqlite');

test(`database adapter (${driver}) behaves like better-sqlite3`, () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
  // unused named values are ignored
  const r = db.prepare('INSERT INTO t (a) VALUES (@a)').run({ a: 'x', unused: 1 });
  assert.deepStrictEqual(r, { changes: 1, lastInsertRowid: 1 });
  assert.deepStrictEqual(db.prepare('SELECT * FROM t').get(), { id: 1, a: 'x' }, 'plain object rows');
  assert.strictEqual(db.prepare('SELECT * FROM t WHERE id = ?').get(9), undefined);

  const add = db.prepare('INSERT INTO t (a) VALUES (?)');
  const tx = db.transaction((rows) => { for (const x of rows) add.run(x); return rows.length; });
  assert.strictEqual(tx(['b', 'c']), 2);
  assert.throws(() => db.transaction(() => { add.run('d'); throw new Error('boom'); })(), /boom/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM t').get().n, 3, 'failed transaction rolled back');

  // nested: inner failure rolls back only the inner part
  db.transaction(() => {
    add.run('e');
    try { db.transaction(() => { add.run('f'); throw new Error('inner'); })(); } catch { /* expected */ }
  })();
  assert.deepStrictEqual(db.prepare('SELECT a FROM t ORDER BY id').all().map((x) => x.a), ['x', 'b', 'c', 'e']);
  db.close();
});
