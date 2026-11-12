#!/usr/bin/env node
'use strict';

/**
 * Builds the single-file Windows program dist/essl-attendance.exe (plus a zip
 * with instructions) using Node's "single executable application" support:
 *
 *   1. esbuild bundles the app into one script
 *   2. the script and the web UI files become a SEA blob
 *   3. the blob is injected into the official node.exe from nodejs.org
 *      (same version as the Node running this script; SHA-256 checked)
 *
 * Also builds a Linux executable from this machine's node, for testing.
 *   npm run build:exe            (Windows + Linux)
 *   npm run build:exe -- --win   (Windows only)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { UI_FILES } = require('../src/runtime');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(dist, 'cache');
const version = process.version; // the blob must match the node binary it goes into
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const onlyWin = process.argv.includes('--win');

function step(msg) {
  console.log(`\n> ${msg}`);
}

function download(url, file) {
  // curl honours the system/HTTPS proxy; it ships with Windows 10+, macOS and Linux.
  execFileSync('curl', ['-fsSL', '--retry', '3', '-o', file, url], { stdio: 'inherit' });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Official Windows node.exe for this Node version, verified against SHASUMS256.txt. */
function windowsNode() {
  const file = path.join(cache, `node-${version}-win-x64.exe`);
  const sums = path.join(cache, `SHASUMS256-${version}.txt`);
  if (!fs.existsSync(sums)) download(`https://nodejs.org/dist/${version}/SHASUMS256.txt`, sums);
  const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.endsWith(' win-x64/node.exe'));
  if (!line) throw new Error('win-x64/node.exe not listed in SHASUMS256.txt');
  const expected = line.split(/\s+/)[0];
  if (!fs.existsSync(file) || sha256(file) !== expected) {
    console.log(`  downloading node.exe ${version} from nodejs.org`);
    download(`https://nodejs.org/dist/${version}/win-x64/node.exe`, file);
  }
  const got = sha256(file);
  if (got !== expected) throw new Error(`node.exe checksum mismatch (${got} != ${expected})`);
  console.log(`  node.exe ${version} verified (sha256 ${got.slice(0, 16)}…)`);
  return file;
}

/**
 * Removes the Authenticode signature from a Windows executable. Injecting the
 * app would otherwise leave Node's signature broken, which Windows and
 * antivirus tools treat worse than an unsigned program.
 */
function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ / PE32
  const sec = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const at = buf.readUInt32LE(sec);
  const size = buf.readUInt32LE(sec + 4);
  if (!at || !size) return false;
  if (at + size !== buf.length) throw new Error('certificate table is not at the end of the file');
  buf.writeUInt32LE(0, sec);
  buf.writeUInt32LE(0, sec + 4);
  fs.writeFileSync(file, buf.subarray(0, at));
  return true;
}

/** Minimal zip writer (deflate), so no zip tool is needed. */
function writeZip(out, entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, nameBuf, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(deflated.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const cdir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...locals, cdir, end]));
}

async function main() {
  const [major] = version.slice(1).split('.').map(Number);
  if (major < 22) throw new Error(`Node 22 or newer is needed to build (running ${version})`);
  fs.mkdirSync(cache, { recursive: true });

  step('Bundling the app');
  const bundle = path.join(dist, 'essl-attendance.js');
  await require('esbuild').build({ // eslint-disable-line global-require
    entryPoints: [path.join(root, 'app.js')],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundle,
    external: ['better-sqlite3'], // fallback driver, never used inside the exe (node:sqlite is)
    logLevel: 'warning',
  });

  step('Creating the SEA blob');
  const blob = path.join(dist, 'sea-prep.blob');
  const seaConfig = {
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // code cache is platform specific; the blob goes into the Windows node.exe
    assets: Object.fromEntries(UI_FILES.map((f) => [`public/${f}`, path.join(root, 'public', f)])),
  };
  const cfgFile = path.join(dist, 'sea-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(seaConfig, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', cfgFile], { stdio: 'inherit' });

  const { inject } = require('postject'); // eslint-disable-line global-require
  const blobData = fs.readFileSync(blob);
  const built = [];

  step('Building the Windows program');
  const exe = path.join(dist, 'essl-attendance.exe');
  fs.copyFileSync(windowsNode(), exe);
  if (stripSignature(exe)) console.log('  removed the node.exe signature (it would be invalid after injection)');
  await inject(exe, 'NODE_SEA_BLOB', blobData, { sentinelFuse: FUSE });
  built.push(exe);

  if (!onlyWin && process.platform === 'linux') {
    step('Building a Linux executable for testing');
    const bin = path.join(dist, 'essl-attendance-linux-x64');
    fs.copyFileSync(process.execPath, bin);
    fs.chmodSync(bin, 0o755);
    await inject(bin, 'NODE_SEA_BLOB', blobData, { sentinelFuse: FUSE });
    built.push(bin);
  }

  step('Packing the Windows zip');
  const zip = path.join(dist, 'essl-attendance-windows.zip');
  writeZip(zip, [
    { name: 'essl-attendance/essl-attendance.exe', data: fs.readFileSync(exe) },
    { name: 'essl-attendance/.env.example', data: fs.readFileSync(path.join(root, '.env.example')) },
    { name: 'essl-attendance/README-Windows.txt', data: Buffer.from(fs.readFileSync(path.join(__dirname, 'README-Windows.txt'), 'utf8').replace(/\r?\n/g, '\r\n')) },
  ]);
  built.push(zip);

  for (const f of [bundle, blob, cfgFile]) fs.rmSync(f, { force: true });
  console.log('\nDone:');
  for (const f of built) console.log(`  ${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  sha256 ${sha256(f).slice(0, 16)}…`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
