// Instance overrides in one shape, shared by `spec` and the renderer.
// fig: raw.overrides (from symbolOverrides), pen: raw.descendants (property overrides of a `ref`).
import type { Paint, Styles } from './model.js';

export interface Ov {
  /** path of ids/override keys inside the component; "" = the instance itself */
  p: string;
  t?: string;
  hidden?: boolean;
  /** explicitly made visible although the component hides it by default */
  show?: boolean;
  swap?: string;
  pa?: Record<string, unknown>;
  st?: Styles;
  sz?: { w: number; h: number };
  /** explicit variable modes set on the target (variable set key/id, mode id) */
  vm?: { s: string; m: string }[];
  /** stroke geometry fields (fig): width, alignment, dash (null = solid), per-side border widths with the independent flag */
  sp?: { w?: number; align?: string; dash?: number[] | null; bw?: { ind?: boolean; t?: number; r?: number; b?: number; l?: number } };
  /** corner fields (fig): cornerRadius, per-corner radii, independent flag (absent = inherit) */
  rc?: { cr?: number; tl?: number; tr?: number; br?: number; bl?: number; ind?: boolean };
  /** auto-layout and text-resize fields (fig NodeChange names), interpreted against the target and its parent */
  lo?: Record<string, unknown>;
  /** variable bindings (Styles.vars keys); null = binding cleared */
  vb?: Record<string, string | null>;
}

export const lastKey = (p: string): string => p.split('/').pop() ?? '';

/**
 * Applies style fields of `b` over `a`. Fields absent in `b` inherit. Explicit "default" values clear: an empty paint/effect list,
 * opacity 1, clip false, and null/'' font fields (e.g. an override that sets line height back to auto or removes the underline).
 */
export function mergeStyles(a: Styles, b: Styles): Styles {
  const out: Styles = { ...a, ...b };
  if (a.font || b.font) {
    const f: Record<string, unknown> = { ...a.font, ...b.font };
    // the target's saved metrics belong to its own font and size: another family drops them unless the override brings its own
    if (b.font?.f != null && a.font?.f != null && b.font.f !== a.font.f) { if (b.font.nlh === undefined) delete f.nlh; if (b.font.lpx === undefined) delete f.lpx; }
    else if (b.font?.s != null && b.font.s !== a.font?.s && b.font.lpx === undefined) delete f.lpx;
    for (const k of Object.keys(f)) if (f[k] === null || f[k] === '') delete f[k];
    out.font = f as Styles['font'];
  }
  if (b.stroke) {
    out.stroke = { ...a.stroke, ...b.stroke, paints: b.stroke.paints ?? a.stroke?.paints ?? [] };
    if (!out.stroke.paints.length) delete out.stroke;
  }
  if (b.sty || a.sty) {
    const s: Record<string, string> = { ...a.sty, ...b.sty };
    for (const k of Object.keys(s)) if (!s[k]) delete s[k];
    if (Object.keys(s).length) out.sty = s; else delete out.sty;
  }
  if (b.vars || a.vars) out.vars = { ...a.vars, ...b.vars };
  if (b.fill && !b.fill.length) delete out.fill;
  if ((b as { blend?: unknown }).blend === null) delete out.blend;
  if ((b as { link?: unknown }).link === null) delete out.link;
  if (b.fx && !b.fx.length) delete out.fx;
  if (typeof b.op === 'number' && b.op >= 1) delete out.op;
  if (b.clip === false) delete out.clip;
  return out;
}

const hex = (c: string): string => c.toLowerCase().replace(/^(#[0-9a-f]{6})ff$/, '$1');

function penPaint(v: unknown): Paint[] | undefined {
  if (typeof v === 'string') return [v.startsWith('$') ? { k: 'solid', v: v.slice(1) } : { k: 'solid', c: hex(v) }];
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: string }).type === 'color') return penPaint((v as { color?: string }).color);
  return undefined;
}

/** All overrides of an instance row as one list. */
export function ovsOf(raw: Record<string, any> | null | undefined): Ov[] {
  const out: Ov[] = [];
  if (!raw) return out;
  if (Array.isArray(raw.overrides)) out.push(...(raw.overrides as Ov[]));
  const d = raw.descendants as Record<string, any> | undefined;
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (!v || typeof v !== 'object' || v.type) continue; // `type` present = full replacement, not supported
      const o: Ov = { p: k };
      if (typeof v.content === 'string') o.t = v.content;
      if (v.enabled === false) o.hidden = true;
      const st: Styles = {};
      const fill = penPaint(v.fill);
      if (fill) st.fill = fill;
      const font: NonNullable<Styles['font']> = {};
      if (typeof v.fontSize === 'number') font.s = v.fontSize;
      if (typeof v.fontFamily === 'string') font.f = v.fontFamily;
      if (v.fontWeight !== undefined) font.w = Number(v.fontWeight) || v.fontWeight;
      if (typeof v.lineHeight === 'number') font.lh = v.lineHeight;
      if (typeof v.letterSpacing === 'number') font.ls = v.letterSpacing;
      if (typeof v.textAlign === 'string' && v.textAlign !== 'left') font.al = v.textAlign;
      if (Object.keys(font).length) st.font = font;
      if (typeof v.cornerRadius === 'number') st.r = v.cornerRadius;
      if (typeof v.opacity === 'number') st.op = v.opacity;
      if (Object.keys(st).length) o.st = st;
      out.push(o);
    }
  }
  return out;
}
