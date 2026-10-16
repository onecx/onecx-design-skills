// Streaming parser for Pencil .pen files (JSON with comments).
// Token-level state machine: only one node's own properties are materialized at a time, children are emitted
// as soon as they are complete. Memory is bounded by the largest single node, not by the file size.
import fs from 'node:fs';
import path from 'node:path';
import jsoncParser from 'stream-json/jsonc/parser.js';
import type { Layout, NodeRow, NodeType, Paint, Sink, Styles } from '../model.js';
import { AssetWriter, Base64Sink, importFile } from '../assets.js';

type Obj = Record<string, any>;

// Fields documented in https://docs.pencil.dev/for-developers/the-pen-format (schema version 2.21).
const KNOWN = new Set([
  'type', 'id', 'name', 'context', 'reusable', 'theme', 'enabled', 'opacity', 'flipX', 'flipY', 'layoutPosition', 'metadata', 'rotation',
  'x', 'y', 'width', 'height', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'strokeAlignment', 'effect',
  'cornerRadius', 'innerRadius', 'startAngle', 'sweepAngle', 'polygonCount', 'fillRule', 'geometry', 'viewBox',
  'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'fontStyle', 'underline', 'lineHeight', 'textAlign', 'textAlignVertical',
  'strikethrough', 'href', 'content', 'textGrowth', 'children', 'clip', 'placeholder', 'slot', 'layout', 'gap', 'layoutIncludeStroke',
  'padding', 'justifyContent', 'alignItems', 'model', 'library', 'icon', 'weight', 'scriptUri', 'inputs', 'url', 'deviceId', 'zoom',
  'scrollX', 'scrollY', 'ref', 'descendants',
]);
const TYPE_MAP: Record<string, NodeType> = {
  frame: 'frame', group: 'group', text: 'text', rectangle: 'rect', ellipse: 'ellipse', path: 'path', line: 'line',
  polygon: 'polygon', icon: 'icon', icon_font: 'icon', ref: 'instance', note: 'note', prompt: 'note', context: 'note',
};
const JC: Record<string, string> = { space_between: 'between', space_around: 'around', start: '', center: 'center', end: 'end' };

const isVar = (v: unknown): v is string => typeof v === 'string' && v.startsWith('$');
const varName = (v: string) => v.slice(1);

export function normColor(c: string): string {
  let s = c.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + [...s.slice(1)].map((x) => x + x).join('');
  if (/^#[0-9a-f]{4}$/.test(s)) s = '#' + [...s.slice(1)].map((x) => x + x).join('');
  if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) s = s.slice(0, 7);
  return s;
}

export interface PenOptions {
  file: string;
  assetsDir: string;
  sink: Sink;
  onBytes?: (n: number) => void;
}

export async function parsePen(opts: PenOptions): Promise<void> {
  const { sink } = opts;
  const baseDir = path.dirname(opts.file);
  const imageCache = new Map<string, string | null>();
  let genId = 0;
  let pageCount = 0;

  /** Resolve an image fill url (relative file or asset:<hash>) to an asset hash. */
  function resolveImage(url: string): string | undefined {
    if (url.startsWith('asset:')) return url.slice(6);
    if (imageCache.has(url)) return imageCache.get(url) ?? undefined;
    let hash: string | null = null;
    try {
      const abs = path.resolve(baseDir, decodeURI(url));
      if (fs.existsSync(abs)) {
        const row = importFile(abs, opts.assetsDir);
        sink.asset(row);
        hash = row.hash;
      } else sink.warn('image file missing next to .pen (asset unavailable)');
    } catch (e) {
      sink.warn(`image import failed: ${(e as Error).message}`);
    }
    imageCache.set(url, hash);
    return hash ?? undefined;
  }

  // ---- mapping helpers --------------------------------------------------------------------------
  function paint(f: any, st: Styles, prop: string): Paint | undefined {
    if (f == null || f === false) return undefined;
    if (typeof f === 'string') {
      if (isVar(f)) return { k: 'solid', v: varName(f) };
      sink.usage('color', normColor(f));
      return { k: 'solid', c: normColor(f) };
    }
    if (f.enabled === false) return undefined;
    switch (f.type) {
      case 'color': {
        if (isVar(f.color)) return { k: 'solid', v: varName(f.color) };
        if (typeof f.color === 'string') sink.usage('color', normColor(f.color));
        return { k: 'solid', c: typeof f.color === 'string' ? normColor(f.color) : undefined };
      }
      case 'gradient':
        return {
          k: 'grad', t: f.gradientType ?? 'linear', a: typeof f.rotation === 'number' ? f.rotation : undefined,
          stops: (f.colors ?? []).map((s: any) => [isVar(s.color) ? '$' + varName(s.color) : normColor(String(s.color)), Number(s.position ?? 0)]),
        };
      case 'image': {
        const url = typeof f.url === 'string' ? f.url : undefined;
        return { k: 'img', asset: url ? resolveImage(url) : undefined, mode: f.mode ?? 'cover', url: url && !url.startsWith('asset:') ? url : undefined };
      }
      default:
        sink.warn(`unknown fill type ${f.type} (${prop})`);
        return undefined;
    }
  }
  const paints = (v: any, st: Styles, prop: string): Paint[] =>
    (Array.isArray(v) ? v : v == null ? [] : [v]).map((f) => paint(f, st, prop)).filter(Boolean) as Paint[];

  function num(v: unknown, vars: Record<string, string>, key: string): number | undefined {
    if (typeof v === 'number') return v;
    if (isVar(v)) { vars[key] = varName(v); return undefined; }
    return undefined;
  }

  function mapNode(o: Obj, parentId: string | null, page: number, depth: number, ord: number, id: string): { row: NodeRow; geometry?: string } {
    const rawType = String(o.type ?? 'other');
    let type: NodeType = TYPE_MAP[rawType] ?? 'other';
    if (!(rawType in TYPE_MAP)) sink.warn(`unknown node type "${rawType}" (mapped to other)`);
    if (o.reusable === true) type = 'component';
    const vars: Record<string, string> = {};
    const styles: Styles = {};
    const layout: Layout = {};

    // size rules
    let w: number | null = null, h: number | null = null;
    for (const [k, dim] of [['width', 'w'], ['height', 'h']] as const) {
      const v = o[k];
      let rule: Layout['w'];
      let val: number | null = null;
      if (typeof v === 'number') { rule = v; val = v; }
      else if (typeof v === 'string') {
        if (v.startsWith('fill_container')) rule = 'fill';
        else if (v.startsWith('fit_content')) rule = 'hug';
        else if (isVar(v)) vars[k] = varName(v);
        const m = /\((\d+(?:\.\d+)?)\)/.exec(v);
        if (m) val = Number(m[1]);
      } else if (v == null && (type === 'frame' || type === 'component' || type === 'text') && !(type === 'text' && o.textGrowth === undefined)) {
        rule = 'hug';
      }
      if (rule !== undefined) layout[dim] = rule;
      if (dim === 'w') w = val; else h = val;
    }
    if (type === 'text') {
      if (o.textGrowth === 'auto') { layout.w = 'hug'; layout.h = 'hug'; }
      else if (o.textGrowth === 'fixed-width' && layout.h === undefined) layout.h = 'hug';
    }

    // container layout
    if (type === 'frame' || type === 'component') {
      const l = o.layout ?? 'horizontal';
      if (l === 'vertical') layout.dir = 'col';
      else if (l === 'horizontal') layout.dir = 'row';
      if (layout.dir) {
        const g = o.gap;
        if (typeof g === 'number' && g) { layout.gap = g; sink.usage('gap', String(g)); }
        else if (isVar(g)) layout.gap = '$' + varName(g);
        const jc = JC[o.justifyContent ?? 'start'];
        if (jc) layout.jc = jc;
        const ai = o.alignItems;
        if (ai && ai !== 'start') layout.ai = ai;
      }
    }
    if (o.padding != null) {
      const p = Array.isArray(o.padding) ? o.padding : [o.padding];
      const pv = p.map((x: unknown) => (typeof x === 'number' ? x : 0));
      if (p.some(isVar)) vars.padding = p.filter(isVar).map(varName).join(',');
      const four = pv.length === 1 ? [pv[0], pv[0], pv[0], pv[0]] : pv.length === 2 ? [pv[0], pv[1], pv[0], pv[1]] : pv;
      if (four.some((x: number) => x)) { layout.pad = four; for (const x of new Set<number>(four)) if (x) sink.usage('pad', String(x)); }
    }
    if (o.layoutPosition === 'absolute') layout.abs = true;

    // visual styles
    const fill = paints(o.fill, styles, 'fill');
    if (fill.length) styles.fill = fill;
    const stroke = paints(o.stroke, styles, 'stroke');
    if (stroke.length) {
      const sw = o.strokeWidth;
      styles.stroke = {
        paints: stroke,
        w: typeof sw === 'number' ? sw : sw && typeof sw === 'object' ? [sw.top ?? 0, sw.right ?? 0, sw.bottom ?? 0, sw.left ?? 0] : undefined,
        align: o.strokeAlignment,
      };
    }
    const cr = o.cornerRadius;
    if (typeof cr === 'number' && cr) { styles.r = cr; sink.usage('radius', String(cr)); }
    else if (Array.isArray(cr)) { styles.r = cr.map((x: unknown) => (typeof x === 'number' ? x : 0)); }
    else if (isVar(cr)) vars.radius = varName(cr);
    const op = num(o.opacity, vars, 'opacity');
    if (op !== undefined && op !== 1) styles.op = op;
    if (typeof o.rotation === 'number' && o.rotation) styles.rot = o.rotation;
    if (o.clip === true) styles.clip = true;
    const fx = (Array.isArray(o.effect) ? o.effect : o.effect ? [o.effect] : []).filter((e: any) => e && e.enabled !== false);
    if (fx.length) {
      styles.fx = fx.map((e: any) =>
        e.type === 'shadow'
          ? { k: 'shadow' as const, x: e.offset?.x, y: e.offset?.y, blur: e.blur, c: typeof e.color === 'string' ? normColor(e.color) : undefined, inner: e.shadowType === 'inner' || undefined }
          : { k: e.type === 'background_blur' ? ('bgblur' as const) : ('blur' as const), blur: e.radius },
      );
    }

    // text
    let text: string | null = null;
    if (type === 'text' || rawType === 'note' || rawType === 'prompt' || rawType === 'context') {
      if (typeof o.content === 'string') text = o.content;
      const fs_ = o.fontSize;
      styles.font = {
        f: isVar(o.fontFamily) ? '$' + varName(o.fontFamily) : o.fontFamily,
        s: isVar(fs_) ? '$' + varName(fs_) : fs_,
        w: o.fontWeight != null ? (isVar(o.fontWeight) ? '$' + varName(o.fontWeight) : Number(o.fontWeight) || o.fontWeight) : undefined,
        st: o.fontStyle && o.fontStyle !== 'normal' ? o.fontStyle : undefined,
        lh: o.lineHeight, ls: o.letterSpacing || undefined, al: o.textAlign && o.textAlign !== 'left' ? o.textAlign : undefined,
        deco: o.underline === true ? 'underline' : o.strikethrough === true ? 'line-through' : undefined,
      };
      if (typeof fs_ === 'number') sink.usage('fontSize', String(fs_));
      if (typeof o.fontFamily === 'string' && !isVar(o.fontFamily)) sink.usage('font', o.fontFamily);
    }
    if (Object.keys(vars).length) styles.vars = vars;
    if (type === 'icon') (layout as any).icon = undefined;

    const raw: Obj = {};
    for (const k of Object.keys(o)) {
      if (k === 'children' || k === 'geometry') continue;
      if (!KNOWN.has(k)) { sink.warn(`unknown field "${k}" (kept in raw)`); raw[k] = o[k]; }
    }
    for (const k of ['library', 'icon', 'weight', 'descendants', 'theme', 'metadata', 'context', 'slot', 'placeholder', 'textGrowth', 'url', 'scriptUri', 'inputs', 'viewBox', 'fillRule', 'flipX', 'flipY', 'strokeLinecap', 'strokeLinejoin', 'innerRadius', 'startAngle', 'sweepAngle', 'polygonCount', 'textAlignVertical', 'layoutIncludeStroke', 'href']) {
      if (o[k] !== undefined) raw[k] = o[k];
    }
    if (rawType !== 'frame' && TYPE_MAP[rawType] !== type) raw.type = rawType;

    const x = typeof o.x === 'number' ? o.x : null;
    const y = typeof o.y === 'number' ? o.y : null;
    const row: NodeRow = {
      id, parent_id: parentId, page, type, name: typeof o.name === 'string' ? o.name : '', depth, ord,
      x, y, w, h,
      layout: Object.keys(layout).length ? layout : null,
      styles: Object.keys(styles).length ? styles : null,
      text, component_ref: type === 'instance' && typeof o.ref === 'string' ? o.ref : null,
      visible: o.enabled !== false, raw: Object.keys(raw).length ? raw : null,
    };
    return { row, geometry: typeof o.geometry === 'string' ? o.geometry : undefined };
  }

  // ---- token state machine ----------------------------------------------------------------------
  interface NodeCtx { k: 'node'; obj: Obj; key?: string; id?: string; emitted: boolean; parentId: string | null; page: number; depth: number; ord: number; late: boolean }
  interface ObjCtx { k: 'obj'; obj: Obj; key?: string }
  interface ArrCtx { k: 'arr'; arr: unknown[] }
  interface KidsCtx { k: 'kids'; parent: NodeCtx | null; depth: number; ord: number }
  interface RootCtx { k: 'root'; key?: string }
  type Ctx = NodeCtx | ObjCtx | ArrCtx | KidsCtx | RootCtx;
  const stack: Ctx[] = [];
  const rootVars: Obj = {};
  let rootProps: Obj = {};

  let strParts: string[] | null = null;
  let strLen = 0;
  let strDecided = false;
  let b64: { sink: Base64Sink; out: AssetWriter; mime: string } | null = null;

  function put(v: unknown): void {
    const t = stack[stack.length - 1];
    if (!t) return;
    if (t.k === 'node' || t.k === 'obj') { if (t.key !== undefined) { t.obj[t.key] = v; if (t.k === 'node' && t.emitted) t.late = true; } }
    else if (t.k === 'arr') t.arr.push(v);
    else if (t.k === 'root' && t.key !== undefined) rootProps[t.key] = v;
  }

  function emit(c: NodeCtx): void {
    if (c.emitted) return;
    c.emitted = true;
    const o = c.obj;
    const id = typeof o.id === 'string' && o.id ? o.id : `gen-${++genId}`;
    c.id = id;
    const { row, geometry } = mapNode(o, c.parentId, c.page, c.depth, c.ord, id);
    sink.node(row);
    if (geometry) sink.geometry(id, geometry);
    if (row.type === 'component') sink.component({ id, name: row.name || id, page: row.page, description: typeof o.context === 'string' ? o.context : '' });
    if (row.type === 'note' && row.text) sink.note({ node_id: id, kind: String(o.type), text: row.text });
    else if (typeof o.context === 'string' && o.context.trim()) sink.note({ node_id: id, kind: 'context', text: o.context });
    if (c.depth === 0) sink.page(c.page, id, row.name || id);
  }

  const tokens = fs.createReadStream(opts.file, { highWaterMark: 1 << 20 })
    .on('data', (ch) => opts.onBytes?.(ch.length))
    .pipe(jsoncParser.asStream({ streamKeys: false, streamNumbers: false, packStrings: false, streamStrings: true }));

  for await (const tok of tokens as AsyncIterable<{ name: string; value?: any }>) {
    const top = stack[stack.length - 1];
    switch (tok.name) {
      case 'keyValue':
        if (top && (top.k === 'node' || top.k === 'obj' || top.k === 'root')) top.key = tok.value;
        break;
      case 'startObject': {
        if (!top) { stack.push({ k: 'root' }); break; }
        if (top.k === 'kids') {
          const parent = top.parent;
          const page = parent ? parent.page : ++pageCount;
          stack.push({ k: 'node', obj: {}, emitted: false, parentId: parent?.id ?? null, page, depth: top.depth, ord: top.ord++, late: false });
        } else stack.push({ k: 'obj', obj: {} });
        break;
      }
      case 'endObject': {
        const c = stack.pop()!;
        if (c.k === 'node') {
          emit(c);
          if (c.late) sink.warn('properties after "children" were ignored');
          c.obj = {};
        } else if (c.k === 'obj') put(c.obj);
        break;
      }
      case 'startArray': {
        if (top && (top.k === 'node' || top.k === 'root') && top.key === 'children') {
          if (top.k === 'node') { emit(top); stack.push({ k: 'kids', parent: top, depth: top.depth + 1, ord: 0 }); }
          else stack.push({ k: 'kids', parent: null, depth: 0, ord: 0 });
        } else stack.push({ k: 'arr', arr: [] });
        break;
      }
      case 'endArray': {
        const c = stack.pop()!;
        if (c.k === 'arr') put(c.arr);
        break;
      }
      case 'startString':
        strParts = []; strLen = 0; b64 = null; strDecided = false;
        break;
      case 'stringChunk': {
        const chunk: string = tok.value;
        if (b64) { b64.sink.push(chunk); break; }
        strParts!.push(chunk); strLen += chunk.length;
        // decide once we have enough characters: data: URIs are streamed to a file instead of kept in memory
        if (!strDecided && strLen >= 128) {
          strDecided = true;
          const joined = strParts!.join('');
          const m = /^data:([^;,]*)(;[^,]*)?,/.exec(joined.slice(0, 256));
          if (m && /;base64/.test(m[2] ?? '')) {
            const out = new AssetWriter(opts.assetsDir);
            const sinkB = new Base64Sink(out);
            sinkB.push(joined.slice(m[0].length));
            b64 = { sink: sinkB, out, mime: m[1] };
            strParts = []; strLen = 0;
          }
        }
        break;
      }
      case 'endString': {
        if (b64) {
          b64.sink.end();
          const row = b64.out.finish();
          sink.asset(row);
          b64 = null; strParts = null;
          put('asset:' + row.hash);
        } else { put(strParts!.join('')); strParts = null; }
        break;
      }
      case 'numberValue': put(Number(tok.value)); break;
      case 'trueValue': put(true); break;
      case 'falseValue': put(false); break;
      case 'nullValue': put(null); break;
      default: break; // comments etc.
    }
  }

  // ---- document level metadata -----------------------------------------------------------------
  if (rootProps.version) sink.meta('pen_version', String(rootProps.version));
  if (rootProps.version && String(rootProps.version) !== '2.21') sink.warn(`.pen version ${rootProps.version} differs from the documented 2.21; unknown fields are tolerated`);
  if (rootProps.themes) sink.meta('themes', JSON.stringify(rootProps.themes));
  if (rootProps.imports) sink.meta('imports', JSON.stringify(rootProps.imports));
  const vars = rootProps.variables as Obj | undefined;
  if (vars) {
    for (const [name, def] of Object.entries<any>(vars)) {
      const values: Record<string, unknown> = {};
      if (Array.isArray(def.value)) {
        for (const e of def.value) {
          const key = e.theme ? Object.entries(e.theme).map(([a, b]) => `${a}=${b}`).join(',') : 'default';
          values[key] = typeof e.value === 'string' && def.type === 'color' && !isVar(e.value) ? normColor(e.value) : e.value;
        }
      } else values.default = typeof def.value === 'string' && def.type === 'color' && !isVar(def.value) ? normColor(def.value) : def.value;
      sink.variable({ id: name, name, collection: '', type: String(def.type), values });
    }
  }
}
