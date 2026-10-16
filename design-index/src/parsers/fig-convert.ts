// Pure mapping from decoded Kiwi NodeChange objects to the intermediate model. No I/O, no state beyond what is passed in.
import type { Layout, NodeRow, NodeType, Paint, Styles } from '../model.js';

type Any = Record<string, any>;

export const guidStr = (g?: { sessionID: number; localID: number } | null): string | null => (g ? `${g.sessionID}:${g.localID}` : null);

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
export function colorHex(c: { r: number; g: number; b: number; a?: number }, opacity = 1): string {
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.995 ? hex2(a) : ''}`;
}

export const TYPE_MAP: Record<string, NodeType> = {
  FRAME: 'frame', SYMBOL: 'component', INSTANCE: 'instance', TEXT: 'text', ROUNDED_RECTANGLE: 'rect', RECTANGLE: 'rect',
  ELLIPSE: 'ellipse', LINE: 'line', VECTOR: 'path', STAR: 'path', REGULAR_POLYGON: 'polygon', BOOLEAN_OPERATION: 'boolean',
  GROUP: 'group', SECTION: 'section', STICKY: 'note', SHAPE_WITH_TEXT: 'note', CODE_BLOCK: 'note', SLICE: 'other', BRUSH: 'other',
  CONNECTOR: 'other', WIDGET: 'other', TABLE: 'other', TABLE_CELL: 'other', HIGHLIGHT: 'other', WASHI_TAPE: 'other', STAMP: 'other',
};
export const GEOMETRY_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION']);

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra.?light|ultra.?light/i, 200], [/light/i, 300], [/semi.?bold|demi.?bold/i, 600],
  [/extra.?bold|ultra.?bold|heavy/i, 800], [/black/i, 900], [/bold/i, 700], [/medium/i, 500], [/regular|normal|book/i, 400],
];
export function weightOf(style: string | undefined): number | string {
  if (!style) return 400;
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  return style;
}

export interface Ctx {
  imageMap: Record<string, string>;
  usage: (kind: string, value: string) => void;
  warn: (msg: string) => void;
}

const bytesHex = (b: unknown): string => (b instanceof Uint8Array ? Buffer.from(b).toString('hex') : '');

function varRef(p: Any): string | undefined {
  const a = p?.colorVar?.value?.alias;
  return a?.assetRef?.key ?? guidStr(a?.guid) ?? undefined;
}

export function convertPaints(list: Any[] | undefined, ctx: Ctx, track: boolean): Paint[] {
  const out: Paint[] = [];
  for (const p of list ?? []) {
    if (!p || p.visible === false) continue;
    const t: string = p.type;
    if (t === 'SOLID') {
      const c = colorHex(p.color ?? { r: 0, g: 0, b: 0 }, p.opacity ?? 1);
      const v = varRef(p);
      if (!v && track) ctx.usage('color', c);
      out.push(v ? { k: 'solid', c, v } : { k: 'solid', c });
    } else if (t.startsWith('GRADIENT')) {
      const stops: [string, number][] = (p.stops ?? []).map((s: Any) => [colorHex(s.color, p.opacity ?? 1), Math.round((s.position ?? 0) * 1000) / 1000]);
      const m = p.transform;
      let a: number | undefined;
      if (m && typeof m.m00 === 'number') {
        const det = m.m00 * m.m11 - m.m01 * m.m10;
        if (Math.abs(det) > 1e-9) {
          // direction of the gradient axis in normalized node space = inverse(M) * (1,0) - inverse(M) * (0,0)
          const dx = m.m11 / det, dy = -m.m10 / det;
          a = Math.round((Math.atan2(-dx, -dy) * 180) / Math.PI);
        }
      }
      out.push({ k: 'grad', t: t === 'GRADIENT_LINEAR' ? 'linear' : t === 'GRADIENT_ANGULAR' ? 'angular' : 'radial', stops, a });
    } else if (t === 'IMAGE') {
      const h = bytesHex(p.image?.hash);
      const asset = h ? ctx.imageMap[h] : undefined;
      const mode = p.imageScaleMode === 'FIT' ? 'contain' : p.imageScaleMode === 'STRETCH' ? 'stretch' : p.imageScaleMode === 'TILE' ? 'tile' : 'cover';
      if (!asset) ctx.warn('image fill without file in the archive (placeholder)');
      out.push({ k: 'img', asset, mode, url: asset ? undefined : `image:${h.slice(0, 12)}` });
    } else if (t === 'EMOJI' || t === 'VIDEO') ctx.warn(`paint type ${t} not supported`);
    else ctx.warn(`unknown paint type ${t}`);
  }
  return out;
}

const AI: Record<string, string> = { MIN: '', CENTER: 'center', MAX: 'end', BASELINE: 'baseline', STRETCH: 'stretch' };
const JC: Record<string, string> = { MIN: '', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between', SPACE_EVENLY: 'around' };

export interface Converted {
  row: NodeRow;
  geomRefs?: { blob: number; rule?: string }[];
  /** for the end-of-stream pass that needs the parent's stack direction */
  childFlags?: { grow: boolean; stretch: boolean };
  stackMode?: string;
  parent: string | null;
  pos: string | null;
}

const propVal = (v: Any): unknown => {
  const x = v?.varValue?.value ?? v?.value ?? {};
  return x.boolValue !== undefined ? x.boolValue
    : x.textDataValue?.characters ?? x.textValue?.characters ?? (typeof x.textValue === 'string' ? x.textValue : undefined) ?? x.floatValue ?? (x.guidValue ? guidStr(x.guidValue) : undefined) ?? null;
};

export function convertNode(n: Any, ctx: Ctx): Converted {
  const id = guidStr(n.guid)!;
  const type: NodeType = TYPE_MAP[n.type] ?? 'other';
  if (!(n.type in TYPE_MAP)) ctx.warn(`unknown node type ${n.type} (mapped to other)`);
  const tr = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const size = n.size ?? { x: 0, y: 0 };
  const styles: Styles = {};
  const layout: Layout = {};
  const raw: Record<string, unknown> = {};

  // transform: translation is the node origin in the parent; rotation is derived from the matrix
  const rotDeg = Math.round(((-Math.atan2(tr.m10, tr.m00) * 180) / Math.PI) * 100) / 100;
  if (rotDeg) styles.rot = rotDeg;
  if (tr.m00 * tr.m11 - tr.m01 * tr.m10 < 0) raw.flipped = true;

  // sizing rules: own auto-layout axes
  const stack = n.stackMode && n.stackMode !== 'NONE' ? (n.stackMode as string) : undefined;
  const hugP = typeof n.stackPrimarySizing === 'string' && n.stackPrimarySizing.startsWith('RESIZE_TO_FIT');
  const hugC = typeof n.stackCounterSizing === 'string' && n.stackCounterSizing.startsWith('RESIZE_TO_FIT');
  if (stack) {
    layout.dir = stack === 'HORIZONTAL' ? 'row' : 'col';
    if (n.stackSpacing) layout.gap = Math.round(n.stackSpacing * 100) / 100;
    const left = n.stackHorizontalPadding ?? 0, top = n.stackVerticalPadding ?? 0;
    const pad = [top, n.stackPaddingRight ?? left, n.stackPaddingBottom ?? top, left].map((v) => Math.round(v * 100) / 100);
    if (pad.some((v) => v)) layout.pad = pad;
    const jc = JC[n.stackPrimaryAlignItems ?? 'MIN'];
    if (jc) layout.jc = jc;
    const ai = AI[n.stackCounterAlignItems ?? 'MIN'];
    if (ai) layout.ai = ai;
    if (n.stackWrap === 'WRAP') layout.wrap = true;
    if (stack === 'HORIZONTAL') { if (hugP) layout.w = 'hug'; if (hugC) layout.h = 'hug'; } else { if (hugP) layout.h = 'hug'; if (hugC) layout.w = 'hug'; }
    if (typeof n.stackSpacing === 'number' && n.stackSpacing) ctx.usage('gap', String(Math.round(n.stackSpacing)));
    for (const v of new Set(pad)) if (v) ctx.usage('pad', String(Math.round(v)));
  }
  if (n.stackPositioning === 'ABSOLUTE') layout.abs = true;

  // fills / strokes / effects
  let fill = convertPaints(n.fillPaints, ctx, true);
  let stroke = convertPaints(n.strokePaints, ctx, false);
  const geomRefs: { blob: number; rule?: string }[] = [];
  const isGeom = GEOMETRY_TYPES.has(n.type);
  if (isGeom) {
    let src: Any[] = n.fillGeometry ?? [];
    if (!src.length && !fill.length && stroke.length && n.strokeGeometry?.length) {
      // stroke-only vector (typical for icons): the stroke outline is the shape to fill with the stroke color
      src = n.strokeGeometry; fill = stroke; stroke = []; raw.geometryFrom = 'stroke';
    }
    for (const g of src) if (typeof g.commandsBlob === 'number') geomRefs.push({ blob: g.commandsBlob, rule: g.windingRule });
    raw.viewBox = [0, 0, size.x, size.y];
    if (src[0]?.windingRule === 'ODD') raw.fillRule = 'evenodd';
  }
  if (fill.length) styles.fill = fill;
  if (stroke.length) {
    const w = n.strokeWeight;
    const per = [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight];
    styles.stroke = {
      paints: stroke,
      w: per.some((x) => typeof x === 'number') ? per.map((x) => x ?? w ?? 0) : typeof w === 'number' ? w : undefined,
      align: n.strokeAlign === 'INSIDE' ? 'inner' : n.strokeAlign === 'OUTSIDE' ? 'outer' : 'center',
      dash: n.dashPattern?.length ? n.dashPattern : undefined,
    };
  }
  const radii = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius];
  if (radii.some((r) => typeof r === 'number' && r > 0)) {
    const r = radii.map((x) => x ?? n.cornerRadius ?? 0);
    styles.r = new Set(r).size === 1 ? r[0] : r;
    for (const x of new Set(r)) if (x) ctx.usage('radius', String(Math.round(x)));
  } else if (typeof n.cornerRadius === 'number' && n.cornerRadius > 0) { styles.r = n.cornerRadius; ctx.usage('radius', String(Math.round(n.cornerRadius))); }
  if (typeof n.opacity === 'number' && n.opacity < 1) styles.op = Math.round(n.opacity * 1000) / 1000;
  if ((n.type === 'FRAME' || n.type === 'SYMBOL' || n.type === 'INSTANCE') && n.frameMaskDisabled !== true) styles.clip = true;
  const fx = (n.effects ?? []).filter((e: Any) => e.visible !== false).map((e: Any) => {
    const t = e.type as string;
    if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') return { k: 'shadow' as const, x: e.offset?.x, y: e.offset?.y, blur: e.radius, spread: e.spread || undefined, c: e.color ? colorHex(e.color) : undefined, inner: t === 'INNER_SHADOW' || undefined };
    if (t === 'BACKGROUND_BLUR') return { k: 'bgblur' as const, blur: e.radius };
    return { k: 'blur' as const, blur: e.radius };
  });
  if (fx.length) styles.fx = fx;

  // text
  let text: string | null = null;
  if (n.type === 'TEXT' || n.type === 'STICKY' || n.type === 'SHAPE_WITH_TEXT' || n.type === 'CODE_BLOCK') {
    text = n.textData?.characters ?? null;
    const fs = n.fontSize;
    const lh = n.lineHeight;
    const ls = n.letterSpacing;
    styles.font = {
      f: n.fontName?.family, s: fs, w: weightOf(n.fontName?.style),
      st: /italic/i.test(n.fontName?.style ?? '') ? 'italic' : undefined,
      lh: lh && lh.units === 'PIXELS' && fs ? Math.round((lh.value / fs) * 1000) / 1000 : lh && lh.units === 'PERCENT' ? Math.round(lh.value) / 100 : undefined,
      ls: ls && ls.value ? (ls.units === 'PERCENT' ? Math.round(((ls.value * fs) / 100) * 100) / 100 : ls.value) : undefined,
      al: n.textAlignHorizontal && n.textAlignHorizontal !== 'LEFT' ? n.textAlignHorizontal.toLowerCase().replace('justified', 'justify') : undefined,
      deco: n.textDecoration && n.textDecoration !== 'NONE' ? n.textDecoration.toLowerCase().replace('strikethrough', 'line-through') : undefined,
      case: n.textCase && n.textCase !== 'ORIGINAL' ? (n.textCase as string).toLowerCase() : undefined,
    };
    if (typeof fs === 'number') ctx.usage('fontSize', String(fs));
    if (n.fontName?.family) ctx.usage('font', n.fontName.family);
    const tar = n.textAutoResize;
    if (tar === 'WIDTH_AND_HEIGHT') { layout.w = 'hug'; layout.h = 'hug'; } else if (tar === 'HEIGHT') layout.h = 'hug';
    if (n.textData?.styleOverrideTable?.length || n.textData?.characterStyleIDs?.some((x: number) => x)) raw.mixedTextStyles = true;
  }

  // component / instance specifics
  let componentRef: string | null = null;
  if (n.type === 'INSTANCE') {
    componentRef = guidStr(n.symbolData?.symbolID);
    const ov: Any[] = [];
    for (const o of (n.symbolData?.symbolOverrides ?? []) as Any[]) {
      const path = (o.guidPath?.guids ?? []).map(guidStr).join('/');
      const e: Any = { p: path };
      if (o.textData?.characters !== undefined) e.t = String(o.textData.characters).slice(0, 120);
      if (o.visible === false) e.hidden = true;
      if (o.overriddenSymbolID) e.swap = guidStr(o.overriddenSymbolID);
      if (o.componentPropAssignments?.length) {
        e.pa = {};
        for (const a of o.componentPropAssignments) e.pa[guidStr(a.defID)!] = propVal(a);
      }
      if (e.t !== undefined || e.hidden || e.swap || e.pa) ov.push(e);
    }
    if (ov.length) raw.overrides = ov.slice(0, 80);
    const pa = n.componentPropAssignments as Any[] | undefined;
    if (pa?.length) {
      const props: Record<string, unknown> = {};
      for (const a of pa) props[guidStr(a.defID)!] = propVal(a);
      raw.props = props;
      raw.pid = props;
    }
  }
  for (const ref of (n.componentPropRefs ?? []) as Any[]) {
    if (ref.isDeleted) continue;
    if (ref.componentPropNodeField === 'TEXT_DATA') raw.textRef = guidStr(ref.defID);
    else if (ref.componentPropNodeField === 'VISIBLE') raw.visRef = guidStr(ref.defID);
  }
  if (n.overrideKey) raw.ok = guidStr(n.overrideKey);
  if (n.isStateGroup) raw.isComponentSet = true;
  if (n.mask) raw.mask = true;
  if (n.horizontalConstraint && !['MIN', 'SCALE'].includes(n.horizontalConstraint)) raw.hConstraint = n.horizontalConstraint;
  if (n.verticalConstraint && !['MIN', 'SCALE'].includes(n.verticalConstraint)) raw.vConstraint = n.verticalConstraint;
  if (n.devStatus?.type) raw.devStatus = n.devStatus.type;

  const row: NodeRow = {
    id, parent_id: guidStr(n.parentIndex?.guid), page: 0, type, name: n.name ?? '', depth: 0, ord: 0,
    x: Math.round(tr.m02 * 100) / 100, y: Math.round(tr.m12 * 100) / 100, w: Math.round(size.x * 100) / 100, h: Math.round(size.y * 100) / 100,
    layout: Object.keys(layout).length ? layout : null,
    styles: Object.keys(styles).length ? styles : null,
    text, component_ref: componentRef, visible: n.visible !== false, raw: Object.keys(raw).length ? raw : null,
    pos: n.parentIndex?.position ?? null,
  };
  const grow = typeof n.stackChildPrimaryGrow === 'number' && n.stackChildPrimaryGrow > 0;
  const stretch = n.stackChildAlignSelf === 'STRETCH';
  return {
    row, geomRefs: geomRefs.length ? geomRefs : undefined, childFlags: grow || stretch ? { grow, stretch } : undefined,
    stackMode: stack, parent: row.parent_id, pos: row.pos ?? null,
  };
}

/** Figma path blob → SVG path data. Commands: 0 close, 1 move, 2 line, 3 quadratic, 4 cubic (float32 LE). */
export function blobToPath(bytes: Uint8Array): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  const f = (o: number) => Math.round(dv.getFloat32(o, true) * 1000) / 1000;
  let o = 0;
  while (o < bytes.length) {
    const cmd = bytes[o++];
    if (cmd === 0) out.push('Z');
    else if (cmd === 1 && o + 8 <= bytes.length) { out.push(`M${f(o)} ${f(o + 4)}`); o += 8; }
    else if (cmd === 2 && o + 8 <= bytes.length) { out.push(`L${f(o)} ${f(o + 4)}`); o += 8; }
    else if (cmd === 3 && o + 16 <= bytes.length) { out.push(`Q${f(o)} ${f(o + 4)} ${f(o + 8)} ${f(o + 12)}`); o += 16; }
    else if (cmd === 4 && o + 24 <= bytes.length) { out.push(`C${f(o)} ${f(o + 4)} ${f(o + 8)} ${f(o + 12)} ${f(o + 16)} ${f(o + 20)}`); o += 24; }
    else break;
  }
  return out.join('');
}

/** Variant properties from a symbol name like "State=Hover, Size=L". */
export function variantFromName(name: string): Record<string, string> | null {
  if (!name.includes('=')) return null;
  const out: Record<string, string> = {};
  for (const part of name.split(/,\s*/)) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
