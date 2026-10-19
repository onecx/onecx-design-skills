// Pure mapping from decoded Kiwi NodeChange objects to the intermediate model. No I/O, no state beyond what is passed in.
// Field semantics follow what Figma itself saved in real files (child transforms, derivedTextData, fillGeometry); see the
// research notes referenced in README (0.1.3 changelog).
import type { Layout, NodeRow, NodeType, Paint, Styles, TextRun } from '../model.js';

type Any = Record<string, any>;

export const guidStr = (g?: { sessionID: number; localID: number } | null): string | null => (g ? `${g.sessionID}:${g.localID}` : null);
/** Figma's "no value" guid (ffffffff:ffffffff), e.g. a style reference that an override cleared */
export const UNSET_ID = 4294967295;

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v: number) => { const x = Math.max(0, Math.min(1, v)); return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055; };
/**
 * Display-P3 colour (Figma `documentColorProfile: DISPLAY_P3`) to sRGB: both use the sRGB transfer curve; linear P3 -> linear sRGB
 * (CSS Color 4 matrices), out-of-gamut values are clamped.
 */
export function p3ToSrgb(c: { r: number; g: number; b: number; a?: number }): { r: number; g: number; b: number; a?: number } {
  const r = lin(c.r), g = lin(c.g), b = lin(c.b);
  return {
    r: enc(1.2249401762805598 * r - 0.22494017628055996 * g),
    g: enc(-0.04205695470968816 * r + 1.0420569547096881 * g),
    b: enc(-0.019637554590334432 * r - 0.07863604555063188 * g + 1.0982736001409663 * b),
    a: c.a,
  };
}
/** `p3` = the document stores Display-P3 values: convert them to sRGB first */
export function colorHex(c: { r: number; g: number; b: number; a?: number }, opacity = 1, p3 = false): string {
  if (p3) c = p3ToSrgb(c);
  const a = (c.a ?? 1) * opacity;
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${a < 0.995 ? hex2(a) : ''}`;
}
/** Figma blend mode -> CSS spelling; normal and pass-through (the defaults) -> undefined. Figma's LINEAR_BURN/LINEAR_DODGE keep their names. */
export function blendOf(m: unknown): string | undefined {
  if (typeof m !== 'string' || m === 'NORMAL' || m === 'PASS_THROUGH' || m === 'UNSET') return undefined;
  return m.toLowerCase().replace(/_/g, '-');
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

export const TYPE_MAP: Record<string, NodeType> = {
  FRAME: 'frame', SYMBOL: 'component', INSTANCE: 'instance', TEXT: 'text', TEXT_PATH: 'text', ROUNDED_RECTANGLE: 'rect', RECTANGLE: 'rect',
  ELLIPSE: 'ellipse', LINE: 'line', VECTOR: 'path', STAR: 'path', REGULAR_POLYGON: 'polygon', BOOLEAN_OPERATION: 'boolean', BRUSH: 'path',
  GROUP: 'group', SECTION: 'section', STICKY: 'note', SHAPE_WITH_TEXT: 'note', CODE_BLOCK: 'note', SLICE: 'other',
  CONNECTOR: 'other', WIDGET: 'other', TABLE: 'other', TABLE_CELL: 'other', HIGHLIGHT: 'other', WASHI_TAPE: 'other', STAMP: 'other',
};
/** node types whose outline is Figma's saved fillGeometry (corner radius is baked into the path) */
export const GEOMETRY_TYPES = new Set(['VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'BRUSH']);
/** node types that are never UI (export regions) */
export const SKIP_TYPES = new Set(['SLICE']);

const WEIGHTS: [RegExp, number][] = [
  [/thin|hairline/i, 100], [/extra.?light|ultra.?light/i, 200], [/light/i, 300], [/semi.?bold|demi.?bold/i, 600],
  [/extra.?bold|ultra.?bold|heavy/i, 800], [/black/i, 900], [/bold/i, 700], [/medium/i, 500], [/regular|normal|book/i, 400],
];
/** Weight from the font style name; `meta` = Figma's saved weight of the drawn font (derivedTextData.fontMetaData), which wins. */
export function weightOf(style: string | undefined, meta?: number): number | string {
  if (typeof meta === 'number' && meta > 0) return meta;
  if (!style) return 400;
  for (const [re, w] of WEIGHTS) if (re.test(style)) return w;
  // "Italic" / "Oblique" alone is the regular weight
  if (!style.replace(/italic|oblique/gi, '').trim()) return 400;
  return style;
}

export interface Ctx {
  imageMap: Record<string, string>;
  usage: (kind: string, value: string) => void;
  warn: (msg: string) => void;
  /** the document's colours are Display-P3 (DOCUMENT.documentColorProfile) */
  p3?: boolean;
}

const bytesHex = (b: unknown): string => (b instanceof Uint8Array ? Buffer.from(b).toString('hex') : '');

/** Variable id of an alias value: assetRef key (library copy) or local guid. Expressions (e.g. MULTIPLY(0.5, alias)) yield their alias. */
export function aliasOf(v: Any | undefined, depth = 0): string | undefined {
  if (!v || depth > 4) return undefined;
  const a = v.alias;
  if (a) return a.assetRef?.key ?? guidStr(a.guid) ?? undefined;
  for (const arg of (v.expressionValue?.expressionArguments ?? []) as Any[]) {
    const r = aliasOf(arg?.value, depth + 1);
    if (r) return r;
  }
  return undefined;
}
const varRef = (p: Any): string | undefined => aliasOf(p?.colorVar?.value);

/** Reference to a shared style: assetRef key or guid; 'UNSET' = explicitly cleared (an override detached the style). */
export function styleRef(x: Any | undefined): string | undefined {
  if (!x) return undefined;
  if (x.guid?.sessionID === UNSET_ID) return 'UNSET';
  return x.assetRef?.key ?? guidStr(x.guid) ?? undefined;
}

function inverse(m: Any): number[] | undefined {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  const a = m.m11 / det, b = -m.m01 / det, d = -m.m10 / det, e = m.m00 / det;
  return [a, b, -(a * m.m02 + b * m.m12), d, e, -(d * m.m02 + e * m.m12)];
}
const apply = (t: number[], x: number, y: number): [number, number] => [t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]];

export function convertPaints(list: Any[] | undefined, ctx: Ctx, track: boolean): Paint[] {
  const out: Paint[] = [];
  for (const p of list ?? []) {
    if (!p || p.visible === false) continue;
    const t: string = p.type;
    const bm = blendOf(p.blendMode);
    if (t === 'SOLID') {
      const c = colorHex(p.color ?? { r: 0, g: 0, b: 0 }, p.opacity ?? 1, ctx.p3);
      const v = varRef(p);
      if (!v && track) ctx.usage('color', c);
      const sp: Paint = v ? { k: 'solid', c, v } : { k: 'solid', c };
      if (bm) sp.bm = bm;
      out.push(sp);
    } else if (t.startsWith('GRADIENT')) {
      const stops: [string, number][] = (p.stops ?? []).map((s: Any) => [colorHex(s.color, p.opacity ?? 1, ctx.p3), Math.round((s.position ?? 0) * 1000) / 1000]);
      const m = p.transform;
      let a: number | undefined;
      let hp: number[] | undefined;
      const kind = t === 'GRADIENT_LINEAR' ? 'linear' : t === 'GRADIENT_ANGULAR' ? 'angular' : t === 'GRADIENT_DIAMOND' ? 'diamond' : 'radial';
      if (m && typeof m.m00 === 'number') {
        // the paint transform maps the node's unit square to gradient space; the handles are its inverse applied to the gradient's points
        const inv = inverse(m);
        if (inv) {
          const dx = inv[0], dy = inv[3];
          a = Math.round((Math.atan2(-dx, -dy) * 180) / Math.PI);
          hp = kind === 'linear'
            ? [...apply(inv, 0, 0.5), ...apply(inv, 1, 0.5)].map(r4)
            : [...apply(inv, 0.5, 0.5), ...apply(inv, 1, 0.5), ...apply(inv, 0.5, 1)].map(r4);
        }
      }
      const gp: Paint = { k: 'grad', t: kind, stops, a, p: hp };
      if (bm) gp.bm = bm;
      out.push(gp);
    } else if (t === 'IMAGE') {
      const h = bytesHex(p.image?.hash);
      const asset = h ? ctx.imageMap[h] : undefined;
      // Kiwi STRETCH is Figma's "Crop": paint.transform maps the node's unit square to the visible part of the image
      const mode = p.imageScaleMode === 'FIT' ? 'contain' : p.imageScaleMode === 'STRETCH' ? 'crop' : p.imageScaleMode === 'TILE' ? 'tile' : 'cover';
      if (!asset) ctx.warn('image fill without file in the archive (placeholder)');
      const img: Paint & { k: 'img' } = { k: 'img', asset, mode, url: asset ? undefined : `image:${h.slice(0, 12)}` };
      const m = p.transform;
      if (mode === 'crop' && m && typeof m.m00 === 'number') img.tf = [m.m00, m.m01, m.m02, m.m10, m.m11, m.m12].map((x: number) => r4(x));
      if (typeof p.opacity === 'number' && p.opacity < 1) img.o = r3(p.opacity);
      if (bm) img.bm = bm;
      out.push(img);
    } else if (t === 'EMOJI' || t === 'VIDEO') ctx.warn(`paint type ${t} not supported`);
    else ctx.warn(`unknown paint type ${t}`);
  }
  return out;
}

export function convertEffects(list: Any[] | undefined, ctx: Ctx): NonNullable<Styles['fx']> {
  const out: NonNullable<Styles['fx']> = [];
  for (const e of list ?? []) {
    if (!e || e.visible === false) continue;
    const t = e.type as string;
    if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') out.push({ k: 'shadow', x: e.offset?.x, y: e.offset?.y, blur: e.radius, spread: e.spread || undefined, c: e.color ? colorHex(e.color, 1, ctx.p3) : undefined, inner: t === 'INNER_SHADOW' || undefined });
    else if (t === 'BACKGROUND_BLUR') out.push({ k: 'bgblur', blur: e.radius });
    else if (t === 'FOREGROUND_BLUR') out.push({ k: 'blur', blur: e.radius });
    else ctx.warn(`effect type ${t} not supported (ignored)`);
  }
  return out;
}

export const AI: Record<string, string> = { MIN: '', CENTER: 'center', MAX: 'end', BASELINE: 'baseline', STRETCH: 'stretch' };
// SPACE_EVENLY (3) is the original encoding of Figma's "space between" (auto spacing); SPACE_AROUND/SPACE_EVENLY_CSS are CSS-like (2026)
export const JC: Record<string, string> = { MIN: '', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between', SPACE_EVENLY: 'between', SPACE_AROUND: 'around', SPACE_EVENLY_CSS: 'evenly' };

/** Variable fields (VariableField enum) -> keys of Styles.vars */
const VAR_KEYS: Record<string, string> = {
  CORNER_RADIUS: 'radius', RECTANGLE_TOP_LEFT_CORNER_RADIUS: 'r-tl', RECTANGLE_TOP_RIGHT_CORNER_RADIUS: 'r-tr',
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: 'r-br', RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: 'r-bl',
  STACK_SPACING: 'gap', STACK_COUNTER_SPACING: 'row-gap', STACK_PADDING_LEFT: 'pad-left', STACK_PADDING_TOP: 'pad-top',
  STACK_PADDING_RIGHT: 'pad-right', STACK_PADDING_BOTTOM: 'pad-bottom', WIDTH: 'width', HEIGHT: 'height',
  MIN_WIDTH: 'min-width', MAX_WIDTH: 'max-width', MIN_HEIGHT: 'min-height', MAX_HEIGHT: 'max-height',
  FONT_FAMILY: 'font-family', FONT_STYLE: 'font-style', FONT_SIZE: 'font-size', LINE_HEIGHT: 'line-height', LETTER_SPACING: 'letter-spacing',
  PARAGRAPH_SPACING: 'paragraph-spacing', PARAGRAPH_INDENT: 'paragraph-indent', OPACITY: 'opacity', STROKE_WEIGHT: 'stroke-weight',
  BORDER_TOP_WEIGHT: 'border-top', BORDER_RIGHT_WEIGHT: 'border-right', BORDER_BOTTOM_WEIGHT: 'border-bottom', BORDER_LEFT_WEIGHT: 'border-left',
  TEXT_DATA: 'text', VISIBLE: 'visible', GRID_ROW_GAP: 'grid-row-gap', GRID_COLUMN_GAP: 'grid-column-gap',
};
const PROP_FIELD: Record<string, string> = { VISIBLE: 'V', TEXT_DATA: 'T', OVERRIDDEN_SYMBOL_ID: 'S', SLOT_CONTENT_ID: 'C' };

/**
 * Variable bindings of a node or override: the legacy `variableConsumptionMap` first, then `parameterConsumptionMap`, whose entries
 * replace legacy ones per field. An entry without a value (or with a non-alias value) clears the binding (null).
 * PROP_REF entries are component-property references (newer files store slot/visibility/text refs only there).
 */
export function bindingsOf(n: Any): { vars: Record<string, string | null>; props: Record<string, string> } {
  const vars: Record<string, string | null> = {};
  const props: Record<string, string> = {};
  for (const map of [n.variableConsumptionMap, n.parameterConsumptionMap]) {
    for (const e of (map?.entries ?? []) as Any[]) {
      const vd = e?.variableData;
      if (vd?.dataType === 'PROP_REF') {
        const f = PROP_FIELD[String(e.variableField)];
        const def = vd.value?.propRefValue?.defId ?? vd.value?.propRefValue?.defID;
        if (f && def) props[f] = guidStr(def)!;
        continue;
      }
      const key = VAR_KEYS[String(e?.variableField)];
      if (!key) continue;
      vars[key] = aliasOf(vd?.value) ?? null;
    }
  }
  return { vars, props };
}

/**
 * Line height as a multiplier of the font size. `null` = Figma's "Auto" ({100, PERCENT}): the font's normal line height.
 * Other PERCENT values are relative to the font's natural line height; without it (`natural` undefined) they stay as "125%",
 * resolved later against the consumer's font (shared styles, overrides).
 */
export function lineHeightOf(lh: Any | undefined, fs: number | undefined, natural?: number): number | string | null | undefined {
  if (!lh || typeof lh.value !== 'number') return undefined;
  if (lh.units === 'PIXELS') return fs ? r3(lh.value / fs) : `${r2(lh.value)}px`;
  if (lh.units === 'PERCENT') {
    if (Math.abs(lh.value - 100) < 1e-6) return null;
    // a percentage of the font's natural line height (REST "INTRINSIC_%")
    return natural === undefined ? `${r3(lh.value)}%` : r3((lh.value / 100) * natural);
  }
  // RAW: a multiplier of the font size (what the UI shows as "140%")
  return r3(lh.value);
}
export function letterSpacingOf(ls: Any | undefined, fs: number | undefined): number | string | null | undefined {
  if (!ls || typeof ls.value !== 'number') return undefined;
  if (!ls.value) return null;
  if (ls.units === 'PERCENT') return fs ? r2((ls.value * fs) / 100) : `${r3(ls.value)}%`;
  return r3(ls.value);
}

const lowerOrNull = (v: unknown, none: string): string | null | undefined => (v === undefined ? undefined : v === none || v == null ? null : String(v).toLowerCase());

/**
 * Typography of a TEXT node or a text-style record. `null` values mean "explicitly default" (only kept for overrides).
 * fontMetaData of derivedTextData is the font Figma actually drew: its weight and natural line height win when it matches.
 */
export function fontOf(n: Any, keepNull = false): NonNullable<Styles['font']> {
  const fs = typeof n.fontSize === 'number' ? n.fontSize : undefined;
  const metas = (n.derivedTextData?.fontMetaData ?? []) as Any[];
  const fam = n.fontName?.family, sty = n.fontName?.style;
  const meta = metas.find((m) => m?.key?.family === fam && m?.key?.style === sty);
  const nat = (meta ?? metas[0])?.fontLineHeight;
  const f: Record<string, unknown> = {};
  if (fam) f.f = fam;
  if (fs !== undefined) f.s = fs;
  if (n.fontName) { f.w = weightOf(sty, meta?.fontWeight); f.st = /italic|oblique/i.test(sty ?? '') ? 'italic' : keepNull ? null : undefined; }
  // nodes resolve against their drawn font (or a typical 1.2); style records and overrides keep the percentage for the consumer
  const lh = lineHeightOf(n.lineHeight, fs, typeof nat === 'number' ? nat : keepNull ? undefined : 1.2);
  if (lh !== undefined) f.lh = lh;
  const ls = letterSpacingOf(n.letterSpacing, fs);
  if (ls !== undefined) f.ls = ls;
  if (n.textAlignHorizontal !== undefined) f.al = n.textAlignHorizontal === 'LEFT' ? null : String(n.textAlignHorizontal).toLowerCase().replace('justified', 'justify');
  if (n.textAlignVertical !== undefined) f.va = n.textAlignVertical === 'TOP' ? null : String(n.textAlignVertical).toLowerCase();
  const deco = lowerOrNull(n.textDecoration, 'NONE');
  if (deco !== undefined) f.deco = deco === null ? null : deco.replace('strikethrough', 'line-through');
  const cs = lowerOrNull(n.textCase, 'ORIGINAL');
  if (cs !== undefined) f.case = cs;
  if (n.textTruncation !== undefined) f.trunc = n.textTruncation === 'ENDING' ? (typeof n.maxLines === 'number' && n.maxLines > 0 ? n.maxLines : true) : null;
  if (typeof nat === 'number' && nat > 0) f.nlh = r4(nat);
  // Auto line height: the pitch Figma laid the lines out with (equal on every saved line; mixed sizes give none)
  if (lh === null || (lh === undefined && n.lineHeight === undefined)) {
    const bl = ((n.derivedTextData?.baselines ?? n.textData?.baselines ?? []) as Any[]).map((b) => b?.lineHeight).filter((v): v is number => typeof v === 'number' && v > 0);
    if (bl.length && bl.every((v) => Math.abs(v - bl[0]) < 0.01)) f.lpx = r3(bl[0]);
  }
  if (n.leadingTrim !== undefined) f.trim = n.leadingTrim === 'CAP_HEIGHT' ? 'cap' : null;
  for (const k of Object.keys(f)) {
    if (f[k] === undefined || (f[k] === null && !keepNull)) delete f[k];
  }
  return f as NonNullable<Styles['font']>;
}

/** A hyperlink record: its URL, or `#<node-id>` for a link to a node; `{}` and the unset guid mean no link. */
export function linkOf(h: Any | undefined): string | undefined {
  if (!h) return undefined;
  if (typeof h.url === 'string' && h.url) return h.url;
  if (h.guid && h.guid.sessionID !== UNSET_ID) return '#' + guidStr(h.guid);
  return undefined;
}

const RUN_FONT_FIELDS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'textDecoration', 'textCase', 'leadingTrim'];

/** The style of one styleOverrideTable entry: only the fields it sets (null = explicitly the default). */
function runStyle(e: Any, base: Any, ctx: Ctx): Omit<TextRun, 'i' | 'n'> | null {
  const r: Omit<TextRun, 'i' | 'n'> = {};
  if (RUN_FONT_FIELDS.some((k) => e[k] !== undefined) || e.semanticWeight === 'BOLD' || e.semanticItalic === 'ITALIC') {
    const fs = typeof e.fontSize === 'number' ? e.fontSize : base.fontSize;
    const f: Record<string, unknown> = fontOf({
      fontName: e.fontName, fontSize: fs, lineHeight: e.lineHeight, letterSpacing: e.letterSpacing, textDecoration: e.textDecoration,
      textCase: e.textCase, leadingTrim: e.leadingTrim, derivedTextData: base.derivedTextData,
    }, true);
    if (e.fontSize === undefined) delete f.s;
    delete f.nlh; delete f.lpx;
    if (!e.fontName && e.semanticWeight === 'BOLD') f.w = 700;
    if (!e.fontName && e.semanticItalic === 'ITALIC') f.st = 'italic';
    if (Object.keys(f).length) r.font = f as TextRun['font'];
  }
  if (Array.isArray(e.fillPaints)) {
    // EMOJI paint: the characters are drawn as Figma's colour emoji images, not in a paint of their own
    const own = (e.fillPaints as Any[]).filter((p) => p?.type !== 'EMOJI');
    if (own.length < e.fillPaints.length) r.emoji = true;
    if (own.length || !r.emoji) r.fill = convertPaints(own, { ...ctx, usage: () => undefined }, false);
  }
  const link = linkOf(e.hyperlink);
  if (link) r.link = link;
  const t = styleRef(e.styleIdForText), f = styleRef(e.styleIdForFill);
  if (t && t !== 'UNSET') r.tsid = t;
  if (f && f !== 'UNSET') r.fsid = f;
  if (e.isOverrideOverTextStyle === true && r.tsid) r.ovr = true;
  return Object.keys(r).length ? r : null;
}

/** Code points of an emoji style entry (EMOJI fill paint), as a string; undefined for other entries. */
function emojiOf(e: Any): string | undefined {
  const p = ((e?.fillPaints ?? []) as Any[]).find((x) => x?.type === 'EMOJI' && x.visible !== false);
  const cps = (p?.emojiCodePoints ?? []) as number[];
  if (!p) return undefined;
  try { return cps.length ? String.fromCodePoint(...cps) : ''; } catch { return ''; }
}

/** what may follow an emoji's base code point inside the same emoji: presentation selectors, keycap, skin tone, tag characters, ZWJ + pictograph */
const EMOJI_TAIL = /(?:[\uFE0E\uFE0F\u20E3]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|\u200D\p{Extended_Pictographic})/uy;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

/**
 * Character ranges with their own style. `characterStyleIDs` holds one styleID per CODE POINT of the characters (missing
 * trailing entries = 0; octopus Complex.fig 375:16: 11 ids for "👍 Emojito 🤣", 13 UTF-16 units); a non-zero id selects the
 * `styleOverrideTable` entry with that `styleID`, 0 = the text's own style. The ranges are returned in UTF-16 units of the text.
 * `base` (the text node or override record) supplies the font size and the saved font metrics. Equal neighbours are merged.
 * Emoji: Figma keeps one table entry per emoji with an EMOJI paint and its base code point(s); only its saved glyphs refer to it
 * (not `characterStyleIDs`), so the characters are found by their code points and marked `emoji`, together with what belongs to
 * the same emoji (variation selector, keycap, skin tone, tags, ZWJ sequence). A single code point without emoji presentation
 * (⚠, ©, a keycap digit) counts only when an emoji selector (FE0F) or keycap (20E3) follows it.
 */
export function textRuns(td: Any | undefined, base: Any, ctx: Ctx): TextRun[] {
  const chars: string = typeof td?.characters === 'string' ? td.characters : '';
  const cpIds = (td?.characterStyleIDs ?? []) as number[];
  const table = (td?.styleOverrideTable ?? []) as Any[];
  if (!chars || !table.length) return [];
  // style id per UTF-16 unit (both units of a surrogate pair take the id of their code point)
  const ids: number[] = [];
  if (cpIds.length) for (let u = 0, k = 0; u < chars.length && k < cpIds.length; k++) { const n = chars.codePointAt(u)! > 0xffff ? 2 : 1; for (let x = 0; x < n; x++) ids.push(cpIds[k] ?? 0); u += n; }
  const entries = new Map<number, Any>();
  for (const e of table) if (typeof e?.styleID === 'number' && e.styleID !== 0) entries.set(e.styleID, e);
  const emo = new Uint8Array(chars.length);
  let anyEmoji = false;
  for (const [id, e] of entries) {
    const seq = emojiOf(e);
    if (seq === undefined) continue;
    for (let i = 0; i < ids.length; i++) if (ids[i] === id) { emo[i] = 1; anyEmoji = true; }
    if (!seq) continue;
    const bare = [...seq].length === 1 && !EMOJI_PRESENTATION.test(seq);
    for (let at = chars.indexOf(seq); at >= 0; at = chars.indexOf(seq, at + 1)) {
      // inside a longer emoji that an earlier match already covers, or the low half of a surrogate pair
      if (emo[at] || (at > 0 && /[\uD800-\uDBFF]/.test(chars[at - 1]))) continue;
      let j = at + seq.length;
      if (bare && !/[\uFE0F\u20E3]/.test(chars[j] ?? '')) continue;
      for (EMOJI_TAIL.lastIndex = j; EMOJI_TAIL.test(chars); EMOJI_TAIL.lastIndex = j) j = EMOJI_TAIL.lastIndex;
      emo.fill(1, at, j);
      anyEmoji = true;
    }
  }
  if (!ids.length && !anyEmoji) return [];
  const conv = new Map<number, Omit<TextRun, 'i' | 'n'> | null>();
  const out: TextRun[] = [];
  const end = anyEmoji ? chars.length : Math.min(chars.length, ids.length);
  for (let i = 0; i < end; ) {
    const id = ids[i] ?? 0;
    const em = emo[i];
    let j = i + 1;
    while (j < end && (ids[j] ?? 0) === id && emo[j] === em) j++;
    let st: Omit<TextRun, 'i' | 'n'> | null = null;
    if (id && entries.has(id)) {
      if (!conv.has(id)) conv.set(id, runStyle(entries.get(id)!, base, ctx));
      st = conv.get(id) ?? null;
    }
    if (em) { st = { ...st, emoji: true }; delete st.fill; } else if (st?.emoji) { const { emoji: _e, ...rest } = st; void _e; st = Object.keys(rest).length ? rest : null; }
    if (st) {
      const prev = out[out.length - 1];
      if (prev && prev.i + prev.n === i && JSON.stringify({ ...prev, i: 0, n: 0 }) === JSON.stringify({ i: 0, n: 0, ...st })) prev.n += j - i;
      else out.push({ i, n: j - i, ...st });
    }
    i = j;
  }
  if (out.length > 400) { ctx.warn('text with more than 400 style ranges: the rest is ignored'); out.length = 400; }
  return out;
}

/** Stroke width/alignment/dash of a node (independent of whether it has stroke paints). */
function strokeMeta(n: Any): { w?: number | number[]; align: string; dash?: number[] } {
  const w = n.strokeWeight;
  // per-side widths count only with the independent flag; a side without a value then has width 0
  const per = n.borderStrokeWeightsIndependent === true ? [n.borderTopWeight ?? 0, n.borderRightWeight ?? 0, n.borderBottomWeight ?? 0, n.borderLeftWeight ?? 0] : undefined;
  return {
    w: per ?? (typeof w === 'number' ? w : undefined),
    align: n.strokeAlign === 'INSIDE' ? 'inner' : n.strokeAlign === 'OUTSIDE' ? 'outer' : 'center',
    dash: n.dashPattern?.length ? n.dashPattern : undefined,
  };
}

/** Corner radii: with the independent flag each corner is its own field (absent = 0), otherwise cornerRadius (absent = 0). */
export function radiusOf(n: Any): number | number[] | undefined {
  if (n.rectangleCornerRadiiIndependent === true) {
    const r = [n.rectangleTopLeftCornerRadius ?? 0, n.rectangleTopRightCornerRadius ?? 0, n.rectangleBottomRightCornerRadius ?? 0, n.rectangleBottomLeftCornerRadius ?? 0].map(r2);
    if (!r.some((x) => x > 0)) return undefined;
    return new Set(r).size === 1 ? r[0] : r;
  }
  return typeof n.cornerRadius === 'number' && n.cornerRadius > 0 ? r2(n.cornerRadius) : undefined;
}

/** Rotation (counter-clockwise degrees about the origin) and mirroring of a 2x3 transform. */
export function transformOf(tr: Any): { rot?: number; flip?: 'x' | 'y'; m?: number[] } {
  const det = tr.m00 * tr.m11 - tr.m01 * tr.m10;
  const out: { rot?: number; flip?: 'x' | 'y'; m?: number[] } = {};
  const deg = (v: number) => Math.round(((v * 180) / Math.PI) * 100) / 100;
  if (det >= 0) {
    const rot = deg(-Math.atan2(tr.m10, tr.m00));
    if (rot) out.rot = rot;
    // skew or non-unit scale cannot be expressed as rotation: keep the matrix for the renderer
    const skew = Math.abs(tr.m00 * tr.m01 + tr.m10 * tr.m11) > 1e-4 || Math.abs(Math.hypot(tr.m00, tr.m10) - 1) > 1e-4 || Math.abs(Math.hypot(tr.m01, tr.m11) - 1) > 1e-4;
    if (skew) out.m = [tr.m00, tr.m01, tr.m10, tr.m11].map(r4);
    return out;
  }
  // M = R(theta) * diag(-1, 1): mirrored horizontally in its own coordinates, then rotated
  let rot = deg(-Math.atan2(-tr.m10, -tr.m00));
  if (Math.abs(Math.abs(rot) - 180) < 0.01) { out.flip = 'y'; rot = 0; } else out.flip = 'x';
  if (rot) out.rot = rot;
  out.m = [tr.m00, tr.m01, tr.m10, tr.m11].map(r4);
  return out;
}

export interface PropDef { owner: string; id: string; name: string; type: string; initial: unknown; parent: string | null }
export interface GeomRef { blob: number; rule?: string; sid?: number }
/** `r` = text ranges with their own style references */
export interface StyleUse { t?: string; f?: string; s?: string; e?: string; r?: boolean }
export interface StyleDef { name: string; type: string; font?: NonNullable<Styles['font']>; fill?: Paint[]; fx?: NonNullable<Styles['fx']> }
export interface DerivedOut { p: string; w?: number; h?: number; x?: number; y?: number; ns?: boolean; g?: GeomRef[]; sg?: GeomRef[] }

export interface Converted {
  derived?: DerivedOut[];
  propdefs?: PropDef[];
  row: NodeRow;
  geomRefs?: GeomRef[];
  /** for the end-of-stream pass that needs the parent's stack direction */
  childFlags?: { grow: boolean; stretch: boolean };
  stackMode?: string;
  parent: string | null;
  pos: string | null;
  /** shared styles this node refers to (resolved after the stream: style records may come later) */
  styleUse?: StyleUse;
  /** this record is a shared style definition */
  styleDef?: StyleDef;
  /** text bound to a variable (resolved after the stream) */
  textVar?: string;
}

/**
 * Component property values in one typed shape (ported semantics of open-pencil's `assignmentValue`):
 * bool | string | number | {sym: component id} | {slot: content id}. `null` = no value / the default slot content.
 */
export function typedValue(x: Any | undefined): unknown {
  if (!x) return null;
  if (x.boolValue !== undefined) return x.boolValue;
  const text = x.textDataValue?.characters ?? x.textValue?.characters ?? (typeof x.textValue === 'string' ? x.textValue : undefined);
  if (text !== undefined) return text;
  const sym = x.symbolIdValue?.guid ?? x.guidValue;
  if (sym) return { sym: guidStr(sym) };
  const slot = x.slotContentIdValue?.guid;
  if (slot) return slot.sessionID === UNSET_ID ? null : { slot: guidStr(slot) };
  if (x.floatValue !== undefined) return x.floatValue;
  return null;
}
const hasValue = (v: Any | undefined): boolean => !!v && (v.boolValue !== undefined || v.textValue !== undefined || v.guidValue !== undefined || v.textDataValue !== undefined || v.symbolIdValue !== undefined || v.slotContentIdValue !== undefined || v.floatValue !== undefined);
/** An assignment or definition carries its value either plain (`value`/`initialValue`) or typed (`varValue.value`); the plain form wins when it has content. */
const propVal = (a: Any): unknown => (hasValue(a.value) ? typedValue(a.value) : typedValue(a.varValue?.value));
export const propDefault = (d: Any): unknown => (hasValue(d.initialValue) ? typedValue(d.initialValue) : typedValue(d.varValue?.value));

const LAYOUT_OV_FIELDS = ['stackMode', 'stackPrimarySizing', 'stackCounterSizing', 'stackPositioning', 'stackChildPrimaryGrow', 'stackChildAlignSelf', 'stackSpacing',
  'stackHorizontalPadding', 'stackVerticalPadding', 'stackPaddingRight', 'stackPaddingBottom', 'stackPrimaryAlignItems', 'stackCounterAlignItems', 'textAutoResize', 'stackWrap'];

/** One symbolOverride as a compact override record (see overrides.ts `Ov`). Absent fields inherit; explicit defaults are kept as null/false. */
export function convertOverride(o: Any, ctx: Ctx): Any | null {
  const path = (o.guidPath?.guids ?? []).map(guidStr).join('/');
  const nu: Ctx = { ...ctx, usage: () => undefined };
  const e: Any = { p: path };
  if (o.textData?.characters !== undefined) e.t = String(o.textData.characters).slice(0, 2000);
  // new characters come with their own ranges (none = the text's own style throughout)
  const runs = o.textData?.characters !== undefined ? textRuns(o.textData, o, nu) : undefined;
  if (o.visible === false) e.hidden = true;
  if (o.visible === true) e.show = true;
  const ovm = o.variableModeBySetMap?.entries as Any[] | undefined;
  if (ovm?.length) e.vm = ovm.map((m) => ({ s: m.variableSetID?.assetRef?.key ?? guidStr(m.variableSetID?.guid), m: guidStr(m.variableModeID) }));
  if (o.overriddenSymbolID) e.swap = guidStr(o.overriddenSymbolID);
  if (o.componentPropAssignments?.length) {
    e.pa = {};
    for (const a of o.componentPropAssignments) e.pa[guidStr(a.defID)!] = propVal(a);
  }
  const st: Any = {};
  if (Array.isArray(o.fillPaints)) st.fill = convertPaints(o.fillPaints, nu, false);
  if (Array.isArray(o.strokePaints)) st.stroke = { paints: convertPaints(o.strokePaints, nu, false) };
  // stroke geometry fields apply to whatever stroke the target has
  const sp: Any = {};
  if (typeof o.strokeWeight === 'number') sp.w = o.strokeWeight;
  if (o.strokeAlign !== undefined) sp.align = o.strokeAlign === 'INSIDE' ? 'inner' : o.strokeAlign === 'OUTSIDE' ? 'outer' : 'center';
  if (Array.isArray(o.dashPattern)) sp.dash = o.dashPattern.length ? o.dashPattern : null;
  for (const [k, f] of [['ind', 'borderStrokeWeightsIndependent'], ['t', 'borderTopWeight'], ['r', 'borderRightWeight'], ['b', 'borderBottomWeight'], ['l', 'borderLeftWeight']] as const) {
    if (o[f] !== undefined) (sp.bw ??= {})[k] = o[f];
  }
  if (Object.keys(sp).length) e.sp = sp;
  const rc: Any = {};
  for (const [k, f] of [['cr', 'cornerRadius'], ['tl', 'rectangleTopLeftCornerRadius'], ['tr', 'rectangleTopRightCornerRadius'], ['br', 'rectangleBottomRightCornerRadius'], ['bl', 'rectangleBottomLeftCornerRadius'], ['ind', 'rectangleCornerRadiiIndependent']] as const) {
    if (o[f] !== undefined) rc[k] = o[f];
  }
  if (Object.keys(rc).length) e.rc = rc;
  if (typeof o.opacity === 'number') st.op = r3(o.opacity);
  if (Array.isArray(o.effects)) st.fx = convertEffects(o.effects, nu);
  if (typeof o.frameMaskDisabled === 'boolean') st.clip = !o.frameMaskDisabled;
  const font = fontOf(o, true);
  // the override's own saved metrics count only with its own font (else the target's font decides)
  if (!o.fontName) { delete font.nlh; delete font.lpx; }
  if (Object.keys(font).length) st.font = font;
  if (runs?.length) st.runs = runs;
  const link = linkOf(o.hyperlink);
  if (link) st.link = link;
  else if (o.hyperlink !== undefined) st.link = null; // `{}` / unset guid: the override removes the component's link
  const blend = blendOf(o.blendMode);
  if (blend) st.blend = blend;
  else if (o.blendMode === 'NORMAL' || o.blendMode === 'PASS_THROUGH') st.blend = null;
  if (Object.keys(st).length) e.st = st;
  // shared styles (resolved after the stream: the style record may come later)
  const sid = styleRef(o.styleIdForText), fsid = styleRef(o.styleIdForFill), ssid = styleRef(o.styleIdForStrokeFill), esid = styleRef(o.styleIdForEffect);
  if (sid) e.sid = sid;
  if (fsid) e.fsid = fsid;
  if (ssid) e.ssid = ssid;
  if (esid) e.esid = esid;
  // layout fields, interpreted against the target and its parent when the instance is evaluated
  const lo: Any = {};
  for (const f of LAYOUT_OV_FIELDS) if (o[f] !== undefined) lo[f] = o[f];
  if (Object.keys(lo).length) e.lo = lo;
  if (o.size && typeof o.size.x === 'number' && o.guidPath) e.sz = { w: r2(o.size.x), h: r2(o.size.y) };
  const b = bindingsOf(o);
  if (Object.keys(b.vars).length) e.vb = b.vars;
  return Object.keys(e).length > 1 ? e : null;
}

export function convertNode(n: Any, ctx: Ctx): Converted {
  const id = guidStr(n.guid)!;
  const isGroup = n.type === 'FRAME' && n.resizeToFit === true;
  const type: NodeType = isGroup ? 'group' : TYPE_MAP[n.type] ?? 'other';
  if (!(n.type in TYPE_MAP)) ctx.warn(`unknown node type ${n.type} (mapped to other)`);
  const tr = n.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
  const size = n.size ?? { x: 0, y: 0 };
  const styles: Styles = {};
  const layout: Layout = {};
  const raw: Record<string, unknown> = {};

  // transform: translation is the node origin in the parent; rotation (counter-clockwise) and mirroring come from the matrix
  const tf = transformOf(tr);
  if (tf.rot) styles.rot = tf.rot;
  if (tf.flip) styles.flip = tf.flip;
  if (tf.m) raw.m = tf.m;

  const bind = bindingsOf(n);
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(bind.vars)) if (v) vars[k] = v;

  // sizing rules: own auto-layout axes
  const stack = n.stackMode && n.stackMode !== 'NONE' && !isGroup ? (n.stackMode as string) : undefined;
  // absent primary sizing = hug (Figma omits its default); absent counter sizing = fixed
  const hugP = n.stackPrimarySizing === undefined || String(n.stackPrimarySizing).startsWith('RESIZE_TO_FIT');
  const hugC = typeof n.stackCounterSizing === 'string' && n.stackCounterSizing.startsWith('RESIZE_TO_FIT');
  if (stack === 'GRID') {
    layout.dir = 'grid';
  } else if (stack) {
    layout.dir = stack === 'HORIZONTAL' ? 'row' : 'col';
    if (n.stackSpacing && n.stackPrimaryAlignItems !== 'SPACE_EVENLY' && n.stackPrimaryAlignItems !== 'SPACE_BETWEEN') layout.gap = r2(n.stackSpacing);
    if (stack === 'HORIZONTAL') { if (hugP) layout.w = 'hug'; if (hugC) layout.h = 'hug'; } else { if (hugP) layout.h = 'hug'; if (hugC) layout.w = 'hug'; }
    const jc = JC[n.stackPrimaryAlignItems ?? 'MIN'];
    if (jc) layout.jc = jc;
    const ai = AI[n.stackCounterAlignItems ?? 'MIN'];
    if (ai) layout.ai = ai;
    if (n.stackWrap === 'WRAP') layout.wrap = true;
    if (typeof layout.gap === 'number' && !vars.gap) ctx.usage('gap', String(Math.round(layout.gap)));
  }
  if (stack) {
    // trailing paddings that Figma left out are 0, not a mirror of the leading ones
    const pad = [n.stackVerticalPadding ?? 0, n.stackPaddingRight ?? 0, n.stackPaddingBottom ?? 0, n.stackHorizontalPadding ?? 0].map(r2);
    if (pad.some((v) => v)) layout.pad = pad;
    for (const v of new Set(pad)) if (v) ctx.usage('pad', String(Math.round(v)));
  }
  if (n.stackPositioning === 'ABSOLUTE') layout.abs = true;
  // paint order only (layout order unchanged): the first child is drawn on top
  if (n.stackReverseZIndex === true && n.stackMode && n.stackMode !== 'NONE') raw.revZ = true;

  // shared styles referenced by this node
  const use: StyleUse = {};
  const tRef = styleRef(n.styleIdForText), fRef = styleRef(n.styleIdForFill), sRef = styleRef(n.styleIdForStrokeFill), eRef = styleRef(n.styleIdForEffect);
  if (tRef && tRef !== 'UNSET') use.t = tRef;
  if (fRef && fRef !== 'UNSET') use.f = fRef;
  if (sRef && sRef !== 'UNSET') use.s = sRef;
  if (eRef && eRef !== 'UNSET') use.e = eRef;

  // fills / strokes / effects
  let fill = convertPaints(n.fillPaints, ctx, !use.f);
  let stroke = convertPaints(n.strokePaints, ctx, false);
  const geomRefs: GeomRef[] = [];
  const isGeom = GEOMETRY_TYPES.has(n.type);
  // an ellipse arc (progress ring, pie) is only correct as Figma's saved outline
  const arc = n.arcData;
  const isArc = n.type === 'ELLIPSE' && arc && ((arc.startingAngle ?? 0) !== 0 || Math.abs((arc.endingAngle ?? 2 * Math.PI) - 2 * Math.PI) > 1e-3 || (arc.innerRadius ?? 0) > 0);
  if (isGeom || isArc) {
    let src: Any[] = n.fillGeometry ?? [];
    // (the stroke paint may come only from a stroke style, resolved after the stream)
    if (!src.length && !fill.length && (stroke.length || use.s) && n.strokeGeometry?.length && !use.f) {
      // stroke-only vector (typical for icons): the stroke outline is the shape to fill with the stroke color
      src = n.strokeGeometry; fill = stroke; stroke = []; raw.geometryFrom = 'stroke';
      if (typeof n.strokeWeight === 'number') raw.outlineW = n.strokeWeight;
    }
    for (const g of src) if (typeof g.commandsBlob === 'number') geomRefs.push({ blob: g.commandsBlob, rule: g.windingRule, sid: g.styleID || undefined });
    raw.viewBox = [0, 0, size.x, size.y];
    if (src[0]?.windingRule === 'ODD') raw.fillRule = 'evenodd';
    if (isArc) raw.arc = [r4(arc.startingAngle ?? 0), r4(arc.endingAngle ?? 2 * Math.PI), r4(arc.innerRadius ?? 0)];
    // per-region paints of a vector (styleOverrideTable): an entry with fillPaints [] leaves its region unfilled
    const regions: Record<string, Paint[]> = {};
    for (const s of (n.vectorData?.styleOverrideTable ?? []) as Any[]) {
      if (typeof s?.styleID === 'number' && Array.isArray(s.fillPaints)) regions[s.styleID] = convertPaints(s.fillPaints, ctx, false);
    }
    if (Object.keys(regions).length && geomRefs.some((g) => g.sid && regions[g.sid])) raw.regions = regions;
  }
  if (n.type === 'REGULAR_POLYGON' && typeof n.count === 'number') raw.polygonCount = n.count;
  if (fill.length) styles.fill = fill;
  if ((stroke.length || use.s) && raw.geometryFrom !== 'stroke') {
    const m = strokeMeta(n);
    styles.stroke = { paints: stroke, w: m.w, align: m.align, dash: m.dash };
  }
  // corners: baked into the outline of vectors, stars, polygons and boolean shapes
  if (!isGeom) {
    const r = radiusOf(n);
    if (r !== undefined) {
      styles.r = r;
      if (!vars.radius && !vars['r-tl']) for (const x of new Set(Array.isArray(r) ? r : [r])) if (x) ctx.usage('radius', String(Math.round(x)));
    }
  }
  if (typeof n.opacity === 'number' && n.opacity < 1) styles.op = r3(n.opacity);
  const blend = blendOf(n.blendMode);
  if (blend) styles.blend = blend;
  // groups (FRAME + resizeToFit) never clip
  if ((n.type === 'FRAME' || n.type === 'SYMBOL' || n.type === 'INSTANCE') && n.frameMaskDisabled !== true && !isGroup) styles.clip = true;
  const fx = convertEffects(n.effects, ctx);
  if (fx.length) styles.fx = fx;

  // text
  let text: string | null = null;
  if (n.type === 'TEXT' || n.type === 'TEXT_PATH' || n.type === 'STICKY' || n.type === 'SHAPE_WITH_TEXT' || n.type === 'CODE_BLOCK') {
    text = n.textData?.characters ?? null;
    styles.font = fontOf(n);
    if (!use.t) {
      if (typeof n.fontSize === 'number') ctx.usage('fontSize', String(n.fontSize));
      if (n.fontName?.family) ctx.usage('font', n.fontName.family);
    }
    const tar = n.textAutoResize;
    if (tar === 'WIDTH_AND_HEIGHT') { layout.w = 'hug'; layout.h = 'hug'; } else if (tar === 'HEIGHT') layout.h = 'hug';
    const runs = textRuns(n.textData, n, ctx);
    if (runs.length) {
      styles.runs = runs;
      if (runs.some((r) => r.tsid || r.fsid)) use.r = true;
    }
    const link = linkOf(n.hyperlink);
    if (link) styles.link = link;
    // list lines: bullets/numbers are not part of the characters
    const lines = (n.textData?.lines ?? []) as Any[];
    if (lines.some((l) => l?.lineType === 'ORDERED_LIST' || l?.lineType === 'UNORDERED_LIST')) {
      raw.list = lines.slice(0, 60).map((l) => {
        const k = l?.lineType === 'ORDERED_LIST' ? 'ol' : l?.lineType === 'UNORDERED_LIST' ? 'ul' : '-';
        const lvl = l?.indentationLevel ?? 0;
        return k !== '-' && lvl > 1 ? `${k}${lvl}` : k;
      }).join(',');
    }
    if (n.type === 'TEXT_PATH') raw.textPath = true;
  }
  if (Object.keys(vars).length) styles.vars = vars;

  // component / instance specifics
  let componentRef: string | null = null;
  if (n.type === 'INSTANCE') {
    componentRef = guidStr(n.symbolData?.symbolID);
    // the instance shows its component scaled by this factor (Figma "scale" tool); saved derived data comes on top
    const usf = n.symbolData?.uniformScaleFactor;
    if (typeof usf === 'number' && isFinite(usf) && usf > 0 && Math.abs(usf - 1) > 1e-6) raw.usf = Math.round(usf * 1e6) / 1e6;
    const ov: Any[] = [];
    for (const o of (n.symbolData?.symbolOverrides ?? []) as Any[]) {
      const e = convertOverride(o, ctx);
      if (e) ov.push(e);
    }
    if (ov.length > 1000) ctx.warn('instance with more than 1000 overrides: the rest is ignored');
    if (ov.length) raw.overrides = ov.slice(0, 1000);
    const pa = n.componentPropAssignments as Any[] | undefined;
    if (pa?.length) {
      const props: Record<string, unknown> = {};
      for (const a of pa) props[guidStr(a.defID)!] = propVal(a);
      raw.props = props;
      raw.pid = props;
    }
  }
  // properties of the enclosing component that drive fields of this node: V=visible, T=text, S=instance swap, C=slot content
  const FIELD: Record<string, string> = { VISIBLE: 'V', TEXT_DATA: 'T', OVERRIDDEN_SYMBOL_ID: 'S', SLOT_CONTENT_ID: 'C' };
  for (const ref of (n.componentPropRefs ?? []) as Any[]) {
    if (ref.isDeleted || !ref.defID) continue;
    const f = FIELD[String(ref.componentPropNodeField)];
    if (f) { const refs = (raw.refs ??= {}) as Record<string, string>; refs[f] = guidStr(ref.defID)!; }
  }
  // newer files keep these references only as PROP_REF entries of parameterConsumptionMap
  for (const [f, def] of Object.entries(bind.props)) {
    const refs = (raw.refs ??= {}) as Record<string, string>;
    if (!refs[f]) refs[f] = def;
  }
  // explicit variable modes of this frame: they decide what mode-dependent ("contextual") tokens resolve to below it
  const vmEntries = n.variableModeBySetMap?.entries as Any[] | undefined;
  if (vmEntries?.length) raw.vm = vmEntries.map((e) => ({ s: e.variableSetID?.assetRef?.key ?? guidStr(e.variableSetID?.guid), m: guidStr(e.variableModeID) }));
  const derived: DerivedOut[] = [];
  if (n.type === 'INSTANCE') {
    // Figma's saved layout of the instance content (cache, not an override): effective size, position and outlines per path
    const refsOf = (list: Any[] | undefined): GeomRef[] => ((list ?? []) as Any[]).filter((x) => typeof x.commandsBlob === 'number').map((x) => ({ blob: x.commandsBlob as number, rule: x.windingRule as string | undefined, sid: x.styleID || undefined }));
    for (const d of (n.derivedSymbolData ?? []) as Any[]) {
      const path = (d.guidPath?.guids ?? []).map(guidStr).join('/');
      const g = refsOf(d.fillGeometry);
      const sg = refsOf(d.strokeGeometry);
      // Figma saved an empty stroke outline for this occurrence: whatever stroke the component declares is not drawn
      const ns = Array.isArray(d.strokeGeometry) && d.strokeGeometry.length === 0;
      if (!path || (!d.size && !d.transform && !g.length && !ns && !sg.length)) continue;
      const e: DerivedOut = { p: path };
      if (ns) e.ns = true;
      if (g.length) e.g = g;
      if (sg.length) e.sg = sg;
      if (d.size) { e.w = r2(d.size.x); e.h = r2(d.size.y); }
      if (d.transform) { e.x = r2(d.transform.m02); e.y = r2(d.transform.m12); }
      derived.push(e);
    }
  }
  const propdefs: PropDef[] = [];
  for (const d of (n.componentPropDefs ?? []) as Any[]) {
    if (!d.id) continue;
    propdefs.push({ owner: id, id: guidStr(d.id)!, name: d.name ?? '', type: String(d.type ?? ''), initial: propDefault(d), parent: d.parentPropDefId ? guidStr(d.parentPropDefId) : null });
  }
  if (n.overrideKey) raw.ok = guidStr(n.overrideKey);
  if (n.isStateGroup) raw.isComponentSet = true;
  if (n.mask) {
    raw.mask = true;
    const mt = n.maskType ?? (n.maskIsOutline === true ? 'OUTLINE' : undefined);
    if (mt && mt !== 'ALPHA') raw.maskType = mt;
  }
  // constraints of absolutely positioned layers (MIN = left/top is the default and never stored)
  if (n.horizontalConstraint && n.horizontalConstraint !== 'MIN') raw.hConstraint = n.horizontalConstraint;
  if (n.verticalConstraint && n.verticalConstraint !== 'MIN') raw.vConstraint = n.verticalConstraint;
  if (n.devStatus?.type) raw.devStatus = n.devStatus.type;

  const row: NodeRow = {
    id, parent_id: guidStr(n.parentIndex?.guid), page: 0, type, name: n.name ?? '', depth: 0, ord: 0,
    x: r2(tr.m02), y: r2(tr.m12), w: r2(size.x), h: r2(size.y),
    layout: Object.keys(layout).length ? layout : null,
    styles: Object.keys(styles).length ? styles : null,
    text, component_ref: componentRef, visible: n.visible !== false, raw: Object.keys(raw).length ? raw : null,
    pos: n.parentIndex?.position ?? null,
  };
  const grow = typeof n.stackChildPrimaryGrow === 'number' && n.stackChildPrimaryGrow > 0;
  const stretch = n.stackChildAlignSelf === 'STRETCH';

  // a shared style definition (text/fill/effect style record)
  let styleDef: StyleDef | undefined;
  const stype = n.styleType as string | undefined;
  if (stype && stype !== 'NONE') {
    const nu: Ctx = { ...ctx, usage: () => undefined };
    styleDef = { name: n.name ?? '', type: stype };
    if (stype === 'TEXT') {
      // the style decides these fields completely: a field it leaves out is its default (no decoration, original case, no tracking)
      const f: Record<string, unknown> = fontOf(n, true);
      for (const k of ['nlh', 'lpx', 'al', 'va', 'trunc']) delete f[k];
      // a percentage refers to the natural line height of the consumer's drawn font: resolved when the style is applied
      const lh = lineHeightOf(n.lineHeight, typeof n.fontSize === 'number' ? n.fontSize : undefined);
      if (typeof lh === 'string' && lh.endsWith('%')) f.lh = lh;
      for (const k of ['deco', 'case', 'ls', 'st']) if (f[k] === undefined) f[k] = null;
      styleDef.font = f as NonNullable<Styles['font']>;
    }
    if (stype === 'FILL' || stype === 'STROKE') styleDef.fill = convertPaints(n.fillPaints, nu, false);
    if (stype === 'EFFECT') styleDef.fx = convertEffects(n.effects, nu);
  }
  return {
    row, geomRefs: geomRefs.length ? geomRefs : undefined, childFlags: grow || stretch ? { grow, stretch } : undefined,
    derived: derived.length ? derived : undefined, propdefs: propdefs.length ? propdefs : undefined,
    stackMode: stack, parent: row.parent_id, pos: row.pos ?? null,
    styleUse: Object.keys(use).length ? use : undefined, styleDef,
    textVar: vars.text && (type === 'text') ? vars.text : undefined,
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

/**
 * Geometry table value for a list of outlines. One plain path when all regions share the node paint and the winding rule;
 * otherwise JSON `[[d, rule, styleID], …]` (rule 'evenodd' or '', styleID 0 = node paint) so each region keeps its own.
 */
export function geometryData(parts: { d: string; rule?: string; sid?: number }[]): string {
  const ps = parts.filter((p) => p.d);
  if (!ps.length) return '';
  const rules = new Set(ps.map((p) => (p.rule === 'ODD' ? 'evenodd' : '')));
  if (rules.size === 1 && !ps.some((p) => p.sid)) return ps.map((p) => p.d).join('');
  return JSON.stringify(ps.map((p) => [p.d, p.rule === 'ODD' ? 'evenodd' : '', p.sid ?? 0]));
}
/** Parses a geometry table value (plain path data or the region JSON of `geometryData`). */
export function parseGeometry(data: string): { d: string; rule: string; sid: number }[] {
  if (data.startsWith('[')) {
    try { return (JSON.parse(data) as [string, string, number][]).map(([d, rule, sid]) => ({ d, rule, sid })); } catch { /* plain */ }
  }
  return [{ d: data, rule: '', sid: 0 }];
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
