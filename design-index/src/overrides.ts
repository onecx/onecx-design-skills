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
}

export const lastKey = (p: string): string => p.split('/').pop() ?? '';

export function mergeStyles(a: Styles, b: Styles): Styles {
  const out: Styles = { ...a, ...b };
  if (a.font || b.font) out.font = { ...a.font, ...b.font };
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
