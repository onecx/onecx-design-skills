// Usage: node <skill>/check.mjs <url> <expect.json> > check-output.txt
// expect.json = array of { sel, w, h, fontWeight?, textAlign?, bg?, texts? } written from the coverage table (root included).
//   sel: CSS selector (every match is checked); w/h: spec px (omit to skip); tolerance 2px.
//   bgImage: true fails when the computed background-image is none.
//   fontWeight "700", textAlign "center", bg "rgb(230, 224, 233)" (rgb(r, g, b) text, hex converted; alpha: rgba(r, g, b, a)): compared to computed style.
//   texts: strings (from text= in the spec) allowed on screen. Compared per ELEMENT (innerText, whitespace collapsed; elements holding only text/<br>/<span> count once), so <br>/runs are fine.
//   Every such on-screen text must be in the union of all `texts` (checked when any entry has texts) and every `texts` entry must exist on screen (placeholder/value do not count).
// Exit code 1 on any FAIL / NOT FOUND. Needs `playwright` (npm i -D playwright; npx playwright install chromium).
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chromium } = createRequire(process.cwd() + '/')('playwright'); // resolves from the project's node_modules

const [url, file] = process.argv.slice(2);
if (!url || !file) { console.error('usage: node check.mjs <url> <expect.json>'); process.exit(2); }
const EXPECT = JSON.parse(readFileSync(file, 'utf8'));
const TOL = 2;
if (!Array.isArray(EXPECT) || !EXPECT.length) { console.error('expect.json must be a non-empty array'); process.exit(1); }

const b = await chromium.launch();
let code = 1;
try {
const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
await p.goto(url, { waitUntil: 'networkidle' });
await p.waitForTimeout(500);
const data = await p.evaluate((E) => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const rows = [];
  for (const e of E) {
    const els = [...document.querySelectorAll(e.sel)];
    if (!els.length) { rows.push({ el: e.sel, notFound: true, e }); continue; }
    els.forEach((n, i) => {
      const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
      rows.push({ el: `${e.sel}[${i}]`, e, w: r.width, h: r.height, fontWeight: cs.fontWeight, bgImage: cs.backgroundImage, textAlign: cs.textAlign, bg: cs.backgroundColor });
    });
  }
  const allowed = new Set(E.flatMap((e) => e.texts ?? []).map(norm));
  const stray = [], present = new Set();
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT'];
  const inline = (n) => [...n.children].every((c) => c.tagName === 'BR' || (c.tagName === 'SPAN' && inline(c)));
  const take = (s) => { s = norm(s); if (s) { present.add(s); if (allowed.size && !allowed.has(s)) stray.push(s); } };
  const walk = (n) => {
    if (SKIP.includes(n.tagName)) return;
    const own = [...n.childNodes].filter((c) => c.nodeType === 3 && norm(c.textContent));
    if (own.length && inline(n)) return take(n.innerText);
    own.forEach((c) => take(c.textContent));
    [...n.children].forEach(walk);
  };
  walk(document.body);
  const missing = [...allowed].filter((s) => !present.has(s));
  const imgs = [...document.images].map((i) => ({ src: i.getAttribute('src'), nw: i.naturalWidth }));
  const fonts = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.weight}`);
  return { rows, stray, missing, imgs, fonts };
}, EXPECT);

const out = [];
const add = (el, measured, expected, ok) => out.push({ el, measured, expected, result: ok ? 'PASS' : 'FAIL' });
for (const r of data.rows) {
  if (r.notFound) { add(r.el, 'NOT FOUND', `${r.e.w ?? '-'}×${r.e.h ?? '-'}`, false); continue; }
  const { e } = r, bad = [];
  if (e.w != null && Math.abs(r.w - e.w) > TOL) bad.push('w');
  if (e.h != null && Math.abs(r.h - e.h) > TOL) bad.push('h');
  if (e.fontWeight != null && String(e.fontWeight) !== r.fontWeight) bad.push(`fontWeight=${r.fontWeight}`);
  if (e.textAlign != null && e.textAlign !== r.textAlign) bad.push(`textAlign=${r.textAlign}`);
  if (e.bg != null && e.bg !== r.bg) bad.push(`bg=${r.bg}`);
  if (e.bgImage && r.bgImage === 'none') bad.push('bgImage=none');
  const exp = [`${e.w ?? '-'}×${e.h ?? '-'}`, e.fontWeight && `wt ${e.fontWeight}`, e.textAlign, e.bg, e.bgImage && 'bg-image'].filter(Boolean).join(' ');
  add(r.el, `${r.w.toFixed(1)}×${r.h.toFixed(1)}${bad.length ? ' (' + bad.join(',') + ')' : ''}`, exp, !bad.length);
}
for (const s of data.stray) add(`text "${s.slice(0, 40)}"`, 'not in texts list', '-', false);
for (const s of data.missing) add(`text "${s.slice(0, 40)}"`, 'not found on screen', 'present', false);
for (const i of data.imgs) add(`img ${(i.src ?? '').slice(0, 40)}`, `naturalWidth ${i.nw}`, '>0', i.nw > 0);
console.table(out);
console.log('loaded fonts:', data.fonts.join(', '));
const pass = out.filter((o) => o.result === 'PASS').length;
console.log(`RESULT: ${pass}/${out.length} PASS`);
code = pass === out.length ? 0 : 1;
} finally { await b.close(); }
process.exit(code);
