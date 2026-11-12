'use strict';

// Renders the extra guide page and inserts it after page 11 of
// docs/eSSL-Attendance-Guide.pdf (once; re-running replaces it).
// Needs Playwright (Chromium) and Python's pypdf.
//   node docs/guide-src/build.js
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLAYWRIGHT = process.env.PLAYWRIGHT || 'playwright';
const here = __dirname;
const guide = path.join(here, '..', 'eSSL-Attendance-Guide.pdf');
const page = path.join(here, 'half-day.pdf');

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.goto(`file://${path.join(here, 'half-day.html')}`, { waitUntil: 'networkidle' });
  await p.pdf({
    path: page, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-family:Carlito,sans-serif;font-size:8.5px;color:#8a93a6;padding:0 15mm;display:flex;justify-content:space-between"><span>eSSL Attendance Management System – Guide</span><span>Page 11a</span></div>',
  });
  await browser.close();
  execFileSync('python3', ['-I', '-c', `
import sys
from pypdf import PdfReader, PdfWriter
guide, extra = sys.argv[1], sys.argv[2]
src = PdfReader(guide)
add = PdfReader(extra)
assert len(add.pages) == 1, f"extra page must fit on one page, got {len(add.pages)}"
pages = [p for p in src.pages if 'Page 11a' not in (p.extract_text() or '')]
w = PdfWriter()
for i, p in enumerate(pages):
    w.add_page(p)
    if i == 10:
        w.add_page(add.pages[0])
with open(guide, 'wb') as f:
    w.write(f)
print(len(w.pages), 'pages')
`, guide, page], { stdio: 'inherit' });
})().catch((e) => { console.error(e); process.exit(1); });
