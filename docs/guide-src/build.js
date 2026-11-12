'use strict';

// Renders the extra guide pages and inserts them into
// docs/eSSL-Attendance-Guide.pdf (re-running replaces them).
// Needs Playwright (Chromium) and Python's pypdf.
//   node docs/guide-src/build.js
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLAYWRIGHT = process.env.PLAYWRIGHT || 'playwright';
const here = __dirname;
const guide = path.join(here, '..', 'eSSL-Attendance-Guide.pdf');
// Extra pages, inserted after printed page `after` and labelled `label`.
const PAGES = [
  { html: 'half-day.html', after: 11, label: '11a' },
  { html: 'timings.html', after: 11, label: '11b' },
];

(async () => {
  const { chromium } = require(PLAYWRIGHT);
  const browser = await chromium.launch();
  const built = [];
  for (const pg of PAGES) {
    const p = await browser.newPage();
    await p.goto(`file://${path.join(here, pg.html)}`, { waitUntil: 'networkidle' });
    const out = path.join(here, `${pg.label}.pdf`);
    await p.pdf({
      path: out, format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="width:100%;font-family:Carlito,sans-serif;font-size:8.5px;color:#8a93a6;padding:0 15mm;display:flex;justify-content:space-between"><span>eSSL Attendance Management System – Guide</span><span>Page ${pg.label}</span></div>`,
    });
    built.push({ ...pg, pdf: out });
  }
  await browser.close();
  execFileSync('python3', ['-I', '-c', `
import json, sys
from pypdf import PdfReader, PdfWriter
guide, pages = sys.argv[1], json.loads(sys.argv[2])
labels = [f"Page {p['label']}" for p in pages]
src = [p for p in PdfReader(guide).pages if not any(l in (p.extract_text() or '') for l in labels)]
w = PdfWriter()
for i, page in enumerate(src):
    w.add_page(page)
    for p in pages:
        if p['after'] == i + 1:
            extra = PdfReader(p['pdf'])
            assert len(extra.pages) == 1, f"{p['html']} must fit on one page, got {len(extra.pages)}"
            w.add_page(extra.pages[0])
with open(guide, 'wb') as f:
    w.write(f)
print(len(w.pages), 'pages')
`, guide, JSON.stringify(built)], { stdio: 'inherit' });
  for (const pg of built) require('node:fs').unlinkSync(pg.pdf);
})().catch((e) => { console.error(e); process.exit(1); });
