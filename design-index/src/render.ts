// Offline renderer: index subtree -> SVG (-> PNG via resvg-wasm). An approximation, not a pixel-exact export:
// auto-layout is re-solved for .pen files (they store no computed positions), text is measured heuristically,
// icon libraries and missing images are drawn as placeholders. Every deviation is reported in `notes`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from './sqlite.js';
import type { Layout, Paint, Styles } from './model.js';
import { safeJson } from './output.js';
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
  /** explicit variable modes in effect (mode names, outermost first) */
  modes?: string[];
}

export interface RenderResult { svg: string; w: number; h: number; notes: string[]; nodes: number }
export interface RenderOpts { assetsDir: string; format: 'pen' | 'fig'; background?: string | null; maxNodes?: number; hideText?: boolean; /** render this evaluated node instead of building it from `id` (vectors inside instances) */ vnode?: VNode }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f2 = (n: number) => String(Math.round(n * 100) / 100);

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

const numOf = (v: unknown, d = 0): number => (typeof v === 'number' && isFinite(v) ? v : d);
/** text as displayed: Figma keeps the source characters and applies the case at render time */
export function withCase(text: string, c?: string): string {
  if (c === 'upper' || c === 'small_caps' || c === 'small_caps_forced') return text.toUpperCase();
  if (c === 'lower') return text.toLowerCase();
  if (c === 'title') return text.replace(/(^|\s)(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return text;
}
/** line pitch in px: explicit multiplier, else the font's normal line height (Figma "Auto" rounds it to whole px) */
function linePx(f: NonNullable<Styles['font']>, fs: number, fallback: number): number {
  if (typeof f.lh === 'number') return f.lh * fs;
  if (typeof f.lh === 'string' && /px$/.test(f.lh)) return parseFloat(f.lh) || fallback * fs;
  if (typeof f.nlh === 'number') return Math.round(f.nlh * fs);
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
  let rs = Array.isArray(rad) ? rad.slice(0, 4) : [rad ?? 0, rad ?? 0, rad ?? 0, rad ?? 0];
  // per-side clamp: top (tl+tr), right (tr+br), bottom (br+bl), left (bl+tl)
  const sides: [number, number, number][] = [[0, 1, bw], [1, 2, bh], [2, 3, bw], [3, 0, bh]];
  for (const [i, j, len] of sides) { const sum = rs[i] + rs[j]; if (sum > len && sum > 0) { const k = len / sum; rs[i] = Math.min(rs[i], rs[i] * k); rs[j] = Math.min(rs[j], rs[j] * k); } }
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
    const modes = v.modes ? [...inherited, ...v.modes.map((m) => m.split('=').slice(1).join('='))] : inherited;
    const row = v.row as unknown as Row;
    const r: R = { row, l: safeJson<Layout>(row.layout) ?? {}, s: safeJson<Styles>(row.styles) ?? {}, raw: safeJson<Record<string, any>>(row.raw) ?? {}, kids: [], x: row.x ?? 0, y: row.y ?? 0, w: row.w ?? 0, h: row.h ?? 0, modes };
    if (row.type === 'path' || row.type === 'boolean' || row.type === 'polygon' || (row.type === 'ellipse' && r.raw.arc)) {
      const g = qGeom.get(v.geomKey ?? row.id) as { data: string } | undefined;
      if (g) geoms.set(row.id + (v.geomKey ?? ''), g.data);
      if (v.geomKey) r.geom = v.geomKey;
    }
    r.kids = v.kids.filter((k) => !k.hidden).map((k) => toR(k, modes));
    return r;
  };
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
  const colorOf = (p: Paint & { k: 'solid' }): { c: string; o: number } | undefined => {
    let c = (p.v ? tokens.colorValue(p.v, curModes) : undefined) ?? p.c;
    if (!c) { if (p.v) notes.add(`Token $${p.v} has no color value`); return undefined; }
    let o = 1;
    if (/^#[0-9a-f]{8}$/i.test(c)) { o = parseInt(c.slice(7, 9), 16) / 255; c = c.slice(0, 7); }
    if (p.o != null) o *= p.o;
    return { c, o };
  };

  function imageHref(hash: string): string | undefined {
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

  /** Gradient definition in the node's coordinates (box w×h); Figma's handles when saved, else a direction through the centre. */
  function gradientDef(p: Paint & { k: 'grad' }, w: number, h: number): string {
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
      if (p.t === 'angular') notes.add('Angular gradient drawn as linear');
    } else if (hp && hp.length >= 6) {
      const [cx, cy, ax, ay, bx, by] = [hp[0] * w, hp[1] * h, hp[2] * w, hp[3] * h, hp[4] * w, hp[5] * h];
      defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${[ax - cx, ay - cy, bx - cx, by - cy, cx, cy].map(f2).join(' ')})">${stops}</radialGradient>`);
      if (p.t === 'angular') notes.add('Angular gradient drawn as radial');
      if (p.t === 'diamond') notes.add('Diamond gradient drawn as radial');
    } else defs.push(`<radialGradient id="${gid}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
    return gid;
  }

  /** fill attribute for a paint list (first solid or gradient paint), in node coordinates */
  function fillAttr(ps: Paint[] | undefined, w: number, h: number): string {
    for (const p of ps ?? []) {
      if (p.k === 'solid') { const c = colorOf(p); if (c) return `fill="${c.c}"${c.o < 1 ? ` fill-opacity="${f2(c.o)}"` : ''}`; }
      if (p.k === 'grad') return `fill="url(#${gradientDef(p, w, h)})"`;
    }
    return 'fill="none"';
  }

  function paintsSvg(r: R, w: number, h: number): string {
    const parts: string[] = [];
    for (const p of r.s.fill ?? []) {
      if (p.k === 'solid') {
        const c = colorOf(p);
        if (c) parts.push(shape(r, w, h, `fill="${c.c}"${c.o < 1 ? ` fill-opacity="${f2(c.o)}"` : ''}`));
      } else if (p.k === 'grad') {
        parts.push(shape(r, w, h, `fill="url(#${gradientDef(p, w, h)})"`));
      } else if (p.k === 'img') {
        // images are pattern fills of the node's shape: no clip-path layer (resvg drops clipped layers inside masks when the
        // content reaches far outside the canvas, which is exactly the image-in-mask case)
        const href = p.asset ? imageHref(p.asset) : undefined;
        const op = p.o != null ? ` fill-opacity="${f2(p.o)}"` : '';
        let body: string | undefined;
        if (href && p.mode === 'crop' && p.tf) {
          // crop: the paint transform maps the node's unit square to the visible part of the image
          const [a, b, c, d, e, f] = p.tf;
          const det = a * e - b * d;
          if (Math.abs(det) > 1e-12) {
            const i00 = e / det, i01 = -b / det, i10 = -d / det, i11 = a / det;
            const i02 = -(i00 * c + i01 * f), i12 = -(i10 * c + i11 * f);
            body = `<image href="${href}" width="1" height="1" preserveAspectRatio="none" transform="matrix(${[w * i00, h * i10, w * i01, h * i11, w * i02, h * i12].map((x) => +x.toFixed(4)).join(' ')})"/>`;
          }
        }
        if (href && !body) {
          const par = p.mode === 'contain' ? 'xMidYMid meet' : p.mode === 'stretch' ? 'none' : 'xMidYMid slice';
          body = `<image href="${href}" width="${f2(w)}" height="${f2(h)}" preserveAspectRatio="${par}"/>`;
        }
        if (body) {
          const pid = `p${++uid}`;
          defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" x="0" y="0" width="${f2(w)}" height="${f2(h)}">${body}</pattern>`);
          parts.push(shape(r, w, h, `fill="url(#${pid})"${op}`));
        } else {
          notes.add(`Image missing (${p.url ?? p.asset ?? '?'}): gray placeholder`);
          parts.push(shape(r, w, h, 'fill="#d0d0d0"') + `<path d="M0 0L${f2(w)} ${f2(h)}M${f2(w)} 0L0 ${f2(h)}" stroke="#a0a0a0" stroke-width="1"/>`);
        }
      }
    }
    return parts.join('');
  }

  function strokeSvg(r: R, w: number, h: number): string {
    const st = r.s.stroke;
    if (!st) return '';
    const p = st.paints.find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
    const col = p ? colorOf(p) : undefined;
    if (!col) return '';
    const sw = st.w;
    const fill = `fill="${col.c}"${col.o < 1 ? ` fill-opacity="${f2(col.o)}"` : ''}`;
    if (Array.isArray(sw)) {
      const [t, rt, b, l] = sw as number[];
      const parts: string[] = [];
      if (t) parts.push(`<rect x="0" y="0" width="${f2(w)}" height="${t}" ${fill}/>`);
      if (b) parts.push(`<rect x="0" y="${f2(h - b)}" width="${f2(w)}" height="${b}" ${fill}/>`);
      if (l) parts.push(`<rect x="0" y="0" width="${l}" height="${f2(h)}" ${fill}/>`);
      if (rt) parts.push(`<rect x="${f2(w - rt)}" y="0" width="${rt}" height="${f2(h)}" ${fill}/>`);
      return parts.join('');
    }
    const width = typeof sw === 'number' ? sw : 1;
    const align = st.align ?? 'inner';
    const inset = align === 'center' ? 0 : align === 'outer' ? -width / 2 : width / 2;
    const sattr = `fill="none" stroke="${col.c}" stroke-width="${width}"${col.o < 1 ? ` stroke-opacity="${f2(col.o)}"` : ''}${st.dash?.length ? ` stroke-dasharray="${st.dash.join(' ')}"` : ''}`;
    if (r.row.type === 'ellipse') return `<ellipse cx="${f2(w / 2)}" cy="${f2(h / 2)}" rx="${f2(Math.max(0, w / 2 - inset))}" ry="${f2(Math.max(0, h / 2 - inset))}" ${sattr}/>`;
    return roundedRect(inset, inset, Math.max(0, w - inset * 2), Math.max(0, h - inset * 2), r.s.r, inset, sattr, w, h);
  }

  function textSvg(r: R): string {
    if (opts.hideText) return '';
    const f = r.s.font ?? {};
    const fs = Number(f.s) || 14;
    const lhPx = linePx(f, fs, opts.format === 'fig' ? 1.2 : 1.36);
    const p = (r.s.fill ?? []).find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
    const col = (p && colorOf(p)) ?? { c: '#000000', o: 1 };
    const fam = f.f && !String(f.f).startsWith('$') ? String(f.f) : 'Open Sans';
    fonts.add(fam);
    const weight = f.w != null ? (typeof f.w === 'number' ? f.w : /^\d+$/.test(String(f.w)) ? Number(f.w) : f.w === 'bold' ? 700 : 400) : 400;
    const al = f.al === 'center' ? 'middle' : f.al === 'right' ? 'end' : 'start';
    const x = al === 'middle' ? r.w / 2 : al === 'end' ? r.w : 0;
    let lines = r.lines;
    if (!lines) {
      // fig: boxes are Figma's saved sizes; wrap within the saved width unless the text hugs its width
      const content = withCase(r.text ?? r.row.text ?? '', f.case);
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
    const free = r.h - lines.length * lhPx;
    const vOff = r.l.h !== 'hug' && free > 0 ? (f.va === 'center' ? free / 2 : f.va === 'bottom' ? free : 0) : 0;
    const base = vOff + (lhPx - fs) / 2 + fs * 0.8;
    const spans = lines.map((ln, i) => `<tspan x="${f2(x)}" y="${f2(base + i * lhPx)}">${esc(ln) || ' '}</tspan>`).join('');
    return `<text font-family="${esc(fam)}, 'Open Sans'" font-size="${fs}" font-weight="${weight}"${f.st === 'italic' ? ' font-style="italic"' : ''} fill="${col.c}"${col.o < 1 ? ` fill-opacity="${f2(col.o)}"` : ''} text-anchor="${al}"${f.ls ? ` letter-spacing="${f2(Number(f.ls))}"` : ''}${f.deco ? ` text-decoration="${f.deco}"` : ''} xml:space="preserve">${spans}</text>`;
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
    if (r.s.clip && r.kids.length) {
      const cid = `k${++uid}`;
      defs.push(`<clipPath id="${cid}">${shape(r, w, h, '')}</clipPath>`);
      clip = cid;
    }
    switch (t) {
      case 'text': out.push(textSvg(r)); break;
      case 'path': case 'boolean': case 'polygon': case 'ellipse': {
        const data = geoms.get(r.row.id + (r.geom ?? ''));
        if (data) {
          const parts = parseGeometry(data);
          const vb = r.raw.viewBox as number[] | undefined;
          // saved outlines of an instance occurrence are already at its size; the component's own outline is in its own box
          const b = r.geom ? { x: 0, y: 0, w, h } : vb ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : pathBounds(parts.map((p) => p.d).join(''));
          const sx = b.w ? w / b.w : 1, sy = b.h ? h / b.h : 1;
          const sp = r.s.stroke?.paints.find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
          const scol = sp ? colorOf(sp) : undefined;
          const stroke = scol ? ` stroke="${scol.c}" stroke-width="${typeof r.s.stroke?.w === 'number' ? r.s.stroke.w : 1}"${scol.o < 1 ? ` stroke-opacity="${f2(scol.o)}"` : ''}${r.s.stroke?.dash?.length ? ` stroke-dasharray="${r.s.stroke.dash.join(' ')}"` : ''} vector-effect="non-scaling-stroke"` : '';
          const regions = r.raw.regions as Record<string, Paint[]> | undefined;
          const tfm = sx === 1 && sy === 1 && !b.x && !b.y ? '' : ` transform="scale(${f2(sx)} ${f2(sy)}) translate(${f2(-b.x)} ${f2(-b.y)})"`;
          for (const part of parts) {
            // a region with its own paints (vectorData.styleOverrideTable); an empty list leaves it unfilled
            const paints = part.sid && regions?.[part.sid] ? regions[part.sid] : r.s.fill;
            const rule = part.rule === 'evenodd' || (parts.length === 1 && !part.rule && r.raw.fillRule === 'evenodd') ? ' fill-rule="evenodd"' : '';
            out.push(`<path d="${esc(part.d)}" ${fillAttr(paints, b.w || w, b.h || h)}${rule}${stroke}${tfm}/>`);
          }
        } else if (t === 'path') { out.push(paintsSvg(r, w, h)); notes.add('Vector without geometry drawn as a plain shape'); }
        else if (t === 'polygon') out.push(polygonSvg(r, w, h));
        else out.push(paintsSvg(r, w, h), strokeSvg(r, w, h));
        break;
      }
      case 'line': {
        const sp = r.s.stroke?.paints.find((x) => x.k === 'solid') as (Paint & { k: 'solid' }) | undefined;
        const col = (sp && colorOf(sp)) ?? { c: '#000000', o: 1 };
        out.push(`<line x1="0" y1="0" x2="${f2(w)}" y2="${f2(h)}" stroke="${col.c}" stroke-width="${typeof r.s.stroke?.w === 'number' ? r.s.stroke.w : 1}"/>`);
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
        out.push(paintsSvg(r, w, h), strokeSvg(r, w, h));
        break;
      default:
        out.push(paintsSvg(r, w, h), strokeSvg(r, w, h));
    }
    if (r.kids.length && !(t === 'boolean' && geoms.has(r.row.id + (r.geom ?? '')))) {
      if (clip) out.push(`<g clip-path="url(#${clip})">`);
      // a visible mask is not drawn: it masks the siblings after it, up to the next mask or the end of the parent
      let masked = false;
      for (const k of r.kids) {
        if (k.raw.mask) {
          if (masked) out.push('</g>');
          const mid = `m${++uid}`;
          const at = out.length;
          emit(k, depth + 1);
          const body = out.splice(at).join('');
          defs.push(`<mask id="${mid}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000"${k.raw.maskType === 'LUMINANCE' ? '' : ' mask-type="alpha" style="mask-type:alpha"'}>${body}</mask>`);
          out.push(`<g mask="url(#${mid})">`);
          masked = true;
          continue;
        }
        emit(k, depth + 1);
      }
      if (masked) out.push('</g>');
      if (clip) out.push('</g>');
    }
    out.push('</g>');
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
