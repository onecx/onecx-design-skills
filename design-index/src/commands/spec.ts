import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from '../sqlite.js';
import type { Layout, Paint, Styles } from '../model.js';
import { Out, layoutStr, paintStr, q, safeJson, sizeStr } from '../output.js';
import { TokenIndex } from '../tokens.js';
import { estTokens } from '../util.js';
import { children, compLabel, requireNode, type NodeRec } from './structure.js';

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset';

/** File name used for exported vector/raster assets so `spec` and `assets export` agree. */
export const svgName = (n: { id: string; name: string }): string => `${slug(n.name)}-${n.id}.svg`;

const VECTOR_TYPES = new Set(['path', 'line', 'polygon', 'ellipse', 'boolean']);

interface Ctx { db: DatabaseSync; tokens: TokenIndex; assets: Map<string, { path: string; mime: string }>; includeHidden: boolean }

function paintsSpec(c: Ctx, ps: Paint[] | undefined): string {
  if (!ps?.length) return '';
  return ps.map((p) => {
    if (p.k === 'solid' && !p.v && p.c) {
      const t = c.tokens.hexMatch(p.c);
      return t ? `${p.c}(=$${t}?)` : p.c;
    }
    if (p.k === 'solid' && p.v) return `$${c.tokens.nameFor(p.v)}`;
    if (p.k === 'img') {
      const a = p.asset ? c.assets.get(p.asset) : undefined;
      return a ? `img(${a.path}${p.mode && p.mode !== 'cover' ? ',' + p.mode : ''})` : `img(missing:${p.url ?? '?'})`;
    }
    return paintStr(p);
  }).join('+');
}

function styleParts(c: Ctx, n: NodeRec, s: Styles | null): string[] {
  const p: string[] = [];
  if (!s) return p;
  const isText = n.type === 'text';
  if (s.fill?.length) p.push(`${isText ? 'color' : 'fill'}=${paintsSpec(c, s.fill)}`);
  if (s.stroke) p.push(`stroke=${paintsSpec(c, s.stroke.paints)}/${Array.isArray(s.stroke.w) ? s.stroke.w.join(',') : s.stroke.w ?? 1}${s.stroke.align ? '/' + s.stroke.align : ''}`);
  if (s.r != null) p.push(`r=${Array.isArray(s.r) ? s.r.join(',') : s.r}`);
  if (s.op != null) p.push(`op=${s.op}`);
  if (s.clip) p.push('clip');
  if (s.rot) p.push(`rot=${s.rot}`);
  if (s.fx?.length) p.push(`fx=${s.fx.map((e) => (e.k === 'shadow' ? `${e.inner ? 'inset-' : ''}shadow(${e.x ?? 0},${e.y ?? 0},${e.blur ?? 0}${e.spread ? ',' + e.spread : ''},${e.c ?? '#000'})` : `${e.k}(${e.blur ?? 0})`)).join('+')}`);
  if (s.vars) p.push(...Object.entries(s.vars).map(([k, v]) => `${k}=$${c.tokens.nameFor(v)}`));
  return p;
}

function fontStr(s: Styles | null): string {
  const f = s?.font;
  if (!f) return '';
  return 'font=' + [f.f, f.s, f.w != null && f.w !== 'normal' && f.w !== 400 ? `w${f.w}` : null, f.lh != null ? `lh${typeof f.lh === 'number' ? Math.round(f.lh * 1000) / 1000 : f.lh}` : null,
    f.ls != null ? `ls${typeof f.ls === 'number' ? Math.round(f.ls * 100) / 100 : f.ls}` : null, f.al, f.st, f.deco].filter((x) => x != null && x !== '').join('/');
}

function lineFor(c: Ctx, n: NodeRec, parent: NodeRec | null, parentAbs: boolean, geomLen: number | undefined): { head: string; style: string } {
  const l = safeJson<Layout>(n.layout);
  const s = safeJson<Styles>(n.styles);
  const head: string[] = [q(n.name, 50), n.type];
  const sz = sizeStr(n.w, n.h, l);
  if (sz) head.push(sz);
  const absPos = parentAbs || l?.abs || !parent;
  if (absPos && parent && n.x != null && n.y != null && (n.x || n.y)) head.push(`@${Math.round(n.x * 100) / 100},${Math.round(n.y * 100) / 100}`);
  const ls = layoutStr(l ? { ...l, w: undefined, h: undefined, abs: undefined } : null);
  if (ls) head.push(ls);
  else if ((n.type === 'frame' || n.type === 'component') && n.nchild > 0 && !l?.dir) head.push('children-abs');
  if (l?.abs) head.push('abs');
  if (n.component_ref) head.push(`→${compLabel(c.db, n.component_ref)}`);
  if (n.type === 'text' && n.text) head.push(`text=${JSON.stringify(n.text.length > 400 ? n.text.slice(0, 400) + '…' : n.text)}`);
  const raw = safeJson<Record<string, unknown>>(n.raw);
  if (n.type === 'icon' && raw?.icon) head.push(`icon=${raw.library ?? ''}:${raw.icon}`);
  if (n.component_ref && raw?.descendants) head.push(`overrides=${JSON.stringify(raw.descendants).slice(0, 200)}`);
  if (n.component_ref && raw?.props) {
    const pr = Object.entries(raw.props as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined);
    if (pr.length) head.push(`props={${pr.slice(0, 8).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(', ')}}`);
  }
  if (Array.isArray(raw?.overrides)) {
    const ovs = raw.overrides as { t?: string; hidden?: boolean; swap?: string; pa?: Record<string, unknown> }[];
    const texts = ovs.flatMap((o) => [o.t, ...Object.values(o.pa ?? {})]).filter((v): v is string => typeof v === 'string' && v.length > 0);
    const hid = ovs.filter((o) => o.hidden).length;
    const sw = ovs.filter((o) => o.swap).length;
    const bits = [texts.length ? `texts=${JSON.stringify([...new Set(texts)].slice(0, 6).map((t) => t.slice(0, 32)))}` : '', hid ? `hidden=${hid}` : '', sw ? `swaps=${sw}` : ''].filter(Boolean);
    if (bits.length) head.push(`overrides{${bits.join(' ')}}`);
  }
  if (geomLen || VECTOR_TYPES.has(n.type)) head.push(`svg=assets/${svgName(n)}`);
  if (!n.visible) head.push('(hidden)');
  const style = [...styleParts(c, n, s), fontStr(s)].filter(Boolean).join(' ');
  return { head: head.join(' '), style };
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
    interface Item { n: NodeRec; d: number; parent: NodeRec | null; parentAbs: boolean; more?: number; hidden?: number }
    const items: Item[] = [];
    let hiddenSkipped = 0;
    const walk = (n: NodeRec, d: number, parent: NodeRec | null) => {
      if (items.length > cap) throw TOO_BIG;
      items.push({ n, d, parent, parentAbs: parent ? parentIsAbs(parent) : true });
      if (!n.nchild) return;
      if (d >= maxDepth) { items[items.length - 1].more = n.nchild; return; }
      for (const k of children(db, n.id)) {
        if (!k.visible && !c.includeHidden) { hiddenSkipped++; continue; }
        walk(k, d + 1, n);
      }
    };
    const parentIsAbs = (p: NodeRec): boolean => {
      const l = safeJson<Layout>(p.layout);
      return p.type === 'group' || !l?.dir;
    };
    walk(root, 0, null);

    // repeated style strings become classes, referenced once per node
    const lines = items.map((it) => lineFor(c, it.n, it.parent, it.parent ? parentIsAbs(it.parent) : true, undefined));
    const freq = new Map<string, number>();
    for (const l of lines) if (l.style.length > 24) freq.set(l.style, (freq.get(l.style) ?? 0) + 1);
    const classes = new Map<string, string>();
    for (const [st, n] of freq) if (n >= 3) classes.set(st, `.s${classes.size + 1}`);

    const out: string[] = [];
    out.push(`# spec ${root.id} ${q(root.name, 60)} (${root.type}) ${sizeStr(root.w, root.h, safeJson(root.layout))} · P${root.page}`);
    out.push(c.tokens.empty
      ? '# no design tokens in the file: take values (hex, px) as constants/variables from tokens.css, do not invent them'
      : '# $name = CSS variable var(--name) from `tokens`; "(=$x?)" = value equals token x but is not bound in the file (please verify)');
    out.push('# Sizes: fill=fills parent, hug=fits content, number=fixed · @x,y only inside absolutely positioned parents · row/col = flex direction');
    if (classes.size) {
      out.push('# Classes (repeated styles):');
      for (const [st, cl] of classes) out.push(`#   ${cl}: ${st}`);
    }
    items.forEach((it, i) => {
      const { head, style } = lines[i];
      const cl = classes.get(style);
      out.push(`${'  '.repeat(it.d)}${head}${style ? ' ' + (cl ?? style) : ''}${it.more ? `  … ${it.more} children (spec ${it.n.id})` : ''}`);
    });
    if (hiddenSkipped) out.push(`# ${hiddenSkipped} hidden nodes omitted (--include-hidden)`);
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
