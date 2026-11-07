// compare.mjs: checks a running web page against a design spec WITHOUT pictures (hierarchy, spacing, colors, text).
// Usage (always through node):
//   node compare.mjs <url> <expect.json> [--viewport 1280x800] [--tolerance 2] [--color-tolerance 2] [--max-lines 40] [--wait 500] [--json]
//   node compare.mjs <url> --dump [selector] [--depth 8] [--max-tokens 2000]   page structure in design-query spec notation
//   node compare.mjs <url> --shot <file.png> [selector]                          screenshot (deviceScaleFactor 1) for the vision step
// expect.json = one node or an array of nodes: {sel, name?, nth?, dir?, gap?, pad?, w?, h?, bg?, color?, borderColor?, borderWidth?,
//   radius?, fontSize?, fontWeight?, fontFamily?, text?, strict?, children?} (meaning of every field: reference.md).
// Exit code: 0 = no FAIL, 1 = at least one FAIL or NOT FOUND, 2 = usage error, bad expect.json, page or playwright not available.
// playwright is resolved from the current folder (the project), then from this script's folder, then NODE_PATH, then `npm root -g`.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

const usage = (msg) => {
  console.error(`ERROR ${msg}\nusage: node compare.mjs <url> <expect.json> [--viewport WxH] [--tolerance N] [--color-tolerance N] [--max-lines N] [--wait MS] [--json]\n       node compare.mjs <url> --dump [selector] [--depth N] [--max-tokens N]\n       node compare.mjs <url> --shot <file.png> [selector]`);
  process.exit(2);
};

class Fatal extends Error {}
let browser = null; // set once chromium runs; fatal() then throws so that `finally` closes it
const fatal = (msg) => { if (browser) throw new Fatal(msg); console.error(`ERROR ${msg}`); process.exit(2); }; // could not run (no usage hint)

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opt = { viewport: '1280x800', tolerance: 2, colorTolerance: 2, maxLines: 40, wait: 500, json: false, depth: 8, maxTokens: 2000 };
const pos = [];
let mode = 'compare', modeArg = null, shotFile = null;
const num = (name, v) => { const n = Number(v); if (v == null || !Number.isFinite(n) || n < 0) usage(`${name} needs a number >= 0, got "${v}"`); return n; };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--json') opt.json = true;
  else if (a === '--viewport') { const v = next(); if (!/^\d+x\d+$/.test(v ?? '')) usage(`--viewport needs WIDTHxHEIGHT, e.g. 1280x800, got "${v}"`); opt.viewport = v; }
  else if (a === '--tolerance') opt.tolerance = num(a, next());
  else if (a === '--color-tolerance') opt.colorTolerance = num(a, next());
  else if (a === '--max-lines') opt.maxLines = num(a, next());
  else if (a === '--wait') opt.wait = num(a, next());
  else if (a === '--depth') opt.depth = num(a, next());
  else if (a === '--max-tokens') opt.maxTokens = num(a, next());
  else if (a === '--dump') { mode = 'dump'; if (argv[i + 1] && !argv[i + 1].startsWith('--')) modeArg = next(); }
  else if (a === '--shot') { mode = 'shot'; shotFile = next(); if (!shotFile || shotFile.startsWith('--')) usage('--shot needs a file name, e.g. --shot app.png'); if (argv[i + 1] && !argv[i + 1].startsWith('--')) modeArg = next(); }
  else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else pos.push(a);
}
const url = pos[0];
if (!url) usage('missing <url>');
if (!/^(https?|file):/.test(url)) usage(`<url> must start with http://, https:// or file://, got "${url}"`);
if (mode === 'compare' && pos.length !== 2) usage(pos.length < 2 ? 'missing <expect.json>' : `too many arguments: ${pos.slice(2).join(' ')}`);
if (mode !== 'compare' && pos.length !== 1) usage(`unexpected argument(s): ${pos.slice(1).join(' ')} (a selector goes directly after --dump/--shot <file>)`);
const [vw, vh] = opt.viewport.split('x').map(Number);

// ---------- expect.json ----------
const KEYS = new Set(['sel', 'name', 'id', 'note', 'nth', 'dir', 'gap', 'pad', 'w', 'h', 'bg', 'color', 'borderColor', 'borderWidth',
  'radius', 'fontSize', 'fontWeight', 'fontFamily', 'text', 'strict', 'children']);
// expected colour: #rgb #rgba #rrggbb #rrggbbaa, transparent, rgb()/rgba(), or a spec paint pasted as is: $token(#hex), $token(#hex)/op0.12
function parseExpectedColor(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().toLowerCase();
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let c = null;
  const m = t.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (m) c = { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  const h = t.match(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![0-9a-f])/);
  if (!c && h) {
    let x = h[1];
    if (x.length <= 4) x = [...x].map((ch) => ch + ch).join('');
    c = { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
  }
  if (!c) return null;
  const op = t.match(/\/op([\d.]+)/);
  if (op) c.a *= +op[1];
  return c;
}
const errors = [];
function validate(n, path) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) { errors.push(`${path}: a node must be an object`); return; }
  for (const k of Object.keys(n)) if (!KEYS.has(k)) errors.push(`${path}: unknown field "${k}" (allowed: ${[...KEYS].join(', ')})`);
  if (typeof n.sel !== 'string' || !n.sel.trim()) errors.push(`${path}: "sel" (a CSS selector) is required`);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  for (const k of ['gap', 'w', 'h', 'borderWidth', 'fontSize']) if (n[k] != null && !isNum(n[k])) errors.push(`${path}: "${k}" must be a number of px >= 0 (no "px", no token)`);
  if (n.nth != null && !(Number.isInteger(n.nth) && n.nth >= 0)) errors.push(`${path}: "nth" must be an integer >= 0`);
  if (n.dir != null && n.dir !== 'row' && n.dir !== 'col') errors.push(`${path}: "dir" must be "row" or "col"`);
  if (n.pad != null) {
    const p = typeof n.pad === 'number' ? [n.pad] : n.pad;
    if (!Array.isArray(p) || ![1, 2, 4].includes(p.length) || !p.every((v) => v === null || isNum(v))) errors.push(`${path}: "pad" must be N, [vertical, horizontal] or [top, right, bottom, left] (null = do not check that side)`);
  }
  if (n.radius != null) {
    const r = typeof n.radius === 'number' ? [n.radius] : n.radius;
    if (!Array.isArray(r) || ![1, 4].includes(r.length) || !r.every(isNum)) errors.push(`${path}: "radius" must be N or [tl, tr, br, bl]`);
  }
  for (const k of ['bg', 'color', 'borderColor']) if (n[k] != null && !parseExpectedColor(n[k])) errors.push(`${path}: "${k}" must be a colour like "#1c1b1f", "#1c1b1f80" or "transparent", got ${JSON.stringify(n[k])}`);
  if (n.fontWeight != null && !/^\d{3}$/.test(String(n.fontWeight))) errors.push(`${path}: "fontWeight" must be 100..900 (Regular 400, Medium 500, SemiBold 600, Bold 700)`);
  for (const k of ['text', 'fontFamily', 'name', 'id', 'note']) if (n[k] != null && typeof n[k] !== 'string') errors.push(`${path}: "${k}" must be a string`);
  if (n.strict != null && typeof n.strict !== 'boolean') errors.push(`${path}: "strict" must be true or false`);
  if (n.children != null) {
    if (!Array.isArray(n.children)) errors.push(`${path}: "children" must be an array`);
    else n.children.forEach((c, i) => validate(c, `${path}.children[${i}]`));
  }
}
let tree = null;
if (mode === 'compare') {
  let raw;
  try { raw = readFileSync(pos[1], 'utf8'); } catch (e) { usage(`cannot read ${pos[1]}: ${e.message}`); }
  try { tree = JSON.parse(raw); } catch (e) { usage(`${pos[1]} is not valid JSON: ${e.message}`); }
  if (!Array.isArray(tree)) tree = [tree];
  if (!tree.length) usage(`${pos[1]} has no nodes`);
  tree.forEach((n, i) => validate(n, `node[${i}]`));
  if (errors.length) usage(`${pos[1]} is invalid:\n  ${errors.slice(0, 15).join('\n  ')}`);
}

// ---------- playwright ----------
function loadPlaywright() {
  const bases = [process.cwd() + '/', new URL('.', import.meta.url).pathname];
  for (const p of (process.env.NODE_PATH || '').split(delimiter).filter(Boolean)) bases.push(join(p, 'x'));
  try { bases.push(join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'x')); } catch { /* no npm */ }
  for (const b of bases) { try { return createRequire(b)('playwright'); } catch { /* next */ } }
  fatal('playwright not found. Install it in the project: npm i -D playwright && npx playwright install chromium (or run from a folder where it is installed)');
}

// ---------- helpers that run inside the page (serialised as source) ----------
function toRGBA(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  m = t.match(/^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  const k = (v) => Math.max(0, Math.min(255, v * 255)); // out-of-gamut values (e.g. oklch) are clipped to sRGB like the screen does
  if (m) return { r: k(+m[1]), g: k(+m[2]), b: k(+m[3]), a: m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
  // anything else (oklch, lab, hsl, color-mix leftovers): let the browser convert it to sRGB without losing alpha or precision
  if (globalThis.__cmpProbe === undefined) { const p = document.createElement('i'); p.style.display = 'none'; document.documentElement.appendChild(p); globalThis.__cmpProbe = p; }
  const probe = globalThis.__cmpProbe;
  probe.style.color = '';
  probe.style.color = `color-mix(in srgb, ${t} 100%, transparent)`;
  if (!probe.style.color) return null; // not a colour
  const out = getComputedStyle(probe).color;
  return out === t ? null : toRGBA(out);
}
function hexOf(c) {
  if (!c) return 'none';
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b) + (c.a < 0.999 ? h(c.a * 255) : '');
}
function over(top, base) { // composite colour `top` over opaque `base`
  const a = top.a;
  return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 };
}
function effectiveBg(el) { // colour behind el's own paint = ancestors composited over white
  const stack = [];
  for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
    const c = toRGBA(getComputedStyle(p).backgroundColor);
    if (c && c.a > 0) { stack.push({ c, el: p }); if (c.a >= 0.999) break; }
  }
  let base = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i].c, base);
  return { color: base, from: stack.length ? stack[0].el : null };
}
function descOf(el) {
  if (!el || el.nodeType !== 1) return '?';
  let s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  const cls = [...el.classList];
  s += cls.slice(0, 3).map((c) => '.' + c).join('') + (cls.length > 3 ? '…' : '');
  const tid = el.getAttribute('data-testid');
  if (tid) s += `[data-testid="${tid}"]`;
  return s;
}
function chainOf(el, n) { const out = []; for (let p = el.parentElement; p && out.length < n && p !== document.documentElement; p = p.parentElement) out.unshift(descOf(p)); return out.join(' > '); }
function isVisible(el) {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  if (cs.display === 'none') return 'display:none';
  if (cs.visibility === 'hidden') return 'visibility:hidden';
  if (r.width <= 0 || r.height <= 0) return `size ${Math.round(r.width)}×${Math.round(r.height)}`;
  if (+cs.opacity === 0) return 'opacity:0';
  return '';
}
function strokeOf(el) {
  const cs = getComputedStyle(el);
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    const w = parseFloat(cs[`border${side}Width`]) || 0;
    if (w > 0 && cs[`border${side}Style`] !== 'none' && cs[`border${side}Style`] !== 'hidden') return { src: 'border', color: toRGBA(cs[`border${side}Color`]), width: w };
  }
  const ow = parseFloat(cs.outlineWidth) || 0;
  if (ow > 0 && cs.outlineStyle !== 'none') return { src: 'outline', color: toRGBA(cs.outlineColor), width: ow };
  const m = cs.boxShadow && cs.boxShadow.match(/(rgba?\([^)]*\)|color\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/);
  if (m && +m[2] === 0 && +m[3] === 0 && +m[4] === 0 && +m[5] > 0) return { src: 'box-shadow', color: toRGBA(m[1]), width: +m[5] };
  return null;
}
function bordersOf(el) {
  const cs = getComputedStyle(el);
  return ['Top', 'Right', 'Bottom', 'Left'].map((s) => (cs[`border${s}Style`] === 'none' ? 0 : parseFloat(cs[`border${s}Width`]) || 0));
}
function radiusOf(el) {
  const cs = getComputedStyle(el), r = el.getBoundingClientRect();
  return ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => {
    const v = cs[`border${k}Radius`].split(' ')[0];
    return v.endsWith('%') ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : parseFloat(v) || 0;
  });
}
function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
// box of the content of el (visible child elements and own text lines; text lines use the line-height box)
function contentOf(el) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (r) => { if (r.width <= 0 && r.height <= 0) return; x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); };
  for (const c of el.childNodes) {
    if (c.nodeType === 1) {
      const v = isVisible(c);
      if (!v) add(c.getBoundingClientRect());
      else if (v.startsWith('size')) { const r = contentOf(c); if (r) add({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h }); } // display:contents / empty inline host
    }
    else if (c.nodeType === 3 && c.textContent.trim()) {
      const range = document.createRange(); range.selectNodeContents(c);
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      for (const r of range.getClientRects()) {
        if (Number.isFinite(lh) && lh > r.height) { const mid = (r.top + r.bottom) / 2; add({ left: r.left, right: r.right, top: mid - lh / 2, bottom: mid + lh / 2, width: r.width, height: lh }); }
        else add(r);
      }
    }
  }
  if (x1 === Infinity) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function overflows(el) { // true when el clips/scrolls and its content is larger than its inner box
  const cs = getComputedStyle(el);
  if (cs.overflowX === 'visible' && cs.overflowY === 'visible') return false;
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}
function padOf(el, content) { // measured space between the inner border edge and the content box: [t, r, b, l]
  if (!content) return null;
  const r = el.getBoundingClientRect(), b = bordersOf(el);
  return [content.y - (r.top + b[0]), (r.right - b[1]) - (content.x + content.w), (r.bottom - b[2]) - (content.y + content.h), content.x - (r.left + b[3])];
}
// layout of items [{x,y,w,h}] in visual order: {dir: row|col|row-wrap|mixed, order: [index], gaps: [px]}
// prefer = CSS flex direction of the parent ('row'|'col'|null): decides when children are separated on both axes (staircase)
function layoutOf(items, tol, prefer) {
  if (items.length < 2) return null;
  const idx = items.map((r, i) => ({ ...r, i }));
  const pairs = (a) => a.slice(1).map((b, k) => [a[k], b]);
  const byX = [...idx].sort((a, b) => a.x - b.x || a.y - b.y);
  const byY = [...idx].sort((a, b) => a.y - b.y || a.x - b.x);
  const rowSep = pairs(byX).every(([a, b]) => b.x >= a.x + a.w - tol);
  const colSep = pairs(byY).every(([a, b]) => b.y >= a.y + a.h - tol);
  const rowLap = pairs(byX).every(([a, b]) => b.y < a.y + a.h && a.y < b.y + b.h); // same line: boxes overlap vertically
  const colLap = pairs(byY).every(([a, b]) => b.x < a.x + a.w && a.x < b.x + b.w);
  const row = { dir: 'row', order: byX.map((r) => r.i), gaps: pairs(byX).map(([a, b]) => b.x - (a.x + a.w)) };
  const col = { dir: 'col', order: byY.map((r) => r.i), gaps: pairs(byY).map(([a, b]) => b.y - (a.y + a.h)) };
  if (rowSep && rowLap) return row;
  if (colSep && colLap) return col;
  if (rowSep && colSep) {
    if (prefer === 'row' || prefer === 'col') return prefer === 'row' ? row : col;
    const sum = (g) => g.reduce((a, v) => a + Math.abs(v), 0);
    return sum(row.gaps) < sum(col.gaps) ? row : col;
  }
  if (rowSep) return row;
  if (colSep) return col;
  const lines = [];
  for (const r of byY) { const l = lines[lines.length - 1]; if (l && r.y < l.bottom - tol) { l.items.push(r); l.bottom = Math.max(l.bottom, r.y + r.h); } else lines.push({ items: [r], bottom: r.y + r.h }); }
  if (lines.length > 1 && lines.every((l) => { l.items.sort((a, b) => a.x - b.x); return pairs(l.items).every(([a, b]) => b.x >= a.x + a.w - tol); })) {
    return { dir: 'row-wrap', order: lines.flatMap((l) => l.items.map((r) => r.i)), gaps: lines.flatMap((l) => pairs(l.items).map(([a, b]) => b.x - (a.x + a.w))) };
  }
  return { dir: 'mixed', order: byY.map((r) => r.i), gaps: [] };
}
function cssDir(el) {
  const cs = getComputedStyle(el);
  if (cs.display.includes('flex')) return cs.flexDirection.startsWith('column') ? 'col' : 'row';
  if (cs.display.includes('grid')) return 'grid';
  return null;
}
function hasVisibleContent(el) {
  if (isVisible(el)) return false;
  if (el.textContent.trim()) return true;
  if (el.matches('img,svg,canvas,video,input,select,textarea,button,iframe') || el.querySelector('img,svg,canvas,video,input,select,textarea,button,iframe')) return true;
  const c = toRGBA(getComputedStyle(el).backgroundColor);
  return (c && c.a > 0) || !!strokeOf(el) || getComputedStyle(el).backgroundImage !== 'none';
}
const PAGE_HELPERS = [toRGBA, hexOf, over, effectiveBg, descOf, chainOf, isVisible, strokeOf, bordersOf, radiusOf, rectOf, contentOf, overflows, padOf, layoutOf, cssDir, hasVisibleContent].map(String).join('\n');

// measures every expect node inside the page
function measureTree({ tree }) {
  const visit = (n, parentEl, used) => {
    const out = { where: 'inside' };
    let list;
    try {
      list = [...(parentEl || document).querySelectorAll(n.sel)];
      if (!list.length && parentEl) { list = [...document.querySelectorAll(n.sel)]; out.where = 'outside'; }
    } catch (e) { return { where: 'error', error: String(e.message || e).slice(0, 120) }; }
    out.count = list.length;
    const el = n.nth != null ? list[n.nth] : list.find((e) => !used.has(e));
    if (!el) return { where: 'missing', count: list.length };
    used.add(el);
    out.el = el;
    out.desc = descOf(el);
    if (out.where === 'outside') out.chain = chainOf(el, 3);
    out.hidden = isVisible(el);
    const cs = getComputedStyle(el);
    out.rect = rectOf(el);
    if (out.hidden.startsWith('size') && /contents|inline/.test(cs.display)) { // host element without own box (display:contents / inline): use its content box
      const c = contentOf(el);
      if (c) { out.rect = c; out.hidden = ''; out.desc += ` (no own box: display ${cs.display}, measured from its content)`; }
    }
    out.bg = toRGBA(cs.backgroundColor);
    out.bgImage = cs.backgroundImage !== 'none';
    const eb = effectiveBg(el.parentElement || el);
    out.behind = eb.color; out.behindFrom = eb.from ? descOf(eb.from) : 'page (white)';
    out.color = toRGBA(cs.color);
    out.stroke = strokeOf(el);
    out.radius = radiusOf(el);
    out.fontSize = parseFloat(cs.fontSize);
    out.fontWeight = cs.fontWeight;
    out.fontFamily = cs.fontFamily;
    out.text = el.textContent.replace(/\s+/g, ' ').trim();
    out.boxSizing = cs.boxSizing;
    out.padCss = ['Top', 'Right', 'Bottom', 'Left'].map((k) => parseFloat(cs['padding' + k]) || 0);
    out.cssDir = cssDir(el);
    const used2 = new Set();
    out.children = (n.children || []).map((c) => visit(c, el, used2));
    // nesting between expected siblings, slots, extra visible children
    const found = out.children.filter((c) => c && c.el && c.where === 'inside');
    for (const c of found) { const host = found.find((o) => o !== c && o.el.contains(c.el)); if (host) c.insideSibling = host.el; }
    if (n.children && n.children.length) {
      const slots = new Set(found.map((c) => { let s = c.el; while (s.parentElement && s.parentElement !== el) s = s.parentElement; return s; }));
      out.extras = [...el.children].filter((k) => !slots.has(k) && !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META'].includes(k.tagName) && hasVisibleContent(k))
        .map((k) => descOf(k) + (k.textContent.trim() ? ` "${k.textContent.replace(/\s+/g, ' ').trim().slice(0, 30)}"` : ''));
    }
    out.overflow = overflows(el); // scrolling/clipped content: padding cannot be measured from boxes
    out.pad = out.overflow ? null : padOf(el, contentOf(el)); // all visible content counts, also content not listed in expect.json
    return out;
  };
  const strip = (m) => { if (!m) return m; delete m.el; delete m.insideSibling; (m.children || []).forEach(strip); return m; };
  const res = tree.map((n) => visit(n, null, new Set()));
  // mark nesting before the element references are removed
  const mark = (m) => { if (!m || !m.children) return; for (const c of m.children) { if (c && c.insideSibling) c.insideOf = m.children.findIndex((o) => o && o.el === c.insideSibling); mark(c); } };
  res.forEach(mark);
  return res.map(strip);
}

// prints the page structure in design-query spec notation
function dumpTree({ sel, depth, maxChars, tol }) {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return { error: `no element matches ${sel}` };
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD'];
  const LEAF = ['SVG', 'IMG', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'IFRAME'];
  const kids = (el) => {
    const out = [];
    for (const c of el.children) {
      if (SKIP.includes(c.tagName)) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      const r = c.getBoundingClientRect();
      if (cs.display === 'contents' || r.width <= 0 || r.height <= 0) { out.push(...kids(c)); continue; }
      if (cs.visibility === 'hidden') continue;
      out.push(c);
    }
    return out;
  };
  const ownText = (el) => [...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const paints = (el) => { const cs = getComputedStyle(el); const c = toRGBA(cs.backgroundColor); return (c && c.a > 0) || cs.backgroundImage !== 'none' || !!strokeOf(el) || cs.boxShadow !== 'none' || +cs.opacity < 1; };
  const same = (a, b) => { const r = a.getBoundingClientRect(), s = b.getBoundingClientRect(); return Math.abs(r.left - s.left) <= 0.5 && Math.abs(r.top - s.top) <= 0.5 && Math.abs(r.width - s.width) <= 0.5 && Math.abs(r.height - s.height) <= 0.5; };
  const collapse = (el) => { for (;;) { const k = kids(el); if (k.length === 1 && !ownText(el) && !paints(el) && !LEAF.includes(el.tagName.toUpperCase()) && same(el, k[0])) el = k[0]; else return el; } };
  const selOf = (el) => {
    const parts = [];
    for (let p = el; p && p !== document.body && p.nodeType === 1; p = p.parentElement) {
      if (p.id) { parts.unshift('#' + CSS.escape(p.id)); break; }
      const i = [...p.parentElement.children].indexOf(p) + 1;
      parts.unshift(p.tagName.toLowerCase() + (p.classList[0] ? '.' + CSS.escape(p.classList[0]) : '') + `:nth-child(${i})`);
    }
    return parts.join(' > ') || 'body';
  };
  const n1 = (v) => String(Math.round(v * 10) / 10);
  const sides = (p) => { const s = p.map((v) => n1(Math.max(0, v))); return s.every((v) => v === s[0]) ? s[0] : s[0] === s[2] && s[1] === s[3] ? `${s[0]},${s[1]}` : s.join(','); };
  const line = (el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), tag = el.tagName.toUpperCase();
    const parts = [descOf(el)];
    let text = ownText(el);
    if (tag === 'INPUT' || tag === 'TEXTAREA') text = el.value || (el.placeholder ? `placeholder: ${el.placeholder}` : '');
    if (tag === 'IMG') text = el.alt ? `alt: ${el.alt}` : (el.getAttribute('src') || '').split('/').pop().slice(0, 40);
    if (text) parts.push(JSON.stringify(text.length > 40 ? text.slice(0, 39) + '…' : text));
    parts.push(`${n1(r.width)}×${n1(r.height)}`);
    const k = LEAF.includes(tag) ? [] : kids(el);
    const lay = layoutOf(k.map((c) => { const q = c.getBoundingClientRect(); return { x: q.left, y: q.top, w: q.width, h: q.height }; }), tol, cssDir(el));
    if (cs.display.includes('grid')) parts.push('grid');
    else if (lay) parts.push(lay.dir);
    else if (k.length === 1 && cssDir(el)) parts.push(cssDir(el));
    if (lay && lay.gaps.length) { const g = lay.gaps.map(n1); parts.push('gap=' + (g.every((v) => Math.abs(+v - +g[0]) <= 0.5) ? g[0] : g.slice(0, 4).join(',') + (g.length > 4 ? ',…' : ''))); }
    if (!LEAF.includes(tag) && overflows(el)) {
      const css = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs['padding' + s]) || 0);
      parts.push('scroll' + (css.some((v) => v > 0.5) ? ' pad(css)=' + sides(css) : ''));
    } else if (!LEAF.includes(tag)) {
      const p = padOf(el, contentOf(el));
      if (p) { // right/bottom: free space beyond the CSS padding (box larger than content) is not padding
        const css = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs['padding' + s]) || 0);
        for (const i of [1, 2]) if (p[i] > css[i] + 0.5) p[i] = css[i];
        if (p.some((v) => v > 0.5)) parts.push('pad=' + sides(p));
      }
    }
    const bg = toRGBA(cs.backgroundColor);
    if (bg && bg.a > 0) parts.push('fill=' + hexOf(bg));
    if (cs.backgroundImage !== 'none') parts.push('bg-image');
    if (text && !['IMG'].includes(tag)) parts.push('color=' + hexOf(toRGBA(cs.color)));
    const st = strokeOf(el);
    if (st) parts.push(`stroke=${hexOf(st.color)}/${n1(st.width)}${st.src === 'border' ? '' : '/' + st.src}`);
    const rad = radiusOf(el).map(n1);
    if (rad.some((v) => v !== '0')) parts.push('r=' + (rad.every((v) => v === rad[0]) ? rad[0] : rad.join(',')));
    if (text && tag !== 'IMG') {
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const lh = cs.lineHeight === 'normal' ? 'lh-normal' : 'lh' + n1(parseFloat(cs.lineHeight)) + 'px';
      parts.push(`font=${fam}/${n1(parseFloat(cs.fontSize))}/w${cs.fontWeight}/${lh}`);
    }
    if (+cs.opacity < 1) parts.push('op=' + cs.opacity);
    if (cs.boxShadow !== 'none' && !(st && st.src === 'box-shadow')) parts.push('fx=shadow');
    return { text: parts.join(' '), kids: k };
  };
  const lines = [];
  let size = 0, cut = null;
  const walk = (el, d) => {
    if (cut) return;
    if (d > 0) el = collapse(el);
    const { text, kids: k } = line(el);
    const s = '  '.repeat(d) + text;
    if (size + s.length > maxChars) { cut = selOf(el); return; }
    lines.push(s); size += s.length + 1;
    if (!k.length) return;
    if (d + 1 > depth) { lines.push('  '.repeat(d + 1) + `… ${k.length} children (--dump "${selOf(el)}")`); return; }
    for (const c of k) walk(c, d + 1);
  };
  walk(root, 0);
  return { lines, cut };
}

// ---------- run the browser ----------
const { chromium } = loadPlaywright();
try { browser = await chromium.launch(); } catch (e) { fatal(`cannot start chromium: ${String(e.message).split('\n')[0]} (run: npx playwright install chromium)`); }
let exitCode = 2;
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
  try { await page.goto(url, { waitUntil: 'load', timeout: 30000 }); } catch (e) { fatal(`cannot open ${url}: ${String(e.message).split('\n')[0]} (is the app running? see the run-test-instance skill)`); }
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const waitSels = mode === 'compare' ? tree.map((n) => n.sel) : modeArg ? [modeArg] : [];
  for (const s of waitSels) await page.waitForSelector(s, { state: 'attached', timeout: 10000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(opt.wait);
  const inPage = (fn, arg) => page.evaluate(`(() => { ${PAGE_HELPERS}\n return (${fn})(${JSON.stringify(arg)}); })()`);
  if (modeArg) { // invalid selector -> ERROR line and exit 2 (as for expect.json problems)
    const bad = await page.evaluate((s) => { try { document.querySelector(s); return ''; } catch (e) { return String(e.message || e); } }, modeArg);
    if (bad) fatal(`invalid CSS selector "${modeArg}": ${bad.split('\n')[0]}`);
  }

  if (mode === 'shot') {
    if (modeArg) {
      const loc = page.locator(modeArg).first();
      if (!(await loc.count())) { console.log(`FAIL no element matches ${modeArg}`); exitCode = 1; }
      else { const b = await loc.boundingBox(); await loc.screenshot({ path: shotFile }); console.log(`wrote ${shotFile} (${Math.round(b.width)}×${Math.round(b.height)} px of ${modeArg}, viewport ${opt.viewport}, deviceScaleFactor 1)`); exitCode = 0; }
    } else { await page.screenshot({ path: shotFile, fullPage: true }); console.log(`wrote ${shotFile} (full page, viewport ${opt.viewport}, deviceScaleFactor 1)`); exitCode = 0; }
  } else if (mode === 'dump') {
    const r = await inPage(dumpTree, { sel: modeArg, depth: opt.depth, maxChars: opt.maxTokens * 4, tol: opt.tolerance });
    if (r.error) { console.log(`FAIL ${r.error}`); exitCode = 1; }
    else {
      console.log(`# ${url} ${modeArg || 'body'}  viewport ${opt.viewport}  (measured from the rendered page; gap/pad from element boxes; free space at the right/bottom is not counted as pad; wrappers with no paint and the same box as their only child are skipped)`);
      console.log(r.lines.join('\n'));
      if (r.cut) console.log(`→ output cut to ~${opt.maxTokens} tokens: node compare.mjs ${url} --dump "${r.cut}"`);
      exitCode = 0;
    }
  } else {
    const measured = await inPage(measureTree, { tree });
    exitCode = report(tree, measured);
  }
} catch (e) {
  if (!(e instanceof Fatal)) throw e;
  console.error(`ERROR ${e.message}`); exitCode = 2;
} finally { await browser.close(); }
process.exit(exitCode);

// ---------- checks and report (node side) ----------
function report(nodes, measured) {
  const TOL = opt.tolerance, CTOL = opt.colorTolerance, ATOL = Math.max(CTOL, 3); // alpha tolerance in 0-255 steps
  const checks = [];
  const f = (v) => (typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v));
  const add = (status, cat, path, prop, expected, got, hint) => checks.push({ status, cat, path, prop, expected: f(expected), measured: f(got), hint: hint || '' });
  const rows = (vals) => { const s = vals.map(f); return s.every((v) => v === s[0]) ? (s.length > 1 ? `${s[0]} (x${s.length})` : s[0]) : s.join(','); };
  const countNodes = (n) => 1 + (n.children || []).reduce((a, c) => a + countNodes(c), 0);

  const colorCheck = (cat, path, prop, exp, got, behind, extraHint) => {
    const e = parseExpectedColor(exp);
    if (!got) return add('FAIL', cat, path, prop, hexOf(e), 'none', extraHint);
    const d = Math.max(Math.abs(e.r - got.r), Math.abs(e.g - got.g), Math.abs(e.b - got.b));
    const da = Math.abs(e.a - got.a) * 255;
    const ignoreRgb = e.a === 0 && got.a === 0;
    if (ignoreRgb || (d <= CTOL && da <= ATOL)) return add('PASS', cat, path, prop, hexOf(e), hexOf(got));
    if ((e.a < 1 || got.a < 1) && behind) {
      const ve = over(e, behind), vg = over(got, behind);
      if (Math.max(Math.abs(ve.r - vg.r), Math.abs(ve.g - vg.g), Math.abs(ve.b - vg.b)) <= CTOL) return add('WARN', cat, path, prop, hexOf(e), hexOf(got), da > ATOL ? `same visible colour ${hexOf(vg)} over ${hexOf(behind)}, but different alpha (design uses transparency; app may use a pre-mixed colour)` : `same visible colour ${hexOf(vg)} over ${hexOf(behind)}; colour channels differ but are barely visible at this transparency`);
    }
    add('FAIL', cat, path, prop, hexOf(e), hexOf(got), extraHint);
  };

  const check = (n, m, path, depth) => {
    const name = n.name || n.sel;
    const p = path ? `${path} > ${name}` : name;
    const kidsCount = (n.children || []).reduce((a, c) => a + countNodes(c), 0);
    if (m.where === 'error') { add('FAIL', 'hierarchy', p, 'exists', 'valid selector', 'INVALID SELECTOR', m.error); return; }
    if (m.where === 'missing') {
      add('FAIL', 'hierarchy', p, 'exists', 'present', 'NOT FOUND', m.count ? `only ${m.count} match(es) for "${n.sel}"${n.nth != null ? `, nth=${n.nth} is too high` : ', all used by earlier siblings'}` : `no element matches "${n.sel}"${path ? ' anywhere on the page' : ''}; find the right selector with --dump`);
      if (kidsCount) add('SKIP', 'hierarchy', p, 'children', `${kidsCount} nested node(s)`, 'not checked', 'parent not found');
      return;
    }
    if (m.where === 'outside') add('FAIL', 'hierarchy', p, 'parent', `inside ${path}`, `inside ${m.chain}`, 'element exists but not inside its design parent');
    else add('PASS', 'hierarchy', p, 'exists', 'present', m.desc + (depth === 0 && m.count > 1 && n.nth == null ? ` (first of ${m.count})` : ''));
    if (m.hidden) { add('FAIL', 'hierarchy', p, 'visible', 'visible', m.hidden, 'element is in the DOM but not visible'); if (kidsCount) add('SKIP', 'hierarchy', p, 'children', `${kidsCount} nested node(s)`, 'not checked', 'parent not visible'); return; }

    // spacing: size
    for (const [k, v] of [['w', m.rect.w], ['h', m.rect.h]]) if (n[k] != null) {
      const ok = Math.abs(v - n[k]) <= TOL;
      const b = m.stroke && m.stroke.src === 'border' ? m.stroke.width : 0, pd = k === 'w' ? m.padCss[1] + m.padCss[3] : m.padCss[0] + m.padCss[2];
      const hint = ok ? '' : m.boxSizing === 'content-box' && (b || pd) ? `box-sizing is content-box: padding (${f(pd)}) and border (${f(2 * b)}) are added to the CSS ${k === 'w' ? 'width' : 'height'}; use box-sizing:border-box` : b ? `has a ${f(b)}px border; a design stroke should not change the size (outline instead of border)` : '';
      add(ok ? 'PASS' : 'FAIL', 'spacing', p, k, n[k], v, hint);
    }
    // colors
    if (n.bg != null) {
      const e = parseExpectedColor(n.bg);
      if (m.bg && m.bg.a === 0 && e.a > 0) add('FAIL', 'color', p, 'bg', hexOf(e), 'transparent', `own background is transparent; behind it is ${hexOf(m.behind)} from ${m.behindFrom}${m.bgImage ? '; it has a background-image (not compared)' : ''}`);
      else colorCheck('color', p, 'bg', n.bg, m.bg, m.behind, m.bgImage ? 'it has a background-image (gradient/image, not compared)' : '');
    }
    if (n.color != null) colorCheck('color', p, 'color', n.color, m.color, m.bg && m.bg.a > 0 ? over(m.bg, m.behind) : m.behind);
    if (n.borderColor != null) {
      if (!m.stroke) add('FAIL', 'color', p, 'borderColor', hexOf(parseExpectedColor(n.borderColor)), 'none', 'no border, outline or 0-blur box-shadow found');
      else colorCheck('color', p, `borderColor (${m.stroke.src})`, n.borderColor, m.stroke.color, m.behind);
    }
    if (n.borderWidth != null) {
      const w = m.stroke ? m.stroke.width : 0;
      add(Math.abs(w - n.borderWidth) <= 0.5 ? 'PASS' : 'FAIL', 'color', p, `borderWidth${m.stroke ? ` (${m.stroke.src})` : ''}`, n.borderWidth, w);
    }
    if (n.radius != null) {
      const e = typeof n.radius === 'number' ? [n.radius, n.radius, n.radius, n.radius] : n.radius;
      const full = Math.min(m.rect.w, m.rect.h) / 2;
      const ok = e.every((v, i) => Math.abs(v - m.radius[i]) <= TOL || (v >= full - TOL && m.radius[i] >= full - TOL));
      add(ok ? 'PASS' : 'FAIL', 'color', p, 'radius', rows(e), rows(m.radius));
    }
    // text
    if (n.fontSize != null) { const ok = Math.abs(m.fontSize - n.fontSize) <= 0.5; add(ok ? 'PASS' : 'FAIL', 'text', p, 'fontSize', n.fontSize, m.fontSize); }
    if (n.fontWeight != null) add(String(n.fontWeight) === String(m.fontWeight) ? 'PASS' : 'FAIL', 'text', p, 'fontWeight', n.fontWeight, m.fontWeight);
    if (n.fontFamily != null) add(m.fontFamily.toLowerCase().includes(n.fontFamily.toLowerCase()) ? 'PASS' : 'FAIL', 'text', p, 'fontFamily', n.fontFamily, m.fontFamily.slice(0, 40), 'CSS font-family list; the browser may still fall back if the font file is not loaded');
    if (n.text != null) {
      const e = n.text.replace(/\s+/g, ' ').trim();
      const short = (s) => JSON.stringify(s.length > 50 ? s.slice(0, 49) + '…' : s);
      if (m.text === e) add('PASS', 'text', p, 'text', short(e), short(m.text));
      else add('FAIL', 'text', p, 'text', short(e), short(m.text), m.text.toLowerCase() === e.toLowerCase() ? 'differs only in case (design text is in source case; CSS text-transform does not count)' : m.text.includes(e) ? 'element contains more text: select the inner text element' : '');
    }

    // children: hierarchy + spacing
    const kids = n.children || [];
    if (kids.length) {
      kids.forEach((c, i) => { const cm = m.children[i]; if (cm && cm.insideOf != null && cm.insideOf >= 0) add('FAIL', 'hierarchy', `${p} > ${c.name || c.sel}`, 'nesting', `sibling of ${kids[cm.insideOf].name || kids[cm.insideOf].sel}`, `inside ${kids[cm.insideOf].name || kids[cm.insideOf].sel}`, 'a wrapper or wrong template nesting'); });
      for (const x of (m.extras || []).slice(0, 5)) add(n.strict ? 'FAIL' : 'WARN', 'hierarchy', p, 'extra child', 'not in design', x, n.strict ? 'strict: remove it or add it to the design/expect.json' : 'visible element that is not in expect.json; add it if the design has it, else ask');
      if ((m.extras || []).length > 5) add(n.strict ? 'FAIL' : 'WARN', 'hierarchy', p, 'extra child', 'not in design', `${m.extras.length - 5} more`, '');
      const usable = kids.map((c, i) => ({ c, m: m.children[i], i })).filter((o) => o.m && o.m.where === 'inside' && !o.m.hidden && !(o.m.insideOf >= 0));
      const lay = layoutOf(usable.map((o) => o.m.rect), TOL, m.cssDir);
      const missing = kids.length - usable.length;
      const note = missing ? `${missing} child(ren) missing/misplaced, measured without them` : '';
      let dirOk = true;
      if (n.dir != null) {
        if (!lay) {
          if (m.cssDir === 'row' || m.cssDir === 'col') { dirOk = m.cssDir === n.dir; add(dirOk ? 'PASS' : 'FAIL', 'hierarchy', p, 'dir', n.dir, m.cssDir, 'only one visible child: taken from CSS flex-direction'); }
          else add('SKIP', 'hierarchy', p, 'dir', n.dir, 'unknown', 'needs 2 visible children or a flex container');
        } else if (lay.dir === 'mixed') { dirOk = false; add('FAIL', 'hierarchy', p, 'dir', n.dir, 'mixed', 'children overlap or form a grid (absolute positions, wrong nesting)'); }
        else { const d = lay.dir === 'row-wrap' ? 'row' : lay.dir; dirOk = d === n.dir; add(dirOk ? 'PASS' : 'FAIL', 'hierarchy', p, 'dir', n.dir, lay.dir + (m.cssDir && m.cssDir !== d ? ` (CSS: ${m.cssDir})` : ''), dirOk ? (lay.dir === 'row-wrap' ? 'children wrap onto several lines' : '') : 'children are laid out in the other direction (flex-direction, display:block, or a wrapper)'); }
      }
      if (lay && lay.dir !== 'mixed') {
        const exp = usable.map((o) => o.c.name || o.c.sel), got = lay.order.map((k) => exp[k]);
        const ok = exp.every((v, k) => v === got[k]);
        add(ok ? 'PASS' : 'FAIL', 'hierarchy', p, 'order', exp.join(', '), got.join(', '), ok ? note : `visual order along ${lay.dir} differs (DOM order, CSS order, row-reverse)`);
      } else if (lay) add('SKIP', 'hierarchy', p, 'order', 'design order', 'unknown', 'children overlap or form a grid');
      if (n.gap != null) {
        if (!lay) add('SKIP', 'spacing', p, 'gap', n.gap, 'unknown', 'needs 2 visible children');
        else if (!dirOk || lay.dir === 'mixed') add('SKIP', 'spacing', p, 'gap', n.gap, 'unknown', 'direction is wrong: fix dir first');
        else { const ok = lay.gaps.every((g) => Math.abs(g - n.gap) <= TOL); add(ok ? 'PASS' : 'FAIL', 'spacing', p, 'gap', n.gap, rows(lay.gaps), ok ? note : 'distance between the boxes of consecutive children (gap, margins and child padding all add up here)' + (note ? '; ' + note : '')); }
      }
    }
    if (n.pad != null) {
      const ps = typeof n.pad === 'number' ? [n.pad, n.pad, n.pad, n.pad] : n.pad.length === 2 ? [n.pad[0], n.pad[1], n.pad[0], n.pad[1]] : n.pad;
      if (!m.pad) add('SKIP', 'spacing', p, 'pad', ps.map((v) => (v == null ? '-' : f(v))).join(','), 'unknown', m.overflow ? 'content overflows/scrolls: padding cannot be measured; check the CSS padding by hand' : 'no visible content inside to measure from');
      else {
        let st = 'PASS'; const bad = [];
        const SIDE = ['top', 'right', 'bottom', 'left'];
        ps.forEach((v, i) => {
          if (v == null) return;
          const d = m.pad[i] - v;
          if (Math.abs(d) <= TOL) return;
          if ((i === 1 || i === 2) && d > 0) { if (st === 'PASS') st = 'WARN'; bad.push(`${SIDE[i]} has ${f(d)}px more (box larger than content: fixed/fill size or alignment; check w/h)`); }
          else { st = 'FAIL'; bad.push(`${SIDE[i]} ${d > 0 ? 'too big' : 'too small'} by ${f(Math.abs(d))}`); }
        });
        add(st, 'spacing', p, 'pad (t,r,b,l)', ps.map((v) => (v == null ? '-' : f(v))).join(','), m.pad.map(f).join(','), bad.join('; ') + (st !== 'PASS' && m.stroke && m.stroke.src === 'border' ? '; borders are already subtracted' : ''));
      }
    }
    kids.forEach((c, i) => { if (m.children[i]) check(c, m.children[i], p, depth + 1); });
  };
  nodes.forEach((n, i) => check(n, measured[i], '', 0));

  if (opt.json) { console.log(JSON.stringify({ url, viewport: opt.viewport, tolerance: TOL, colorTolerance: CTOL, checks }, null, 1)); return checks.some((c) => c.status === 'FAIL') ? 1 : 0; }

  const cats = ['hierarchy', 'spacing', 'color', 'text'];
  const cnt = (st, cat) => checks.filter((c) => c.status === st && (!cat || c.cat === cat)).length;
  console.log(`compare.mjs ${url}  viewport ${opt.viewport}  tolerance ${TOL}px  color-tolerance ${CTOL}`);
  console.log('SUMMARY  ' + cats.map((c) => `${c}: ${cnt('PASS', c)} PASS ${cnt('FAIL', c)} FAIL ${cnt('WARN', c)} WARN ${cnt('SKIP', c)} SKIP`).join(' | '));
  const order = ['FAIL', 'WARN', 'SKIP', 'PASS'];
  const sorted = order.flatMap((s) => checks.filter((c) => c.status === s));
  const shown = sorted.slice(0, opt.maxLines);
  const short = (s) => (s.length > 70 ? '…' + s.slice(-69) : s);
  for (const c of shown) console.log(`${c.status.padEnd(4)}  ${c.cat.padEnd(9)}  ${short(c.path)}  ${c.prop}: expected ${c.expected}  measured ${c.measured}${c.hint ? '  hint: ' + c.hint : ''}`);
  if (sorted.length > shown.length) {
    const rest = sorted.slice(shown.length);
    console.log(`… ${rest.length} more line(s) not shown (${order.map((s) => `${rest.filter((c) => c.status === s).length} ${s}`).join(', ')}): add --max-lines ${sorted.length}, or --json > compare-report.json`);
  }
  const skips = checks.filter((c) => c.status === 'SKIP');
  if (skips.length) console.log(`COULD NOT CHECK: ${skips.length} (lines marked SKIP)`);
  console.log(`RESULT: ${cnt('PASS')} PASS, ${cnt('FAIL')} FAIL, ${cnt('WARN')} WARN, ${cnt('SKIP')} SKIP`);
  return cnt('FAIL') ? 1 : 0;
}
