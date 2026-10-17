import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from '../sqlite.js';
import type { Layout, Paint, Styles } from '../model.js';
import { Out, gradientStr, layoutStr, paintStr, q, safeJson, sizeStr, textAttrs } from '../output.js';
import { TokenIndex } from '../tokens.js';
import { estTokens } from '../util.js';
import { compLabel, requireNode, type NodeRec } from './structure.js';
import { createHash } from 'node:crypto';
import { Evaluator, TooBig, type VNode } from '../instances.js';

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';

/** File name used for exported vector/raster assets so `spec` and `assets export` agree. */
export const svgName = (n: { id: string; name: string; styles?: string | null }, geomKey?: string): string => {
  // a vector inside an instance carries its own saved geometry (and fill): the file name must tell occurrences apart
  const h = geomKey ? '-' + createHash('sha1').update(geomKey + '|' + (n.styles ?? '')).digest('hex').slice(0, 6) : '';
  return `${slug(n.name)}-${n.id}${h}.svg`;
};

const VECTOR_TYPES = new Set(['path', 'line', 'polygon', 'ellipse', 'boolean']);

interface Ctx { db: DatabaseSync; tokens: TokenIndex; assets: Map<string, { path: string; mime: string }>; includeHidden: boolean }

function paintsSpec(c: Ctx, ps: Paint[] | undefined, modes?: string[], w?: number | null, h?: number | null): string {
  if (!ps?.length) return '';
  return ps.map((p) => {
    if (p.k === 'solid' && !p.v && p.c) {
      const t = c.tokens.hexMatch(p.c);
      return t ? `${p.c}(=$${t}?)` : p.c;
    }
    if (p.k === 'solid' && p.v) {
      // under explicit variable modes (e.g. Theme) the token can have another value than in the default CSS: state it
      let eff = '';
      if (modes?.length) { const a = c.tokens.colorValue(p.v, modes), b = c.tokens.colorValue(p.v); if (a && a !== b) eff = `{${a}}`; }
      return `$${c.tokens.nameFor(p.v)}${eff}`;
    }
    if (p.k === 'img') {
      const a = p.asset ? c.assets.get(p.asset) : undefined;
      return a ? `img(${a.path}${p.mode && p.mode !== 'cover' ? ',' + p.mode : ''}${p.o != null ? ',op' + p.o : ''})` : `img(missing:${p.url ?? '?'})`;
    }
    if (p.k === 'grad') return gradientStr(p, w, h, (col) => { const t = col.startsWith('#') ? c.tokens.hexMatch(col) : undefined; return t ? `${col}(=$${t}?)` : col; });
    return paintStr(p);
  }).join('+');
}

/** Keys of Styles.vars that are printed in place of the value they bind (gap, padding, radius, font) instead of separately. */
const INLINE_VARS = new Set(['gap', 'pad-top', 'pad-right', 'pad-bottom', 'pad-left', 'radius', 'r-tl', 'r-tr', 'r-br', 'r-bl', 'font-size', 'font-family', 'line-height', 'letter-spacing', 'text']);

/** Radius binding: one token for all corners or per corner (tl,tr,br,bl); unbound corners keep their number. */
function radiusVar(c: Ctx, v: Record<string, string>, r: Styles['r']): string | undefined {
  const corners = ['r-tl', 'r-tr', 'r-br', 'r-bl'].map((k) => v[k] ?? v.radius);
  if (!corners.some(Boolean)) return undefined;
  const nums = Array.isArray(r) ? r : [r ?? 0, r ?? 0, r ?? 0, r ?? 0];
  const names = corners.map((x, i) => (x ? `$${c.tokens.nameFor(x)}` : String(nums[i] ?? 0)));
  return new Set(names).size === 1 ? names[0] : names.join(',');
}

function styleParts(c: Ctx, n: NodeRec, s: Styles | null, modes?: string[]): string[] {
  const p: string[] = [];
  if (!s) return p;
  const isText = n.type === 'text';
  const raw = safeJson<Record<string, unknown>>(n.raw);
  if (s.fill?.length) p.push(`${isText ? 'color' : 'fill'}=${paintsSpec(c, s.fill, modes, n.w, n.h)}`);
  if (raw?.geometryFrom === 'stroke' && typeof raw.outlineW === 'number') p.push(`(outline of a ${raw.outlineW}px stroke)`);
  if (s.stroke) p.push(`stroke=${paintsSpec(c, s.stroke.paints, modes, n.w, n.h)}/${Array.isArray(s.stroke.w) ? s.stroke.w.join(',') : s.stroke.w ?? 1}${s.stroke.align ? '/' + s.stroke.align : ''}${s.stroke.dash?.length ? `/dash${s.stroke.dash.join(',')}` : ''}`);
  const rv = s.vars && n.type !== 'path' && n.type !== 'boolean' && n.type !== 'polygon' ? radiusVar(c, s.vars, s.r) : undefined;
  if (rv) p.push(`r=${rv}`);
  else if (s.r != null) p.push(`r=${Array.isArray(s.r) ? s.r.join(',') : s.r}`);
  if (s.op != null) p.push(`op=${s.op}`);
  if (s.clip) p.push('clip');
  if (s.rot) p.push(`rot=${s.rot}`);
  if (s.flip) p.push(`flip=${s.flip}`);
  if (s.fx?.length) p.push(`fx=${s.fx.map((e) => (e.k === 'shadow' ? `${e.inner ? 'inset-' : ''}shadow(${e.x ?? 0},${e.y ?? 0},${e.blur ?? 0}${e.spread ? ',' + e.spread : ''},${e.c ?? '#000'})` : `${e.k}(${e.blur ?? 0})`)).join('+')}`);
  if (s.vars) p.push(...Object.entries(s.vars).filter(([k]) => !INLINE_VARS.has(k)).map(([k, v]) => `${k}=$${c.tokens.nameFor(v)}`));
  if (s.vars?.text && isText) p.push(`text-token=$${c.tokens.nameFor(s.vars.text)}`);
  if (s.sty) p.push(`styles{${Object.entries(s.sty).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(',')}}`);
  return p;
}

function fontStr(c: Ctx, s: Styles | null): string {
  const f = s?.font;
  if (!f) return '';
  const v = s?.vars ?? {};
  const tok = (k: string) => (v[k] ? `$${c.tokens.nameFor(v[k])}` : undefined);
  const lh = tok('line-height') ?? (f.lh != null ? (typeof f.lh === 'number' ? Math.round(f.lh * 1000) / 1000 : f.lh) : undefined);
  const ls = tok('letter-spacing') ?? (f.ls != null ? (typeof f.ls === 'number' ? Math.round(f.ls * 100) / 100 : f.ls) : undefined);
  const font = 'font=' + [tok('font-family') ?? f.f, tok('font-size') ?? f.s, f.w != null && f.w !== 'normal' && f.w !== 400 ? `w${f.w}` : null, lh != null ? `lh${lh}` : null,
    ls != null ? `ls${ls}` : null, f.al, f.st, f.deco].filter((x) => x != null && x !== '').join('/');
  return [font, ...textAttrs(f)].join(' ');
}

const PIN_H: Record<string, string> = { MAX: 'right', CENTER: 'center-x', STRETCH: 'left+right', SCALE: 'scale-x' };
const PIN_V: Record<string, string> = { MAX: 'bottom', CENTER: 'center-y', STRETCH: 'top+bottom', SCALE: 'scale-y' };

/** Visual bounding box of a rotated or mirrored node in its parent (the @x,y origin is a corner of the unrotated box). */
function visualBox(n: NodeRec, s: Styles | null, raw: Record<string, unknown> | null): string | undefined {
  if (!s?.rot && !s?.flip && !raw?.m) return undefined;
  const m = (raw?.m as number[] | undefined) ?? (() => { const a = (-(s?.rot ?? 0) * Math.PI) / 180; return [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)]; })();
  const w = n.w ?? 0, h = n.h ?? 0, x = n.x ?? 0, y = n.y ?? 0;
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([px, py]) => [x + m[0] * px + m[1] * py, y + m[2] * px + m[3] * py]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const r = (v: number) => Math.round(v * 100) / 100;
  return `visual@${r(Math.min(...xs))},${r(Math.min(...ys))} ${r(Math.max(...xs) - Math.min(...xs))}×${r(Math.max(...ys) - Math.min(...ys))}`;
}

function lineFor(c: Ctx, n: NodeRec, parent: NodeRec | null, parentAbs: boolean, geomKey: string | undefined, modes?: string[]): { head: string; style: string } {
  const l = safeJson<Layout>(n.layout);
  const s = safeJson<Styles>(n.styles);
  const raw = safeJson<Record<string, unknown>>(n.raw);
  const head: string[] = [q(n.name, 50), n.type];
  const sz = sizeStr(n.w, n.h, l);
  if (sz) head.push(sz);
  const absPos = parentAbs || l?.abs || !parent;
  if (absPos && parent && n.x != null && n.y != null && (n.x || n.y)) head.push(`@${Math.round(n.x * 100) / 100},${Math.round(n.y * 100) / 100}`);
  if (absPos && parent) { const vb = visualBox(n, s, raw); if (vb) head.push(vb); }
  if (absPos && parent && (raw?.hConstraint || raw?.vConstraint)) {
    const pins = [PIN_H[String(raw.hConstraint)], PIN_V[String(raw.vConstraint)]].filter(Boolean);
    if (pins.length) head.push(`pin=${pins.join(',')}`);
  }
  // bound gap/padding print the token instead of the number
  let lv: Layout | null = l ? { ...l, w: undefined, h: undefined, abs: undefined } : null;
  const v = s?.vars;
  if (lv && v) {
    const tok = (k: string) => (v[k] ? `$${c.tokens.nameFor(v[k])}` : undefined);
    if (v.gap && lv.gap !== undefined) lv.gap = tok('gap');
    const sides = ['pad-top', 'pad-right', 'pad-bottom', 'pad-left'];
    if (sides.some((k) => v[k])) lv = { ...lv, pad: sides.map((k, i) => tok(k) ?? (lv!.pad?.[i] ?? 0)) as unknown as number[] };
  }
  const ls = layoutStr(lv);
  if (ls) head.push(ls);
  else if ((n.type === 'frame' || n.type === 'component') && n.nchild > 0 && !l?.dir) head.push('children-abs');
  if (l?.abs) head.push('abs');
  if (raw?.mask) head.push(raw.maskType && raw.maskType !== 'ALPHA' ? `mask(${String(raw.maskType).toLowerCase()})` : 'mask');
  if (n.component_ref) head.push(`→${compLabel(c.db, n.component_ref)}`);
  if (n.type === 'text' && n.text) head.push(`text=${JSON.stringify(n.text.length > 400 ? n.text.slice(0, 400) + '…' : n.text)}`);
  if (n.type === 'text' && raw?.list) head.push(`list=${raw.list}`);
  if (n.type === 'text' && raw?.textPath) head.push('on-path');
  if (n.type === 'icon' && raw?.icon) head.push(`icon=${raw.library ?? ''}:${raw.icon}`);
  if (VECTOR_TYPES.has(n.type)) head.push(`svg=assets/${svgName(n, geomKey)}`);
  if (!n.visible) head.push('(hidden)');
  const style = [...styleParts(c, n, s, modes), fontStr(c, s)].filter(Boolean).join(' ');
  return { head: head.join(' '), style };
}

/** Property values of an instance, shown only where its content is not expanded below it. */
function propsOf(n: NodeRec): string {
  const raw = safeJson<Record<string, unknown>>(n.raw);
  const pr = Object.entries((raw?.props as Record<string, unknown> | undefined) ?? {}).filter(([, v]) => typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number');
  return pr.length ? ` props={${pr.slice(0, 8).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(', ')}}` : '';
}

export interface SpecResult { text: string; nodes: number; tokens: number; truncated: boolean; classes: number }

/** Builds the spec for a subtree. Depth is reduced until the text fits `maxTokens` (unless unlimited). */
export function buildSpec(db: DatabaseSync, id: string, opts: { maxTokens: number; maxDepth?: number; includeHidden?: boolean }): SpecResult {
  const root = requireNode(db, id);
  const assets = new Map<string, { path: string; mime: string }>();
  for (const a of db.prepare('SELECT hash,path,mime FROM assets').all() as { hash: string; path: string; mime: string }[]) assets.set(a.hash, a);
  const c: Ctx = { db, tokens: new TokenIndex(db), assets, includeHidden: !!opts.includeHidden };

  // each rendered line costs >= ~5 tokens: stop walking as soon as the budget cannot be met any more
  const cap = Number.isFinite(opts.maxTokens) ? Math.ceil(opts.maxTokens / 5) + 20 : Infinity;
  const TOO_BIG = new Error('spec too big for budget');
  const render = (maxDepth: number): SpecResult => {
    interface Item { eff?: string[]; geomKey?: string; n: NodeRec; d: number; parent: NodeRec | null; parentAbs: boolean; more?: number; note?: string; modes?: string[] }
    const items: Item[] = [];
    const hiddenInfo: { id: string; name: string }[] = [];
    let hiddenSkipped = 0;
    const unplaced: { id: string; name: string; texts: string[] }[] = [];
    const ev = new Evaluator(db, { maxDepth, cap: Number.isFinite(cap) ? cap * 12 : 400000 });
    let tree: VNode;
    try { tree = ev.build(root); } catch (e) { if (e instanceof TooBig) throw TOO_BIG; throw e; }
    const parentIsAbs = (p: NodeRec): boolean => {
      const l = safeJson<Layout>(p.layout);
      return p.type === 'group' || !l?.dir || l.dir === 'grid';
    };
    const walk = (v: VNode, d: number, parent: NodeRec | null, inh: string[] = []): void => {
      const eff = v.modes ? [...inh, ...v.modes.map((m) => m.split('=').slice(1).join('='))] : inh;
      if (items.length > cap) throw TOO_BIG;
      if (v.hidden && !c.includeHidden) {
        hiddenSkipped++;
        if (hiddenInfo.length < 8) hiddenInfo.push({ id: v.row.id, name: v.row.name });
        return;
      }
      const slotLike = v.isInstance && v.kids.length > 0 && /^slot\b/i.test(compLabel(db, v.row.component_ref));
      items.push({
        eff, geomKey: v.geomKey, n: v.row, d, parent, parentAbs: parent ? parentIsAbs(parent) : true, more: v.truncated, modes: v.modes,
        note: slotLike ? 'slot placeholder: its default content ("Slot component …") is editor decoration, not UI; the real content is given by "text value(s) not placed" below' : undefined,
      });
      if (v.unplaced?.length) unplaced.push({ id: v.row.id, name: v.row.name, texts: v.unplaced });
      if (slotLike) return;
      for (const k of v.kids) walk(k, d + 1, v.row, eff);
    };
    walk(tree, 0, null);

    // repeated style strings become classes, referenced once per node
    const lines = items.map((it) => lineFor(c, it.n, it.parent, it.parent ? parentIsAbs(it.parent) : true, it.geomKey, it.eff));
    const freq = new Map<string, number>();
    for (const l of lines) if (l.style.length > 24) freq.set(l.style, (freq.get(l.style) ?? 0) + 1);
    const classes = new Map<string, string>();
    for (const [st, n] of freq) if (n >= 3) classes.set(st, `.s${classes.size + 1}`);

    const out: string[] = [];
    out.push(`# spec ${root.id} ${q(root.name, 60)} (${root.type}) ${sizeStr(root.w, root.h, safeJson(root.layout))} · P${root.page}`);
    out.push(c.tokens.empty
      ? '# no design tokens in the file: take values (hex, px) as constants/variables from tokens.css, do not invent them'
      : '# $name = CSS variable var(--name) from `tokens`; "(=$x?)" = value equals token x but is not bound in the file (please verify)');
    out.push('# Sizes: fill=fills parent, hug=fits content, number=fixed · @x,y only inside absolutely positioned parents (incl. group, grid) · row/col = flex direction');
    if (lines.some((l) => /\bpin=|\brot=|\bflip=|\bmask\b|\bgrid\b/.test(l.head + ' ' + l.style)))
      out.push('# pin=right|center-x|left+right|scale-x,bottom|center-y|top+bottom|scale-y: constraint of an @x,y layer (left/top when absent) · rot=deg counter-clockwise about @x,y · flip=x|y mirrored in its own box before rotating (CSS: transform-origin:0 0; transform:rotate(-deg) scaleX(-1)|scaleY(-1)) · visual@ = resulting box · mask = clips the following siblings, not drawn · grid = CSS grid, children at their saved @x,y');
    if (items.some((it) => it.modes)) out.push('# modes{Collection=Mode}: explicit variable mode on that frame; tokens below it resolve in that mode (CSS: [data-<collection>="<mode>"], see `tokens`)');
    if (classes.size) {
      out.push('# Classes (repeated styles):');
      for (const [st, cl] of classes) out.push(`#   ${cl}: ${st}`);
    }
    items.forEach((it, i) => {
      const { head, style } = lines[i];
      const cl = classes.get(style);
      const props = it.more && it.n.component_ref ? propsOf(it.n) : '';
      out.push(`${'  '.repeat(it.d)}${head}${it.modes ? ` modes{${it.modes.join(',')}}` : ''}${style ? ' ' + (cl ?? style) : ''}${props}${it.more ? `  … ${it.more} children (spec ${it.n.id})` : ''}`);
      if (it.note) out.push(`${'  '.repeat(it.d + 1)}# ${it.note}`);
    });
    if (hiddenSkipped) {
      const textOf = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) SELECT n.text FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.type='text' AND n.text IS NOT NULL LIMIT 1`);
      out.push(`# ${hiddenSkipped} hidden node(s) omitted (--include-hidden shows them). Ask the user whether they are intended, do not guess:`);
      for (const h of hiddenInfo.slice(0, 6)) {
        const tx = (textOf.get(h.id) as { text: string } | undefined)?.text;
        out.push(`#   hidden ${h.id} ${q(h.name, 40)}${tx ? ` contains text ${q(tx, 40)}` : ''}`);
      }
    }
    for (const u of unplaced.slice(0, 6)) {
      out.push(`# text value(s) not placed: ${u.texts.slice(0, 4).map((t) => q(t, 40)).join(', ')} belong to instance ${u.id} ${q(u.name, 30)}, but its component has no text field for them (slot content / instance swap). Do not drop or invent: place them where the design shows them and ask if unsure`);
    }
    const text = out.join('\n');
    return { text, nodes: items.length, tokens: estTokens(text) + out.length, truncated: items.some((i) => i.more), classes: classes.size };
  };

  const maxDepth = opts.maxDepth ?? 99;
  let depth = maxDepth;
  let res: SpecResult = { text: '', nodes: 0, tokens: 0, truncated: false, classes: 0 };
  if (opts.maxTokens === Infinity) res = render(depth);
  if (opts.maxTokens < Infinity) {
    // find the deepest level that fits
    // grow the depth until the budget is exhausted (cheap for huge trees: aborts as soon as the cap is hit)
    const tryRender = (dd: number): SpecResult | null => { try { return render(dd); } catch (e) { if (e === TOO_BIG) return null; throw e; } };
    let best = tryRender(1) ?? render(0);
    let d = 1;
    while (best.truncated && d < Math.min(maxDepth, 12)) {
      const r = tryRender(d + 1);
      if (!r || r.tokens > opts.maxTokens) break;
      best = r; d++;
    }
    res = best;
    depth = d;
  }
  void depth;
  return res;
}

export function specCommand(db: DatabaseSync, out: Out, id: string, o: { out?: string; depth?: string; includeHidden?: boolean; maxTokensGiven: boolean }): void {
  const toFile = !!o.out;
  const budget = toFile && !o.maxTokensGiven ? Infinity : out.opts.maxTokens - 100;
  const r = buildSpec(db, id, { maxTokens: budget, maxDepth: o.depth ? Number(o.depth) : undefined, includeHidden: o.includeHidden });
  if (toFile) {
    fs.mkdirSync(path.dirname(path.resolve(o.out!)), { recursive: true });
    fs.writeFileSync(o.out!, r.text + '\n');
    out.add(`${r.nodes} nodes, ~${r.tokens} tokens → ${o.out}${r.truncated ? ' (truncated)' : ''}`, { nodes: r.nodes, tokens: r.tokens, file: o.out });
    out.hint('Read the file section by section (do not load it completely if it is large).');
    return;
  }
  for (const line of r.text.split('\n')) out.add(line);
  if (r.truncated) out.hint(`Truncated to ${out.opts.maxTokens} tokens: split into sections with \`tree ${id} --depth 1\` and fetch \`spec <child-id>\` per section, or use \`--out <file>\`.`);
}
