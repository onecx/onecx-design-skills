// Shared styles (.fig): a node or an instance override refers to a style record (styleIdForText/Fill/StrokeFill/Effect).
// The style's values win over the inline values, which Figma keeps as stale caches (checked against Figma's saved glyphs and
// published palette values). Style records live on the Internal Only Canvas and often come after their consumers in the
// stream, so references are resolved after the stream.
import type { Styles } from '../model.js';
import type { StyleDef, StyleUse } from './fig-convert.js';

type Any = Record<string, any>;

/** "125%" of the natural line height (Figma PERCENT units) as a multiplier of the font size; 1.2 when the font's metrics are unknown. */
export function pctLineHeight(v: string, natural?: number): number {
  return Math.round((parseFloat(v) / 100) * (natural ?? 1.2) * 1000) / 1000;
}

function setFont(base: Styles['font'], style: NonNullable<Styles['font']>): NonNullable<Styles['font']> {
  const f: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(style)) {
    if (v === null || v === undefined) delete f[k];
    else f[k] = v;
  }
  return f as NonNullable<Styles['font']>;
}

/** Applies the referenced styles to a node's styles (missing style records keep the inline values). */
export function applyStyleUse(st: Styles, raw: Any | null, use: StyleUse, defs: Record<string, StyleDef>): Styles {
  const out: Styles = { ...st };
  const names: Record<string, string> = { ...st.sty };
  const fromStroke = raw?.geometryFrom === 'stroke';
  const t = use.t ? defs[use.t] : undefined;
  if (t?.font) {
    out.font = setFont(out.font, t.font);
    // a style's percentage line height is relative to the natural line height of the font the consumer draws
    if (typeof out.font.lh === 'string' && out.font.lh.endsWith('%')) out.font.lh = pctLineHeight(out.font.lh, out.font.nlh);
    names.text = t.name;
  }
  const f = use.f ? defs[use.f] : undefined;
  if (f?.fill) {
    if (!fromStroke) { if (f.fill.length) out.fill = f.fill; else delete out.fill; }
    names.fill = f.name;
  }
  const s = use.s ? defs[use.s] : undefined;
  if (s?.fill) {
    // a stroke style holds its paints as fillPaints; a stroke-only vector draws its stroke outline as a fill
    if (fromStroke) { if (s.fill.length) out.fill = s.fill; }
    else if (out.stroke) out.stroke = { ...out.stroke, paints: s.fill };
    names.stroke = s.name;
  }
  if (out.stroke && !out.stroke.paints.length) delete out.stroke;
  const e = use.e ? defs[use.e] : undefined;
  if (e?.fx) { if (e.fx.length) out.fx = e.fx; else delete out.fx; names.effect = e.name; }
  if (Object.keys(names).length) out.sty = names;
  return out;
}

/**
 * Resolves the style references of one override record (`sid`, `fsid`, `ssid`, `esid`) into its style fields.
 * 'UNSET' (the override detached the style) keeps the override's inline values and drops the style name. Returns true if changed.
 */
export function resolveOverrideStyles(o: Any, defs: Record<string, StyleDef>): boolean {
  let changed = false;
  const st: Any = o.st ?? {};
  const names: Record<string, string> = { ...st.sty };
  const take = (field: 'sid' | 'fsid' | 'ssid' | 'esid', name: string, apply: (d: StyleDef) => boolean): void => {
    const ref = o[field];
    if (ref === undefined) return;
    delete o[field];
    changed = true;
    if (ref === 'UNSET') { names[name] = ''; return; }
    const d = defs[ref];
    if (d && apply(d)) names[name] = d.name;
  };
  take('sid', 'text', (d) => { if (!d.font) return false; st.font = { ...st.font, ...d.font }; return true; });
  take('fsid', 'fill', (d) => { if (!d.fill) return false; st.fill = d.fill; return true; });
  take('ssid', 'stroke', (d) => { if (!d.fill) return false; st.stroke = { ...st.stroke, paints: d.fill }; return true; });
  take('esid', 'effect', (d) => { if (!d.fx) return false; st.fx = d.fx; return true; });
  if (Object.keys(names).length) st.sty = names;
  if (Object.keys(st).length) o.st = st;
  return changed;
}
