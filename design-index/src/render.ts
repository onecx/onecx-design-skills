// Offline renderer: index subtree -> SVG (-> PNG via resvg-wasm). An approximation, not a pixel-exact export:
// auto-layout is re-solved for .pen files (they store no computed positions), text is measured heuristically,
// icon libraries and missing images are drawn as placeholders. Every deviation is reported in `notes`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from './sqlite.js';
import type { Layout, Paint, Styles, TextRun } from './model.js';
import { autoPitch, safeJson } from './output.js';
import { TokenIndex } from './tokens.js';
import { Evaluator, TooBig, type VNode } from './instances.js';
import { parseGeometry } from './parsers/fig-convert.js';

interface Row {
  id: string; parent_id: string | null; type: string; name: string; depth: number; ord: number;
  x: number | null; y: number | null; w: number | null; h: number | null;
  layout: string | null; styles: string | null; text: string | null; component_ref: string | null; visible: number; raw: string | null;
}
interface R {
  row: Row; l: Layout; s: Styles; raw: Record<string, any>; kids: R[];
  x: number; y: number; w: number; h: number; lines?: string[]; geom?: string; solved?: boolean; text?: string | null; hide?: boolean;
  /** size a saved occurrence outline was stored at (the node was scaled afterwards) */
  geomBox?: [number, number];
  /** explicit variable modes in effect (mode names, outermost first) */
  modes?: string[];
  /** fig: an explicit mode changed this node's gap, padding or size (its saved layout shows another mode) */
  dirty?: boolean;
  /** memo: this node or a descendant is dirty */
  chg?: boolean;
  /** size limits under the explicit mode (min/max width/height variables) */
  lim?: { minW?: number; maxW?: number; minH?: number; maxH?: number };
  /** accumulated uniform scale of the enclosing instances (VNode.scale): saved numbers are scaled, variable values are not */
  scale?: number;
  /** fig: the saved layout rule (gap, padding) when an explicit mode replaced it in `l` */
  l0?: Layout;
}

export interface RenderResult { svg: string; w: number; h: number; notes: string[]; nodes: number }
export interface RenderOpts { assetsDir: string; format: 'pen' | 'fig'; background?: string | null; maxNodes?: number; hideText?: boolean; /** render this evaluated node instead of building it from `id` (vectors inside instances) */ vnode?: VNode }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (n: number) => String(Math.round(n * 100) / 100);
const f4 = (n: number) => String(Math.round(n * 10000) / 10000);

/** CSS mix-blend-mode for a stored blend mode; Figma's linear burn/dodge have no CSS/resvg equivalent (closest: multiply/screen). */
export function cssBlend(b: string | undefined): { mode?: string; approx?: string } {
  if (!b || b === 'normal' || b === 'pass-through') return {};
  if (b === 'linear-burn') return { mode: 'multiply', approx: b };
  if (b === 'linear-dodge') return { mode: 'screen', approx: b };
  return { mode: b };
}

/** rgba of a #rrggbb[aa] colour */
function rgbaOf(c: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(c);
  if (!m) return [136, 136, 136, 1];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), m[4] ? parseInt(m[4], 16) / 255 : 1];
}
/** Colour of a gradient ramp at t (stops clamp at both ends, linear interpolation in between). */
export function rampAt(stops: [string, number][], t: number): { c: string; o: number } {
  const hex = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  if (!stops.length) return { c: '#888888', o: 1 };
  let a = stops[0], b = stops[stops.length - 1];
  if (t <= a[1]) b = a;
  else if (t >= b[1]) a = b;
  else for (let i = 0; i < stops.length - 1; i++) if (t >= stops[i][1] && t <= stops[i + 1][1]) { a = stops[i]; b = stops[i + 1]; break; }
  const k = b[1] > a[1] ? (t - a[1]) / (b[1] - a[1]) : 0;
  const ca = rgbaOf(a[0]), cb = rgbaOf(b[0]);
  const m = ca.map((v, i) => v + (cb[i] - v) * k);
  return { c: `#${hex(m[0])}${hex(m[1])}${hex(m[2])}`, o: Math.round(m[3] * 1000) / 1000 };
}

// ---- text measurement (heuristic, Open Sans-like proportions) ---------------------------------
function charW(ch: string, fs: number, bold: boolean): number {
  let w: number;
  if ('iljtf.,:;\'|!`'.includes(ch)) w = 0.3;
  else if (ch === ' ') w = 0.26;
  else if ('mwMW@%'.includes(ch)) w = 0.86;
  else if (ch >= 'A' && ch <= 'Z') w = 0.66;
  else if (ch >= '0' && ch <= '9') w = 0.57;
  else if (ch.charCodeAt(0) > 0x2e80) w = 1;
  else w = 0.56;
  return w * fs * (bold ? 1.06 : 1);
}
const textW = (s: string, fs: number, bold: boolean, ls = 0) => { let w = 0; for (const ch of s) w += charW(ch, fs, bold) + ls; return w; };

function wrap(text: string, maxW: number, fs: number, bold: boolean, ls: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!isFinite(maxW)) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      const cand = line + word;
      if (line && textW(cand.trimEnd(), fs, bold, ls) > maxW) { out.push(line.trimEnd()); line = word; } else line = cand;
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** an emoji: pictograph with optional variation selector, skin tone and ZWJ continuation, or a flag (regional indicator pair) */
const EMOJI_RE = /[#*0-9]\uFE0F?\u20E3|[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])*(?:\u200D\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|[\u{1F3FB}-\u{1F3FF}])*)*/gu;
/** placeholder colour of an emoji (no colour emoji font is bundled) */
const EMOJI_FILL = '#f5c33b';
/** cap height as a fraction of the font size (Open Sans 0.714, Inter 0.727, Roboto 0.711) */
const CAP_HEIGHT = 0.7;
const numOf = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
const clampTo = (v: number, min?: number, max?: number): number => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));
/** text as displayed: Figma keeps the source characters and applies the case at render time */
export function withCase(text: string, c?: string): string {
  if (c === 'upper' || c === 'small_caps' || c === 'small_caps_forced') return text.toUpperCase();
  if (c === 'lower') return text.toLowerCase();
  if (c === 'title') return text.replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return text;
}
/**
 * Text as displayed when ranges may set their own case: each code point is mapped with the case of its range (or the text's),
 * `src[k]` = the source UTF-16 index of displayed unit k. Title case looks at the previous source character.
 */
export function casedWithMap(source: string, base: string | undefined, runs: { i: number; n: number; font?: { case?: string | null } }[]): { text: string; src: number[] } {
  let text = '';
  const src: number[] = [];
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const run = runs.find((x) => i >= x.i && i < x.i + x.n);
    const c = run?.font && 'case' in run.font ? run.font.case ?? undefined : base;
    let out = ch;
    if (c === 'upper' || c === 'small_caps' || c === 'small_caps_forced') out = ch.toUpperCase();
    else if (c === 'lower') out = ch.toLowerCase();
    else if (c === 'title' && (i === 0 || /\s/.test(source[i - 1]))) out = ch.toUpperCase();
    text += out;
    for (let k = 0; k < out.length; k++) src.push(i);
    i += ch.length;
  }
  return { text, src };
}

/** line pitch in px: explicit multiplier, else the font's normal line height (Figma "Auto" rounds it to whole px) */
function linePx(f: NonNullable<Styles['font']>, fs: number, fallback: number): number {
  if (typeof f.lh === 'number') return f.lh * fs;
  if (typeof f.lh === 'string' && /px$/.test(f.lh)) return parseFloat(f.lh) || fallback * fs;
  const p = autoPitch(f, fs);
  if (p !== undefined) return p;
  return fallback * fs;
}
const isBold = (s: Styles) => Number(s.font?.w) >= 600 || String(s.font?.w) === 'bold';

// ---- path bounds ------------------------------------------------------------------------------
export function pathBounds(d: string): { x: number; y: number; w: number; h: number } {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let cmd = 'M', cx = 0, cy = 0, sx = 0, sy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  const args: number[] = [];
  const flush = () => {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const n = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[C] ?? 0;
    while (n && args.length >= n) {
      const a = args.splice(0, n);
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      if (C === 'H') { cx = a[0] + ox; pt(cx, cy); }
      else if (C === 'V') { cy = a[0] + oy; pt(cx, cy); }
      else if (C === 'A') { cx = a[5] + ox; cy = a[6] + oy; pt(cx, cy); }
      else {
        for (let i = 0; i < a.length; i += 2) pt(a[i] + ox, a[i + 1] + oy);
        cx = a[a.length - 2] + ox; cy = a[a.length - 1] + oy;
        if (C === 'M') { sx = cx; sy = cy; cmd = rel ? 'l' : 'L'; }
      }
    }
  };
  for (let m: RegExpExecArray | null; (m = re.exec(d)); ) {
    if (m[1]) { flush(); args.length = 0; cmd = m[1]; if (/z/i.test(cmd)) { cx = sx; cy = sy; } }
    else args.push(Number(m[2]));
  }
  flush();
  if (!isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: Math.max(maxX - minX, 0.001), h: Math.max(maxY - minY, 0.001) };
}

/**
 * Rectangle with corner radii (number or [tl,tr,br,bl]) as SVG. Each radius is first clamped to the outer box (bw×bh, Figma clamps
 * per side: two corners sharing a side get it in proportion), then reduced by `inset` (strokes drawn inside/outside the edge).
 */
export function roundedRect(x: number, y: number, w: number, h: number, rad: number | number[] | undefined, inset: number, extra: string, bw = w, bh = h): string {
  const f = (n: number) => String(Math.round(n * 100) / 100);
  const o = (Array.isArray(rad) ? rad.slice(0, 4) : [rad ?? 0, rad ?? 0, rad ?? 0, rad ?? 0]).map((v) => Math.max(0, numOf(v)));
  // per-side factors from the original radii: top (tl+tr), right (tr+br), bottom (br+bl), left (bl+tl); each corner takes the
  // smaller factor of its two sides (never clamped in place, so a full radius on a square gives four equal corners: a circle)
  const sides: [number, number, number][] = [[0, 1, bw], [1, 2, bh], [2, 3, bw], [3, 0, bh]];
  const k = sides.map(([i, j, len]) => (o[i] + o[j] > len && o[i] + o[j] > 0 ? Math.max(0, len) / (o[i] + o[j]) : 1));
  let rs = o.map((v, i) => v * Math.min(k[i], k[(i + 3) % 4]));
  rs = rs.map((v) => Math.max(0, v - inset));
  if (!rs.some((v) => v > 0)) return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" ${extra}/>`;
  if (new Set(rs.map(f)).size === 1) return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(rs[0])}" ${extra}/>`;
  const [a, b, c, d] = rs;
  const arc = (r: number, ex: number, ey: number) => (r ? `A${f(r)} ${f(r)} 0 0 1 ${f(ex)} ${f(ey)}` : `L${f(ex)} ${f(ey)}`);
  return `<path d="M${f(x + a)} ${f(y)}H${f(x + w - b)}${arc(b, x + w, y + b)}V${f(y + h - c)}${arc(c, x + w - c, y + h)}H${f(x + d)}${arc(d, x, y + h - d)}V${f(y + a)}${arc(a, x + a, y)}Z" ${extra}/>`;
}

/** 2x2 linear part [m00, m01, m10, m11] of a node's transform (full matrix for mirrored/skewed nodes, else from the rotation). */
function linearOf(r: { s: Styles; raw: Record<string, any> }): number[] | undefined {
  const m = r.raw.m as number[] | undefined;
  if (Array.isArray(m) && m.length === 4) return m;
  if (!r.s.rot) return undefined;
  const a = (-r.s.rot * Math.PI) / 180;
  return [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
}
function boxOf(m: number[], w: number, h: number, x0 = 0, y0 = 0): { x: number; y: number; w: number; h: number } {
  const pts = [[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]].map(([x, y]) => [m[0] * x + m[1] * y, m[2] * x + m[3] * y]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ---- renderer -----------------------------------------------------------------------------------
export function renderSvg(db: DatabaseSync, id: string, opts: RenderOpts): RenderResult {
  const notes = new Set<string>();
  const tokens = new TokenIndex(db);
  const max = opts.maxNodes ?? 40000;
  // instances are expanded by the shared evaluator (component + bindings + overrides + saved layout), not here
  const ev = new Evaluator(db, { maxDepth: 99, cap: max * 4 });
  const rootRow = opts.vnode ? opts.vnode.row : ev.node(id);
  if (!rootRow) throw new Error(`Node "${id}" not found.`);
  let vtree: VNode;
  try { vtree = opts.vnode ?? ev.build(rootRow as any); } catch (e) { if (e instanceof TooBig) throw new Error(`Frame too large to render (> ${max * 4} nodes): render a smaller section.`); throw e; }
  const geoms = new Map<string, string>();
  const qGeom = db.prepare('SELECT data FROM geometry WHERE node_id=?');
  let nNodes = 0;
  const toR = (v: VNode, inherited: string[] = []): R => {
    nNodes++;
    const modes = v.modes ? [...inherited, ...v.modes] : inherited;
    const row = v.row as unknown as Row;
    const r: R = { row, l: safeJson<Layout>(row.layout) ?? {}, s: safeJson<Styles>(row.styles) ?? {}, raw: safeJson<Record<string, any>>(row.raw) ?? {}, kids: [], x: row.x ?? 0, y: row.y ?? 0, w: row.w ?? 0, h: row.h ?? 0, modes, scale: v.scale };
    if (row.type === 'path' || row.type === 'boolean' || row.type === 'polygon' || (row.type === 'ellipse' && r.raw.arc)) {
      const g = qGeom.get(v.geomKey ?? row.id) as { data: string } | undefined;
      if (g) geoms.set(row.id + (v.geomKey ?? ''), g.data);
      if (v.geomKey) { r.geom = v.geomKey; r.geomBox = v.geomBox; }
    }
    if (modes.length && r.s.vars) modeNumbers(r, modes);
    r.kids = v.kids.filter((k) => !k.hidden).map((k) => toR(k, modes));
    return r;
  };
  /** numbers bound to variables take their value under the explicit modes in effect (saved values are default-mode values) */
  function modeNumbers(r: R, modes: string[]): void {
    const v = r.s.vars!;
    const raw = (k: string): number | undefined => { const x = v[k] ? tokens.modeValue(v[k], modes) : undefined; return typeof x === 'number' ? x : undefined; };
    // lengths inside a scaled instance: the variable holds the unscaled value, the saved numbers are scaled
    const k = r.scale ?? 1;
    const num = (key: string): number | undefined => { const x = raw(key); return x === undefined ? undefined : x * k; };
    const s = { ...r.s };
    let changed = false;
    const corners = ['r-tl', 'r-tr', 'r-br', 'r-bl'].map((k) => num(k) ?? num('radius'));
    if (corners.some((x) => x !== undefined)) {
      const cur = Array.isArray(s.r) ? s.r : [s.r ?? 0, s.r ?? 0, s.r ?? 0, s.r ?? 0];
      s.r = corners.map((x, i) => x ?? cur[i]); changed = true;
    }
    const op = raw('opacity');
    if (op !== undefined) { s.op = op; changed = true; }
    const sw = num('stroke-weight');
    if (sw !== undefined && s.stroke) { s.stroke = { ...s.stroke, w: sw }; changed = true; }
    const fs = num('font-size');
    if (fs !== undefined && s.font) {
      s.font = { ...s.font, s: fs }; delete s.font.lpx; changed = true;
      // Figma scales the unscaled Auto pitch, round(natural line height × mode size), with the instance
      const nlh = s.font.nlh;
      if (k !== 1 && s.font.lh == null && typeof nlh === 'number' && nlh > 0) s.font.lpx = Math.round(nlh * raw('font-size')!) * k;
    }
    if (changed) { r.s = s; notes.add('Numbers bound to variables drawn with their value under the explicit variable mode'); }
    // auto-layout numbers and sizes: where the mode value differs from the saved one, the saved layout shows another mode
    // (instance content keeps its component's default-mode layout); fig re-lays out the container below
    const l = { ...r.l };
    let moved = false;
    const flex = l.dir === 'row' || l.dir === 'col';
    const gap = num('gap');
    if (flex && gap !== undefined && l.jc !== 'between' && l.jc !== 'around' && l.jc !== 'evenly' && Math.abs(gap - numOf(l.gap)) > 0.005) { l.gap = gap; moved = true; }
    const sides = ['pad-top', 'pad-right', 'pad-bottom', 'pad-left'].map((k) => num(k));
    if (flex && sides.some((x) => x !== undefined)) {
      const cur = l.pad ?? [0, 0, 0, 0];
      const pad = sides.map((x, i) => x ?? cur[i] ?? 0);
      if (pad.some((x, i) => Math.abs(x - (cur[i] ?? 0)) > 0.005)) { l.pad = pad; moved = true; }
    }
    const lim = { minW: num('min-width'), maxW: num('max-width'), minH: num('min-height'), maxH: num('max-height') };
    if (Object.values(lim).some((x) => x !== undefined)) r.lim = lim;
    let w = num('width') ?? r.w, h = num('height') ?? r.h;
    w = clampTo(w, lim.minW, lim.maxW); h = clampTo(h, lim.minH, lim.maxH);
    if (Math.abs(w - r.w) > 0.005 || Math.abs(h - r.h) > 0.005) { r.w = w; r.h = h; moved = true; }
    if (moved) { r.l0 = r.l; r.l = l; r.dirty = true; }
  }
  const root = toR(vtree);
  const use = { length: nNodes };
  if (opts.format === 'fig' && nNodes > 1) notes.add('Instances expanded from their component (component properties, overrides, swaps and saved layout applied)');

  const assets = new Map<string, { path: string; mime: string }>();
  for (const a of db.prepare('SELECT hash,path,mime FROM assets').all() as { hash: string; path: string; mime: string }[]) assets.set(a.hash, a);

  // ---- layout (pen only: fig stores computed boxes) ----
  const solveLayout = opts.format === 'pen';
  const pad = (r: R) => r.l.pad ?? [0, 0, 0, 0];
  const isAbsKid = (k: R) => !!k.l.abs;

  function textBox(r: R, fw?: number, fh?: number): void {
    const f = r.s.font ?? {};
    const fs = Number(f.s) || 14;
    const lhPx = linePx(f, fs, 1.36);
    const ls = Number(f.ls) || 0;
    const content = withCase(r.text ?? r.row.text ?? '', f.case);
    const bold = isBold(r.s);
    let limit = Infinity;
    if (fw != null) limit = fw;
    else if (r.l.w === 'hug') limit = Infinity;
    else if (typeof r.l.w === 'number') limit = r.l.w;
    else if (r.row.w) limit = r.row.w;
    r.lines = wrap(content, limit, fs, bold, ls);
    const natW = Math.max(0, ...r.lines.map((l) => textW(l, fs, bold, ls)));
    r.w = fw ?? (typeof r.l.w === 'number' ? r.l.w : r.row.w && r.l.w !== 'hug' ? r.row.w : natW);
    r.h = fh ?? (typeof r.l.h === 'number' ? r.l.h : r.row.h && r.l.h !== 'hug' ? r.row.h : r.lines.length * lhPx);
  }

  function solve(r: R, fw?: number, fh?: number): void {
    const t = r.row.type;
    if (t === 'text' || t === 'note') { textBox(r, fw, fh); return; }
    const hasKids = r.kids.length > 0;
    const ruleW = r.l.w, ruleH = r.l.h;
    const fixedW = typeof ruleW === 'number' ? ruleW : r.row.w ?? undefined;
    const fixedH = typeof ruleH === 'number' ? ruleH : r.row.h ?? undefined;
    if (!hasKids || !(t === 'frame' || t === 'component' || t === 'group' || t === 'section')) {
      r.w = fw ?? fixedW ?? 0; r.h = fh ?? fixedH ?? 0; return;
    }
    const dir = r.l.dir;
    const p = pad(r);
    if (!dir || t === 'group') {
      // absolute children
      let bw = 0, bh = 0;
      const sw = fw ?? (ruleW === 'hug' ? undefined : fixedW);
      const sh = fh ?? (ruleH === 'hug' ? undefined : fixedH);
      for (const k of r.kids) {
        solve(k, k.l.w === 'fill' ? sw : undefined, k.l.h === 'fill' ? sh : undefined);
        bw = Math.max(bw, k.x + k.w); bh = Math.max(bh, k.y + k.h);
      }
      r.w = sw ?? bw; r.h = sh ?? bh;
      for (const k of r.kids) { k.x = numOf(k.row.x); k.y = numOf(k.row.y); }
      return;
    }
    const row = dir === 'row';
    const gap = typeof r.l.gap === 'number' ? r.l.gap : 0;
    const [pt, pr, pb, pl] = p;
    const knownW = fw ?? (ruleW === 'hug' || ruleW === 'fill' ? undefined : fixedW);
    const knownH = fh ?? (ruleH === 'hug' || ruleH === 'fill' ? undefined : fixedH);
    const mainKnown = row ? knownW : knownH;
    const crossKnown = row ? knownH : knownW;
    const innerMain = mainKnown != null ? mainKnown - (row ? pl + pr : pt + pb) : undefined;
    let innerCross = crossKnown != null ? crossKnown - (row ? pt + pb : pl + pr) : undefined;
    const flow = r.kids.filter((k) => !isAbsKid(k));
    const mainRule = (k: R) => (row ? k.l.w : k.l.h);
    const crossRule = (k: R) => (row ? k.l.h : k.l.w);
    const msize = (k: R) => (row ? k.w : k.h);
    const csize = (k: R) => (row ? k.h : k.w);
    // pass 1: non-fill-main kids (cross forced if known and fill)
    const fills: R[] = [];
    for (const k of flow) {
      if (mainRule(k) === 'fill' && innerMain != null) { fills.push(k); continue; }
      const forcedCross = crossRule(k) === 'fill' ? innerCross : undefined;
      solve(k, row ? undefined : forcedCross, row ? forcedCross : undefined);
    }
    if (innerCross == null) {
      innerCross = Math.max(0, ...flow.filter((k) => !fills.includes(k)).map(csize));
    }
    const used = flow.filter((k) => !fills.includes(k)).reduce((a, k) => a + msize(k), 0) + gap * Math.max(0, flow.length - 1);
    const share = fills.length ? Math.max(0, ((innerMain ?? 0) - used) / fills.length) : 0;
    for (const k of fills) {
      const forcedCross = crossRule(k) === 'fill' ? innerCross : undefined;
      solve(k, row ? share : forcedCross, row ? forcedCross : share);
    }
    // cross size of a hug container must include kids that were solved after the first pass (main-axis fill kids)
    if (crossKnown == null) innerCross = Math.max(innerCross, ...flow.map(csize));
    // late fill-cross kids in a hug container
    if (crossKnown == null) for (const k of flow) if (crossRule(k) === 'fill' && !fills.includes(k) && csize(k) !== innerCross) solve(k, row ? undefined : innerCross, row ? innerCross : undefined);
    const totalMain = flow.reduce((a, k) => a + msize(k), 0) + gap * Math.max(0, flow.length - 1);
    const mainSize = innerMain ?? totalMain;
    const crossSize = innerCross;
    r.w = fw ?? knownW ?? (row ? totalMain + pl + pr : crossSize + pl + pr);
    r.h = fh ?? knownH ?? (row ? crossSize + pt + pb : totalMain + pt + pb);
    // positions
    let leftover = Math.max(0, mainSize - totalMain);
    let start = row ? pl : pt;
    let between = gap;
    const jc = r.l.jc;
    if (jc === 'center') start += leftover / 2;
    else if (jc === 'end') start += leftover;
    else if (jc === 'between' && flow.length > 1) between = gap + leftover / (flow.length - 1);
    else if (jc === 'between' && flow.length === 1) start += leftover / 2; // Figma centres a single child
    else if (jc === 'around' && flow.length) { const s = leftover / flow.length; start += s / 2; between = gap + s; }
    else if (jc === 'evenly' && flow.length) { const s = leftover / (flow.length + 1); start += s; between = gap + s; }
    let cur = start;
    const crossBox = row ? r.h - pt - pb : r.w - pl - pr;
    const crossStart = row ? pt : pl;
    for (const k of flow) {
      const cs = csize(k);
      const ai = r.l.ai;
      const off = ai === 'center' ? (crossBox - cs) / 2 : ai === 'end' ? crossBox - cs : 0;
      if (row) { k.x = cur; k.y = crossStart + off; } else { k.y = cur; k.x = crossStart + off; }
      cur += msize(k) + between;
    }
    for (const k of r.kids.filter(isAbsKid)) { solve(k); k.x = numOf(k.row.x) + pl; k.y = numOf(k.row.y) + pt; }
    leftover = 0;
  }

  // ---- fig: re-layout where an explicit variable mode changed gap, padding or size (saved geometry everywhere else) ----
  const changedBelow = (r: R): boolean => (r.chg ??= !!r.dirty || r.kids.map(changedBelow).some(Boolean));
  const r2 = (n: number) => Math.round(n * 100) / 100;
  /**
   * Positions of the flow children of an auto-layout container (simplified flex solver) for a given layout, container size and
   * child sizes. Overflowing content (negative free space) is centred / end-aligned like Figma does; spacing never goes negative.
   * Cross axis: center/end offsets; start, baseline and stretch are placed at the start.
   */
  function flexPositions(l: Layout, row: boolean, W: number, H: number, sizes: { w: number; h: number }[]): [number, number][] {
    const [pt, pr, pb, pl] = l.pad ?? [0, 0, 0, 0];
    const spaced = l.jc === 'between' || l.jc === 'around' || l.jc === 'evenly';
    const gap = spaced ? 0 : numOf(l.gap);
    const n = sizes.length;
    const ms = (k: { w: number; h: number }) => (row ? k.w : k.h), cs = (k: { w: number; h: number }) => (row ? k.h : k.w);
    const total = sizes.reduce((a, k) => a + ms(k), 0) + gap * Math.max(0, n - 1);
    const mainSize = row ? W - pl - pr : H - pt - pb;
    const crossBox = row ? H - pt - pb : W - pl - pr;
    const free = mainSize - total;
    const leftover = spaced ? Math.max(0, free) : free;
    let cur = row ? pl : pt, between = gap;
    const jc = l.jc;
    if (jc === 'center') cur += leftover / 2;
    else if (jc === 'end') cur += leftover;
    else if (jc === 'between' && n > 1) between = leftover / (n - 1);
    else if (jc === 'between' && n === 1) cur += leftover / 2;
    else if (jc === 'around' && n) { const sp = leftover / n; cur += sp / 2; between = sp; }
    else if (jc === 'evenly' && n) { const sp = leftover / (n + 1); cur += sp; between = sp; }
    const crossStart = row ? pt : pl;
    return sizes.map((k) => {
      const off = l.ai === 'center' ? (crossBox - cs(k)) / 2 : l.ai === 'end' ? crossBox - cs(k) : 0;
      const at: [number, number] = row ? [cur, crossStart + off] : [crossStart + off, cur];
      cur += ms(k) + between;
      return at;
    });
  }
  /** a child's new offset and size along one axis of a resized frame, by its constraint (MIN = left/top: unchanged) */
  const pinAxis = (c: unknown, pos: number, size: number, S0: number, d: number): [number, number | undefined] => {
    if (c === 'MAX') return [pos + d, undefined];
    if (c === 'CENTER') return [pos + d / 2, undefined];
    if (c === 'STRETCH') return [pos, Math.max(0, size + d)];
    if (c === 'SCALE' && S0 > 0) { const f = (S0 + d) / S0; return [pos * f, size * f]; }
    return [pos, undefined];
  };
  /** Children outside the flow (absolute children, children of a frame without auto layout) of a resized frame follow their constraints. */
  function constrain(r: R, kids: R[]): void {
    const W0 = numOf(r.row.w, r.w), H0 = numOf(r.row.h, r.h);
    const dW = r.w - W0, dH = r.h - H0;
    const moved = Math.abs(dW) > 0.005 || Math.abs(dH) > 0.005;
    for (const k of kids) {
      if (!moved) { if (changedBelow(k)) place(k); continue; }
      // from the saved position and size: a child may be placed more than once, a shift must not add up
      const [x, kw] = pinAxis(k.raw.hConstraint, numOf(k.row.x, k.x), numOf(k.row.w, k.w), W0, dW);
      const [y, kh] = pinAxis(k.raw.vConstraint, numOf(k.row.y, k.y), numOf(k.row.h, k.h), H0, dH);
      if (kw !== undefined || kh !== undefined || changedBelow(k)) place(k, kw, kh);
      if (Math.abs(x - k.x) > 0.005 || Math.abs(y - k.y) > 0.005) { k.x = r2(x); k.y = r2(y); notes.add('Children outside auto layout follow their constraints where their frame was resized'); }
    }
  }
  /**
   * Re-lays out an auto-layout container below which an explicit variable mode changed gap, padding or size, differentially: the
   * simplified flex solver runs once with the saved values (saved child sizes, the layout's saved gap/padding, the saved container
   * size) and once with the new ones, and every flow child moves by the difference. Along an axis where nothing changed a child
   * keeps Figma's saved offset (baseline alignment, overflow and whatever else the solver does not model stays as Figma laid it
   * out); following siblings shift by the size deltas only. Child sizes stay saved unless they fill the container or a mode changed
   * them; hug sizes are recomputed. Containers outside the changed subtrees keep Figma's saved layout. `fw`/`fh` = size forced by
   * the parent (fill).
   */
  function place(r: R, fw?: number, fh?: number): void {
    let resized = false;
    // a size forced by the parent (fill) still respects the node's own min/max under the mode
    if (fw != null) fw = clampTo(fw, r.lim?.minW, r.lim?.maxW);
    if (fh != null) fh = clampTo(fh, r.lim?.minH, r.lim?.maxH);
    if (fw != null && Math.abs(fw - r.w) > 0.005) { r.w = fw; resized = true; }
    if (fh != null && Math.abs(fh - r.h) > 0.005) { r.h = fh; resized = true; }
    const dir = r.l.dir;
    if (!(dir === 'row' || dir === 'col') || r.l.wrap || r.row.type === 'group' || !(changedBelow(r) || resized)) {
      // frames without auto layout: children follow their constraints; wrap rows and groups keep their saved child positions
      if (!dir && r.row.type !== 'group' && r.row.type !== 'boolean') constrain(r, r.kids);
      else for (const k of r.kids) if (changedBelow(k)) place(k);
      return;
    }
    notes.add('Auto layout re-solved where an explicit variable mode changes gap, padding or size (saved layout elsewhere)');
    const row = dir === 'row';
    const [pt, pr, pb, pl] = r.l.pad ?? [0, 0, 0, 0];
    const spaced = r.l.jc === 'between' || r.l.jc === 'around' || r.l.jc === 'evenly';
    const gap = spaced ? 0 : numOf(r.l.gap);
    const hugMain = (row ? r.l.w : r.l.h) === 'hug', hugCross = (row ? r.l.h : r.l.w) === 'hug';
    const innerMain = hugMain ? undefined : row ? r.w - pl - pr : r.h - pt - pb;
    let innerCross = hugCross ? undefined : row ? r.h - pt - pb : r.w - pl - pr;
    const flow = r.kids.filter((k) => !k.l.abs);
    // what Figma's saved positions were laid out with
    const saved = flow.map((k) => ({ w: numOf(k.row.w, k.w), h: numOf(k.row.h, k.h) }));
    const W0 = numOf(r.row.w, r.w), H0 = numOf(r.row.h, r.h);
    const mainRule = (k: R) => (row ? k.l.w : k.l.h), crossRule = (k: R) => (row ? k.l.h : k.l.w);
    const msize = (k: R) => (row ? k.w : k.h), csize = (k: R) => (row ? k.h : k.w);
    const at = (main?: number, cross?: number): [number | undefined, number | undefined] => (row ? [main, cross] : [cross, main]);
    const fills: R[] = [];
    for (const k of flow) {
      if (mainRule(k) === 'fill' && innerMain != null) { fills.push(k); continue; }
      place(k, ...at(undefined, crossRule(k) === 'fill' && innerCross != null ? innerCross : undefined));
    }
    innerCross ??= Math.max(0, ...flow.filter((k) => !fills.includes(k)).map(csize));
    const used = flow.filter((k) => !fills.includes(k)).reduce((a, k) => a + msize(k), 0) + gap * Math.max(0, flow.length - 1);
    const share = fills.length ? Math.max(0, ((innerMain ?? 0) - used) / fills.length) : 0;
    for (const k of fills) place(k, ...at(share, crossRule(k) === 'fill' ? innerCross : undefined));
    if (hugCross) {
      innerCross = Math.max(innerCross, ...flow.map(csize));
      for (const k of flow) if (crossRule(k) === 'fill' && Math.abs(csize(k) - innerCross) > 0.005) place(k, ...at(undefined, innerCross));
    }
    const total = flow.reduce((a, k) => a + msize(k), 0) + gap * Math.max(0, flow.length - 1);
    if (hugMain) { const m = total + (row ? pl + pr : pt + pb); if (row) r.w = clampTo(m, r.lim?.minW, r.lim?.maxW); else r.h = clampTo(m, r.lim?.minH, r.lim?.maxH); }
    if (hugCross) { const c = innerCross + (row ? pt + pb : pl + pr); if (row) r.h = clampTo(c, r.lim?.minH, r.lim?.maxH); else r.w = clampTo(c, r.lim?.minW, r.lim?.maxW); }
    const before = flexPositions(r.l0 ?? r.l, row, W0, H0, saved);
    const after = flexPositions(r.l, row, r.w, r.h, flow.map((k) => ({ w: k.w, h: k.h })));
    // relative to the saved position: a container placed twice (hug cross size settled after its first pass) must not shift twice
    flow.forEach((k, i) => { k.x = r2(numOf(k.row.x, k.x) + after[i][0] - before[i][0]); k.y = r2(numOf(k.row.y, k.y) + after[i][1] - before[i][1]); });
    constrain(r, r.kids.filter((k) => k.l.abs));
  }
  if (opts.format === 'fig' && changedBelow(root)) place(root);

  if (solveLayout) {
    solve(root);
    if (!root.w) root.w = root.row.w ?? 0;
    root.x = 0; root.y = 0;
    notes.add('Layout (auto-layout, text wrapping) was recomputed from the rules: approximation');
  } else {
    root.x = 0; root.y = 0;
  }

  // ---- svg emission ----
  const defs: string[] = [];
  let uid = 0;
  const out: string[] = [];
  const fonts = new Set<string>();

  let curModes: string[] | undefined;
  /** > 0 while drawing a mask or the layers a mask applies to */
  let maskDepth = 0;
  const colorOf = (p: Paint & { k: 'solid' }): { c: string; o: number } | undefined => {
    const tv = p.v ? tokens.colorValue(p.v, curModes) : undefined;
    let c = tv ?? p.c;
    if (!c) { if (p.v) notes.add(`Token $${p.v} has no color value`); return undefined; }
    let o = 1;
    if (/^#[0-9a-f]{8}$/i.test(c)) { o = parseInt(c.slice(7, 9), 16) / 255; c = c.slice(0, 7); }
    if (p.o != null) o *= p.o;
    // a bound paint drawn at a lower paint opacity than its token's alpha (the saved fallback colour already contains it)
    if (p.v && tv !== undefined) o *= tokens.paintOpacity(p.v, p.c, curModes) ?? 1;
    return { c, o };
  };

  /** data URI of an image asset, read once per render */
  const hrefs = new Map<string, string | undefined>();
  function imageHref(hash: string): string | undefined {
    if (!hrefs.has(hash)) hrefs.set(hash, readHref(hash));
    return hrefs.get(hash);
  }
  function readHref(hash: string): string | undefined {
    const a = assets.get(hash);
    if (!a) return undefined;
    const file = path.join(opts.assetsDir, '..', a.path);
    try {
      const st = fs.statSync(file);
      if (st.size > 12e6) { notes.add('Image >12 MB not embedded'); return undefined; }
      if (a.mime === 'image/webp') { notes.add('WebP image cannot be drawn (placeholder)'); return undefined; }
      return `data:${a.mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch { return undefined; }
  }

  function polygonSvg(r: R, w: number, h: number): string {
    const n = Math.max(3, numOf(r.raw.polygonCount, 3));
    const pts = Array.from({ length: n }, (_, i) => { const a = (i / n) * 2 * Math.PI - Math.PI / 2; return `${f2(w / 2 + (w / 2) * Math.cos(a))},${f2(h / 2 + (h / 2) * Math.sin(a))}`; }).join(' ');
    return `<polygon points="${pts}" ${fillAttr(r.s.fill, w, h)}/>`;
  }

  /** shape element string builder with given fill attribute */
  function shape(r: R, w: number, h: number, extra: string): string {
    if (r.row.type === 'ellipse') return `<ellipse cx="${f2(w / 2)}" cy="${f2(h / 2)}" rx="${f2(w / 2)}" ry="${f2(h / 2)}" ${extra}/>`;
    return roundedRect(0, 0, w, h, r.s.r, 0, extra);
  }

  /**
   * Angular (sweep, clockwise from the first handle) and diamond (L1 distance, corners on the handles) gradients, which SVG/resvg
   * lack, as a pattern in the node's coordinates: a fan of thin wedges / four quadrants with linear gradients, drawn in the
   * gradient's own (u,v) space (centre + u·axis1 + v·axis2).
   */
  function sweepPattern(p: Paint & { k: 'grad' }, w: number, h: number): string {
    const hp = p.p && p.p.length >= 6 ? p.p : [0.5, 0.5, 1, 0.5, 0.5, 1];
    const [cx, cy, ax, ay, bx, by] = [hp[0] * w, hp[1] * h, hp[2] * w, hp[3] * h, hp[4] * w, hp[5] * h];
    const m = [ax - cx, ay - cy, bx - cx, by - cy, cx, cy];
    const det = m[0] * m[3] - m[2] * m[1];
    const stops = p.stops.map(([c, pos]) => [c.startsWith('$') ? tokens.colorValue(c.slice(1)) ?? '#888888' : c, pos] as [string, number]);
    // reach of the pattern in (u,v): far enough to cover the pattern tile (3×3 boxes around the node)
    let K = 4;
    if (Math.abs(det) > 1e-9) {
      for (const [x, y] of [[-w, -h], [2 * w, -h], [-w, 2 * h], [2 * w, 2 * h]]) {
        const dx = x - cx, dy = y - cy;
        const u = (m[3] * dx - m[2] * dy) / det, v = (-m[1] * dx + m[0] * dy) / det;
        K = Math.max(K, Math.hypot(u, v) * 1.2);
      }
    }
    const body: string[] = [];
    const fillOf = (c: { c: string; o: number }) => `fill="${c.c}"${c.o < 1 ? ` fill-opacity="${f2(c.o)}"` : ''}`;
    if (p.t === 'angular') {
      const N = 180;
      for (let k = 0; k < N; k++) {
        // wedges overlap slightly so no hairline gaps show between them
        const a0 = (2 * Math.PI * k) / N, a1 = (2 * Math.PI * (k + 1.6)) / N;
        body.push(`<path d="M0 0L${f4(K * Math.cos(a0))} ${f4(K * Math.sin(a0))}L${f4(K * Math.cos(a1))} ${f4(K * Math.sin(a1))}Z" ${fillOf(rampAt(stops, (k + 0.5) / N))}/>`);
      }
    } else {
      const e = 1.5 / Math.max(1e-6, Math.min(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3])));
      for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const lid = `g${++uid}`;
        const st = stops.map(([c, pos]) => { const x = rgbaOf(c); return `<stop offset="${f2(pos)}" stop-color="${c.slice(0, 7)}"${x[3] < 1 ? ` stop-opacity="${f2(x[3])}"` : ''}/>`; }).join('');
        defs.push(`<linearGradient id="${lid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${su / 2}" y2="${sv / 2}">${st}</linearGradient>`);
        // each quadrant reaches ~1.5 px into its neighbours so no anti-aliased seam shows along the axes
        const ex = -su * e, ey = -sv * e;
        body.push(`<path d="M${f4(ex)} ${f4(ey)}L${f4(su * K)} ${f4(ey)}L${f4(su * K)} ${f4(sv * K)}L${f4(ex)} ${f4(sv * K)}Z" fill="url(#${lid})"/>`);
      }
    }
    const pid = `p${++uid}`;
    defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="${f2(-w)}" y="${f2(-h)}" width="${f2(3 * w)}" height="${f2(3 * h)}"><g transform="translate(${f2(w)} ${f2(h)}) matrix(${m.map(f4).join(' ')})">${body.join('')}</g></pattern>`);
    return pid;
  }

  /** Gradient definition in the node's coordinates (box w×h); Figma's handles when saved, else a direction through the centre. */
  function gradientDef(p: Paint & { k: 'grad' }, w: number, h: number): string {
    if (p.t === 'angular' || p.t === 'diamond') return sweepPattern(p, Math.max(w, 0.01), Math.max(h, 0.01));
    const gid = `g${++uid}`;
    const stops = p.stops.map(([c, pos]) => {
      const col = c.startsWith('$') ? tokens.colorValue(c.slice(1)) ?? '#888888' : c;
      const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(col);
      return `<stop offset="${f2(pos)}" stop-color="${m ? '#' + m[1] : col}"${m?.[2] ? ` stop-opacity="${f2(parseInt(m[2], 16) / 255)}"` : ''}/>`;
    }).join('');
    const hp = p.p;
    if (p.t === 'linear' || (!hp && p.t !== 'radial' && p.t !== 'diamond')) {
      let x1: number, y1: number, x2: number, y2: number;
      if (hp && hp.length >= 4) [x1, y1, x2, y2] = [hp[0] * w, hp[1] * h, hp[2] * w, hp[3] * h];
      else { const a = ((p.a ?? 0) * Math.PI) / 180; const dx = -Math.sin(a), dy = -Math.cos(a); [x1, y1, x2, y2] = [(0.5 - dx / 2) * w, (0.5 - dy / 2) * h, (0.5 + dx / 2) * w, (0.5 + dy / 2) * h]; }
      defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${f2(x1)}" y1="${f2(y1)}" x2="${f2(x2)}" y2="${f2(y2)}">${stops}</linearGradient>`);
    } else if (hp && hp.length >= 6) {
      const [cx, cy, ax, ay, bx, by] = [hp[0] * w, hp[1] * h, hp[2] * w, hp[3] * h, hp[4] * w, hp[5] * h];
      defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${[ax - cx, ay - cy, bx - cx, by - cy, cx, cy].map(f2).join(' ')})">${stops}</radialGradient>`);
    } else defs.push(`<radialGradient id="${gid}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
    return gid;
  }

  /**
   * `fill`/`stroke` attributes of one paint in node coordinates (box w×h): solid colour, gradient or image pattern, with its blend
   * mode. Undefined for a paint that cannot be drawn (missing image, unresolved token).
   */
  function paintAttr(p: Paint, w: number, h: number, attr: 'fill' | 'stroke' = 'fill', blend = true): string | undefined {
    const bm = blend ? blendAttr(p.bm) : '';
    if (p.k === 'solid') { const c = colorOf(p); return c ? `${attr}="${c.c}"${c.o < 1 ? ` ${attr}-opacity="${f2(c.o)}"` : ''}${bm}` : undefined; }
    if (p.k === 'grad') return `${attr}="url(#${gradientDef(p, w, h)})"${bm}`;
    const pid = imagePattern(p, w, h);
    return pid ? `${attr}="url(#${pid})"${p.o != null ? ` ${attr}-opacity="${f2(p.o)}"` : ''}${bm}` : undefined;
  }
  /** fill attribute for a paint list (first solid or gradient paint), in node coordinates */
  function fillAttr(ps: Paint[] | undefined, w: number, h: number): string {
    for (const p of ps ?? []) {
      if (p.k === 'solid' || p.k === 'grad') { const a = paintAttr(p, w, h); if (a) return a; }
    }
    return 'fill="none"';
  }
  /** Image paint as a pattern of the node's box (w×h); undefined when the image cannot be embedded. */
  function imagePattern(p: Paint & { k: 'img' }, w: number, h: number): string | undefined {
    const href = p.asset ? imageHref(p.asset) : undefined;
    if (!href) return undefined;
    let body: string | undefined;
    if (p.mode === 'crop' && p.tf) {
      // crop: the paint transform maps the node's unit square to the visible part of the image
      const [a, b, c, d, e, f] = p.tf;
      const det = a * e - b * d;
      if (Math.abs(det) > 1e-12) {
        const i00 = e / det, i01 = -b / det, i10 = -d / det, i11 = a / det;
        const i02 = -(i00 * c + i01 * f), i12 = -(i10 * c + i11 * f);
        body = `<image href="${href}" width="1" height="1" preserveAspectRatio="none" transform="matrix(${[w * i00, h * i10, w * i01, h * i11, w * i02, h * i12].map((x) => +x.toFixed(4)).join(' ')})"/>`;
      }
    }
    if (!body) {
      const par = p.mode === 'contain' ? 'xMidYMid meet' : p.mode === 'stretch' ? 'none' : 'xMidYMid slice';
      body = `<image href="${href}" width="${f2(w)}" height="${f2(h)}" preserveAspectRatio="${par}"/>`;
    }
    const pid = `p${++uid}`;
    defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="0" y="0" width="${f2(w)}" height="${f2(h)}">${body}</pattern>`);
    return pid;
  }
  /** style attribute for a paint or layer blend mode (resvg supports the CSS separable and non-separable modes) */
  function blendAttr(bm: string | undefined): string {
    const b = cssBlend(bm);
    if (b.approx) notes.add(`Blend mode ${b.approx} drawn as ${b.mode} (no SVG equivalent)`);
    return b.mode ? ` style="mix-blend-mode:${b.mode}"` : '';
  }

  function paintsSvg(r: R, w: number, h: number): string {
    const parts: string[] = [];
    for (const p of r.s.fill ?? []) {
      if (p.k === 'solid') {
        const c = colorOf(p);
        if (c) parts.push(shape(r, w, h, `fill="${c.c}"${c.o < 1 ? ` fill-opacity="${f2(c.o)}"` : ''}${blendAttr(p.bm)}`));
      } else if (p.k === 'grad') {
        parts.push(shape(r, w, h, `fill="url(#${gradientDef(p, w, h)})"${blendAttr(p.bm)}`));
      } else if (p.k === 'img') {
        // images are pattern fills of the node's shape: no clip-path layer (resvg drops clipped layers inside masks when the
        // content reaches far outside the canvas, which is exactly the image-in-mask case)
        const a = paintAttr(p, w, h);
        if (a) parts.push(shape(r, w, h, a));
        else {
          notes.add(`Image missing (${p.url ?? p.asset ?? '?'}): gray placeholder`);
          parts.push(shape(r, w, h, 'fill="#d0d0d0"') + `<path d="M0 0L${f2(w)} ${f2(h)}M${f2(w)} 0L0 ${f2(h)}" stroke="#a0a0a0" stroke-width="1"/>`);
        }
      }
    }
    return parts.join('');
  }

  /** Stroke paints that can be drawn (solid, gradient, image), bottom to top, each with its own blend mode. */
  function strokePaints(r: R): Paint[] {
    return r.s.stroke?.paints ?? [];
  }
  function strokeSvg(r: R, w: number, h: number): string {
    const st = r.s.stroke;
    if (!st) return '';
    const sw = st.w;
    const parts: string[] = [];
    for (const p of strokePaints(r)) {
      if (Array.isArray(sw)) {
        // per-side widths: filled side bands in the node's coordinates (the paint spans the whole box)
        const fill = paintAttr(p, w, h, 'fill', false);
        if (!fill) continue;
        const [t, rt, b, l] = sw as number[];
        const bands: string[] = [];
        if (t) bands.push(`<rect x="0" y="0" width="${f2(w)}" height="${t}"/>`);
        if (b) bands.push(`<rect x="0" y="${f2(h - b)}" width="${f2(w)}" height="${b}"/>`);
        if (l) bands.push(`<rect x="0" y="0" width="${l}" height="${f2(h)}"/>`);
        if (rt) bands.push(`<rect x="${f2(w - rt)}" y="0" width="${rt}" height="${f2(h)}"/>`);
        if (bands.length) parts.push(`<g ${fill}${blendAttr(p.bm)}>${bands.join('')}</g>`);
        continue;
      }
      const a = paintAttr(p, w, h, 'stroke');
      if (!a) continue;
      const width = typeof sw === 'number' ? sw : 1;
      const align = st.align ?? 'inner';
      const inset = align === 'center' ? 0 : align === 'outer' ? -width / 2 : width / 2;
      const sattr = `fill="none" ${a} stroke-width="${width}"${st.dash?.length ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''}`;
      if (r.row.type === 'ellipse') parts.push(`<ellipse cx="${f2(w / 2)}" cy="${f2(h / 2)}" rx="${f2(Math.max(0, w / 2 - inset))}" ry="${f2(Math.max(0, h / 2 - inset))}" ${sattr}/>`);
      else parts.push(roundedRect(inset, inset, Math.max(0, w - inset * 2), Math.max(0, h - inset * 2), r.s.r, inset, sattr, w, h));
    }
    return parts.join('');
  }

  function textSvg(r: R): string {
    if (opts.hideText) return '';
    const f = r.s.font ?? {};
    const fs = Number(f.s) || 14;
    const lhPx = linePx(f, fs, opts.format === 'fig' ? 1.2 : 1.36);
    // the text's paint (solid, gradient or image over the text box); default black
    // one paint server per distinct paint list of this text (not per line or range segment)
    const fills = new Map<string, string | undefined>();
    const fillOf = (ps: Paint[] | undefined): string | undefined => {
      const key = JSON.stringify(ps ?? []);
      if (!fills.has(key)) { let a: string | undefined; for (const p of ps ?? []) { a = paintAttr(p, r.w, r.h); if (a) break; } fills.set(key, a); }
      return fills.get(key);
    };
    const col = fillOf(r.s.fill) ?? 'fill="#000000"';
    const fam = f.f && !String(f.f).startsWith('$') ? String(f.f) : 'Open Sans';
    fonts.add(fam);
    const weight = f.w != null ? (typeof f.w === 'number' ? f.w : /^\d+$/.test(String(f.w)) ? Number(f.w) : f.w === 'bold' ? 700 : 400) : 400;
    const al = f.al === 'center' ? 'middle' : f.al === 'right' ? 'end' : 'start';
    const x = al === 'middle' ? r.w / 2 : al === 'end' ? r.w : 0;
    let lines = r.lines;
    // the displayed characters (case applied per range: a case mapping can change the length, ß → SS) and, per displayed
    // UTF-16 unit, the source index the ranges refer to
    const runs = r.s.runs?.length && !opts.hideText ? r.s.runs : undefined;
    const source = r.text ?? r.row.text ?? '';
    const shown = runs ? casedWithMap(source, f.case, runs) : undefined;
    if (!lines) {
      // fig: boxes are Figma's saved sizes; wrap within the saved width unless the text hugs its width
      const content = shown?.text ?? withCase(source, f.case);
      // the saved height tells how many lines Figma laid out; the heuristic measure must not add lines to a one-line label
      const expected = Math.max(1, Math.round(r.h / lhPx));
      let limit = r.l.w === 'hug' || (expected === 1 && !f.trunc) ? Infinity : r.w + 0.5;
      lines = wrap(content, limit, fs, isBold(r.s), Number(f.ls) || 0);
      for (let i = 0; i < 3 && !f.trunc && isFinite(limit) && lines.length > expected; i++) { limit *= 1.1; lines = wrap(content, limit, fs, isBold(r.s), Number(f.ls) || 0); }
    }
    // truncation with an ellipsis: after maxLines, or where the fixed box ends
    if (f.trunc) {
      const max = typeof f.trunc === 'number' ? f.trunc : Math.max(1, Math.floor((r.h + 0.5) / lhPx));
      if (lines.length > max) { lines = lines.slice(0, max); lines[max - 1] = lines[max - 1].replace(/\s*\S?$/, '') + '…'; }
    }
    // leading trim to the cap height: the box runs from the first line's cap height to the last line's baseline
    const cap = f.trim === 'cap' ? fs * CAP_HEIGHT : undefined;
    const contentH = cap !== undefined ? (lines.length - 1) * lhPx + cap : lines.length * lhPx;
    const free = r.h - contentH;
    const vOff = r.l.h !== 'hug' && free > 0 ? (f.va === 'center' ? free / 2 : f.va === 'bottom' ? free : 0) : 0;
    const base = cap !== undefined ? vOff + cap : vOff + (lhPx - fs) / 2 + fs * 0.8;
    if (cap !== undefined) notes.add('Text box trimmed to cap height: cap height approximated as 0.7 × font size');
    // where each laid-out line starts in the displayed characters
    const starts: number[] = [];
    if (shown) { let cur = 0; for (const ln of lines) { const t = ln.replace(/…$/, ''); const at = shown.text.indexOf(t, cur); starts.push(at < 0 ? -1 : at); if (at >= 0) cur = at + t.length; } }
    const runSpans = (ln: string, li: number): string => {
      const st = starts[li];
      if (!runs || !shown || st === undefined || st < 0) return esc(ln) || ' ';
      const runAt = (ci: number) => runs.findIndex((x) => ci >= x.i && ci < x.i + x.n);
      const body = ln.replace(/…$/, '').length;
      let outS = '', seg = '', cur = -2;
      const flushSeg = () => {
        if (seg && cur >= 0 && runs[cur].emoji) {
          // colour emoji (Figma draws its emoji images): no emoji font offline, a yellow disc per emoji keeps it visible
          notes.add('Emoji drawn as yellow placeholder discs (no colour emoji font offline)');
          const discs = seg.replace(EMOJI_RE, '\u25CF').replace(/[\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}\u{1F3FB}-\u{1F3FF}]/gu, '') || '\u25CF';
          outS += `<tspan${runAttrs({ ...runs[cur], fill: undefined }, f, weight, col, fillOf)} fill="${EMOJI_FILL}">${esc(discs)}</tspan>`;
        } else if (seg) outS += cur >= 0 ? `<tspan${runAttrs(runs[cur], f, weight, col, fillOf)}>${esc(seg)}</tspan>` : esc(seg);
        seg = '';
      };
      for (let k = 0; k < ln.length; k++) {
        // the ellipsis takes the style of the last character it follows
        const ri = runAt(shown.src[st + Math.min(k, Math.max(0, body - 1))] ?? -1);
        if (ri !== cur) { flushSeg(); cur = ri; }
        seg += ln[k];
      }
      flushSeg();
      return outS || ' ';
    };
    const spans = lines.map((ln, i) => `<tspan x="${f2(x)}" y="${f2(base + i * lhPx)}">${runSpans(ln, i)}</tspan>`).join('');
    return `<text font-family="${esc(fam)}, 'Open Sans'" font-size="${fs}" font-weight="${weight}"${f.st === 'italic' ? ' font-style="italic"' : ''} ${col} text-anchor="${al}"${f.ls ? ` letter-spacing="${f2(Number(f.ls))}"` : ''}${f.deco ? ` text-decoration="${f.deco}"` : ''} xml:space="preserve">${spans}</text>`;
  }

  /** attributes of a text range's tspan: only what differs from the text element */
  function runAttrs(run: TextRun, base: NonNullable<Styles['font']>, weight: number | string, col: string, fillOf: (ps: Paint[] | undefined) => string | undefined): string {
    const a: string[] = [];
    const rf = run.font ?? {};
    if (rf.f && rf.f !== base.f) { fonts.add(String(rf.f)); a.push(`font-family="${esc(String(rf.f))}, 'Open Sans'"`); }
    if (typeof rf.s === 'number' && rf.s !== base.s) a.push(`font-size="${f2(rf.s)}"`);
    if (rf.w != null) { const w = typeof rf.w === 'number' ? rf.w : /^\d+$/.test(String(rf.w)) ? Number(rf.w) : 400; if (w !== weight) a.push(`font-weight="${w}"`); }
    if ('st' in rf && (rf.st === 'italic') !== (base.st === 'italic')) a.push(`font-style="${rf.st === 'italic' ? 'italic' : 'normal'}"`);
    if ('deco' in rf && (rf.deco ?? null) !== (base.deco ?? null)) a.push(`text-decoration="${rf.deco ?? 'none'}"`);
    if (typeof rf.ls === 'number' && rf.ls !== base.ls) a.push(`letter-spacing="${f2(rf.ls)}"`);
    // a range's own paint: solid colour, or a gradient / image pattern over the text box (resvg paints text with paint servers)
    const c = run.fill?.length ? fillOf(run.fill) : undefined;
    if (c && c !== col) a.push(c);
    else if (run.fill && !run.fill.length) a.push('fill="none"');
    return a.length ? ' ' + a.join(' ') : '';
  }

  function emit(r: R, depth: number): void {
    const prevModes = curModes;
    if (r.modes) curModes = r.modes;
    try { emitNode(r, depth); } finally { curModes = prevModes; }
  }
  function emitNode(r: R, depth: number): void {
    const t = r.row.type;
    if (t === 'note') return;
    const w = r.w, h = r.h;
    const attrs: string[] = [];
    const tf: string[] = [];
    const lin = linearOf(r);
    if (depth === 0) {
      // the root is drawn inside its own transformed bounds (rotated/mirrored exports must not land outside the viewBox)
      if (lin || rootExt.x || rootExt.y) { const m = lin ?? [1, 0, 0, 1]; const b = boxOf(m, rootExt.w, rootExt.h, rootExt.x, rootExt.y); tf.push(`matrix(${[m[0], m[2], m[1], m[3], -b.x, -b.y].map(f2).join(' ')})`); }
    } else if (lin) tf.push(`matrix(${[lin[0], lin[2], lin[1], lin[3], r.x, r.y].map(f2).join(' ')})`);
    else if (r.x || r.y) tf.push(`translate(${f2(r.x)} ${f2(r.y)})`);
    if (tf.length) attrs.push(`transform="${tf.join(' ')}"`);
    if (r.s.op != null) attrs.push(`opacity="${r.s.op}"`);
    const lb = blendAttr(r.s.blend);
    if (lb) attrs.push(lb.trim());
    const fx = r.s.fx ?? [];
    if (fx.length) {
      const fid = `f${++uid}`;
      const sh = fx.filter((e) => e.k === 'shadow' && !e.inner);
      const bl = fx.find((e) => e.k === 'blur');
      let body = '';
      if (sh.length) {
        body = sh.map((e) => `<feDropShadow dx="${e.x ?? 0}" dy="${e.y ?? 0}" stdDeviation="${f2((e.blur ?? 0) / 2)}" flood-color="${(e.c ?? '#000000').slice(0, 7)}" flood-opacity="${/^#[0-9a-f]{8}$/i.test(e.c ?? '') ? f2(parseInt((e.c as string).slice(7, 9), 16) / 255) : 0.25}"/>`).join('');
      } else if (bl) body = `<feGaussianBlur stdDeviation="${f2((bl.blur ?? 0) / 2)}"/>`;
      if (body) { defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">${body}</filter>`); attrs.push(`filter="url(#${fid})"`); }
      if (fx.some((e) => e.k === 'bgblur')) notes.add('Background blur not drawn');
      if (fx.some((e) => e.inner)) notes.add('Inner shadows not drawn');
    }
    out.push(`<g data-id="${esc(r.row.id)}"${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    let clip = '';
    // resvg drops clip-path layers inside a mask when their content reaches far outside the canvas: there the frame's content
    // becomes a pattern that fills the frame's shape (a pattern tile clips like the frame does)
    const patternClip = !!(r.s.clip && r.kids.length && maskDepth > 0 && w > 0 && h > 0);
    if (r.s.clip && r.kids.length && !patternClip) {
      const cid = `k${++uid}`;
      defs.push(`<clipPath id="${cid}">${shape(r, w, h, '')}</clipPath>`);
      clip = cid;
    }
    let own = '';
    switch (t) {
      case 'text': out.push(textSvg(r)); break;
      case 'path': case 'boolean': case 'polygon': case 'ellipse': {
        const data = geoms.get(r.row.id + (r.geom ?? ''));
        if (data) {
          const parts = parseGeometry(data);
          const vb = r.raw.viewBox as number[] | undefined;
          // saved outlines of an instance occurrence are already at its size; the component's own outline is in its own box
          const b = r.geom ? { x: 0, y: 0, w: r.geomBox?.[0] ?? w, h: r.geomBox?.[1] ?? h } : vb ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : pathBounds(parts.map((p) => p.d).join(''));
          const sx = b.w ? w / b.w : 1, sy = b.h ? h / b.h : 1;
          const bw = b.w || w, bh = b.h || h;
          // every stroke paint is its own stroked copy of the outline (bottom to top, each with its own blend mode)
          const sw = typeof r.s.stroke?.w === 'number' ? r.s.stroke.w : 1;
          const strokes = strokePaints(r).map((p) => paintAttr(p, bw, bh, 'stroke')).filter((a): a is string => !!a)
            .map((a) => ` fill="none" ${a} stroke-width="${sw}"${r.s.stroke?.dash?.length ? ` stroke-dasharray="${r.s.stroke.dash.join(' ')}"` : ''} vector-effect="non-scaling-stroke"`);
          let widen = '';
          // outline icon with a heavier stroke weight than its saved outline: widen the outline by stroking it in its own colour
          if (!strokes.length && r.raw.geometryFrom === 'stroke' && typeof r.s.ow === 'number' && typeof r.raw.outlineW === 'number' && !r.geom) {
            const drawn = r.raw.outlineW * Math.min(sx, sy);
            const fp = r.s.fill?.find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
            const fc = fp ? colorOf(fp) : undefined;
            if (fc && r.s.ow > drawn + 0.01) widen = ` stroke="${fc.c}" stroke-width="${f2(r.s.ow - drawn)}"${fc.o < 1 ? ` stroke-opacity="${f2(fc.o)}"` : ''} stroke-linejoin="round" vector-effect="non-scaling-stroke"`;
            else if (r.s.ow < drawn - 0.01) notes.add('Outline icon with a thinner stroke override drawn at the component\'s stroke weight');
          }
          const regions = r.raw.regions as Record<string, Paint[]> | undefined;
          const tfm = sx === 1 && sy === 1 && !b.x && !b.y ? '' : ` transform="scale(${f2(sx)} ${f2(sy)}) translate(${f2(-b.x)} ${f2(-b.y)})"`;
          for (const part of parts) {
            // a region with its own paints (vectorData.styleOverrideTable); an empty list leaves it unfilled
            const paints = part.sid && regions?.[part.sid] ? regions[part.sid] : r.s.fill;
            const rule = part.rule === 'evenodd' || (parts.length === 1 && !part.rule && r.raw.fillRule === 'evenodd') ? ' fill-rule="evenodd"' : '';
            out.push(`<path d="${esc(part.d)}" ${fillAttr(paints, bw, bh)}${rule}${widen}${tfm}/>`);
          }
          for (const st of strokes) for (const part of parts) out.push(`<path d="${esc(part.d)}"${st}${tfm}/>`);
        } else if (t === 'path') { out.push(paintsSvg(r, w, h)); notes.add('Vector without geometry drawn as a plain shape'); }
        else if (t === 'polygon') out.push(polygonSvg(r, w, h));
        else out.push(paintsSvg(r, w, h), strokeSvg(r, w, h));
        break;
      }
      case 'line': {
        const sw = typeof r.s.stroke?.w === 'number' ? r.s.stroke.w : 1;
        // the paint box of a line is at least as thick as its stroke: a zero-height box would disable an image pattern
        // (<pattern height="0">) and collapse a gradient across the line
        const ps = strokePaints(r).map((p) => paintAttr(p, Math.max(w, sw), Math.max(h, sw), 'stroke')).filter((a): a is string => !!a);
        for (const a of ps.length ? ps : ['stroke="#000000"']) out.push(`<line x1="0" y1="0" x2="${f2(w)}" y2="${f2(h)}" ${a} stroke-width="${sw}"/>`);
        break;
      }
      case 'icon': {
        const name = `${r.raw.library ?? ''}:${r.raw.icon ?? '?'}`;
        notes.add(`Icon ${name}: library not available offline, placeholder`);
        const p = (r.s.fill ?? []).find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
        const col = (p && colorOf(p)) ?? { c: '#666666', o: 1 };
        out.push(`<rect x="1" y="1" width="${f2(Math.max(0, w - 2))}" height="${f2(Math.max(0, h - 2))}" rx="${f2(w / 5)}" fill="none" stroke="${col.c}" stroke-width="1.5" stroke-dasharray="3 2"/>`);
        break;
      }
      case 'instance':
        if (!r.kids.length) notes.add('Instance without resolvable component (library not in the file): drawn as a plain shape');
        own = paintsSvg(r, w, h) + strokeSvg(r, w, h);
        break;
      default:
        own = paintsSvg(r, w, h) + strokeSvg(r, w, h);
    }
    // a clip group is an isolated layer in SVG: children that blend with their frame need the frame's paints inside it
    const blendKids = !!clip && blendsInto(r.kids);
    if (!blendKids) out.push(own);
    if (r.kids.length && !(t === 'boolean' && geoms.has(r.row.id + (r.geom ?? '')))) {
      if (clip) out.push(`<g clip-path="url(#${clip})">`);
      if (blendKids) out.push(own);
      const kidsAt = out.length;
      // a visible mask is not drawn: it masks the siblings after it, up to the next mask or the end of the parent
      let masked = false;
      // stackReverseZIndex: the first child is painted last (on top)
      for (const k of r.raw.revZ ? [...r.kids].reverse() : r.kids) {
        if (k.raw.mask) {
          if (masked) out.push('</g>');
          const mid = `m${++uid}`;
          const at = out.length;
          // OUTLINE ("vector") masks use the shape only: its paints count as opaque. LUMINANCE masks use luminance × alpha (SVG's
          // luminance mask), ALPHA masks the alpha channel.
          maskDepth++;
          try { emit(k.raw.maskType === 'OUTLINE' ? opaque(k) : k, depth + 1); } finally { maskDepth--; }
          const body = out.splice(at).join('');
          defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"${k.raw.maskType === 'LUMINANCE' ? '' : ' mask-type="alpha" style="mask-type:alpha"'}>${body}</mask>`);
          out.push(`<g mask="url(#${mid})">`);
          if (!masked) maskDepth++;
          masked = true;
          continue;
        }
        emit(k, depth + 1);
      }
      if (masked) { out.push('</g>'); maskDepth--; }
      if (clip) out.push('</g>');
      if (patternClip) {
        const pid = `p${++uid}`;
        defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="0" y="0" width="${f2(w)}" height="${f2(h)}">${out.splice(kidsAt).join('')}</pattern>`);
        out.push(shape(r, w, h, `fill="url(#${pid})"`));
      }
    }
    out.push('</g>');
  }

  /**
   * Whether a layer below blends with what is behind it, looking through containers that do not start an isolated layer in SVG
   * (no clip, opacity, effects, own blend mode or masks among their children).
   */
  function blendsInto(kids: R[]): boolean {
    for (const k of kids) {
      if (k.s.blend || k.s.fill?.some((p) => p.bm) || k.s.stroke?.paints.some((p) => p.bm) || k.s.runs?.some((x) => x.fill?.some((p) => p.bm))) return true;
      const isolates = (k.s.clip && k.kids.length) || k.s.op != null || k.s.fx?.length || k.kids.some((x) => x.raw.mask);
      if (!isolates && k.kids.length && blendsInto(k.kids)) return true;
    }
    return false;
  }

  /** A layer drawn as an opaque silhouette (outline masks): every fill becomes opaque black, strokes and effects go. */
  function opaque(r: R): R {
    const black: Paint[] = [{ k: 'solid', c: '#000000' }];
    const s: Styles = { ...r.s };
    // only what is painted counts: a layer without fills (unfilled frame, icon instance) contributes its content, not its box
    if (s.fill?.length) s.fill = black; else delete s.fill;
    if (s.runs) s.runs = s.runs.map((x) => (x.fill ? { ...x, fill: x.fill.length ? black : x.fill } : x));
    delete s.stroke; delete s.fx; delete s.blend;
    const raw = { ...r.raw };
    // per-region paints: a region with paints becomes opaque, an unfilled region stays unfilled
    if (raw.regions) raw.regions = Object.fromEntries(Object.entries(raw.regions as Record<string, Paint[]>).map(([k, v]) => [k, v.length ? black : []]));
    return { ...r, s, raw, kids: r.kids.map(opaque) };
  }

  // a vector exported on its own keeps the parts of its outline that lie outside its box (stroke outlines, overshoot)
  const rootExt = { x: 0, y: 0, w: root.w, h: root.h };
  const rootGeom = geoms.get(root.row.id + (root.geom ?? ''));
  if (rootGeom) {
    const vb = root.raw.viewBox as number[] | undefined;
    const pb = pathBounds(parseGeometry(rootGeom).map((p) => p.d).join(''));
    const sx = !root.geom && vb?.[2] ? root.w / vb[2] : 1, sy = !root.geom && vb?.[3] ? root.h / vb[3] : 1;
    const x0 = Math.min(0, pb.x * sx), y0 = Math.min(0, pb.y * sy);
    const x1 = Math.max(root.w, (pb.x + pb.w) * sx), y1 = Math.max(root.h, (pb.y + pb.h) * sy);
    Object.assign(rootExt, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  emit(root, 0);
  const rlin = linearOf(root);
  const rb = boxOf(rlin ?? [1, 0, 0, 1], rootExt.w, rootExt.h, rootExt.x, rootExt.y);
  const W = Math.max(1, Math.ceil(rb.w - 1e-6)), H = Math.max(1, Math.ceil(rb.h - 1e-6));
  const bg = opts.background === undefined ? '#ffffff' : opts.background;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + (defs.length ? `<defs>${defs.join('')}</defs>` : '')
    + (bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : '')
    + out.join('') + '</svg>';
  const avail = new Set(['Open Sans', 'Inter', 'Ubuntu']);
  for (const f of fonts) if (!avail.has(f)) notes.add(`Font "${f}" not bundled: substituted by Open Sans (widths differ)`);
  return { svg, w: W, h: H, notes: [...notes], nodes: use.length };
}

// ---- rasterization (resvg-wasm, no native deps) ------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
function findUp(rel: string): string {
  for (const base of [here, path.join(here, '..'), path.join(here, '..', 'dist')]) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Internal file missing: ${rel}`);
}

let wasmReady: Promise<void> | undefined;
export async function svgToPng(svg: string, maxEdge: number, w: number, h: number): Promise<Buffer> {
  const mod = await import('@resvg/resvg-wasm');
  wasmReady ??= mod.initWasm(fs.readFileSync(findUp('resvg.wasm')));
  await wasmReady;
  const fontDir = findUp(path.join('assets', 'fonts'));
  const fontBuffers = fs.readdirSync(fontDir).filter((f) => f.endsWith('.ttf')).map((f) => new Uint8Array(fs.readFileSync(path.join(fontDir, f))));
  const fit = w >= h ? { mode: 'width' as const, value: Math.min(maxEdge, w) } : { mode: 'height' as const, value: Math.min(maxEdge, h) };
  const r = new mod.Resvg(svg, { fitTo: fit, font: { fontBuffers, defaultFontFamily: 'Open Sans', loadSystemFonts: false } });
  const png = r.render().asPng();
  r.free();
  return Buffer.from(png);
}
