// Shared styles (.fig): a node or an instance override refers to a style record (styleIdForText/Fill/StrokeFill/Effect).
// The style's values win over the inline values, which Figma keeps as stale caches (checked against Figma's saved glyphs and
// published palette values). Style records live on the Internal Only Canvas and often come after their consumers in the
// stream, so references are resolved after the stream.
import type { Styles, TextRun } from '../model.js';
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

/**
 * Resolves the style references of text ranges: a range's text style decides its font (its own inline font fields win only when the
 * range is marked as an override over the style), a range's fill style decides its paints. Missing style records keep the inline values.
 */
export function resolveRuns(runs: TextRun[], defs: Record<string, StyleDef>, nlh?: number): boolean {
  let changed = false;
  for (const r of runs) {
    if (r.tsid !== undefined) {
      const d = defs[r.tsid];
      if (d?.font) {
        const style: Record<string, unknown> = { ...d.font };
        if (typeof style.lh === 'string' && style.lh.endsWith('%')) style.lh = pctLineHeight(style.lh, nlh);
        r.font = (r.ovr ? { ...style, ...r.font } : { ...r.font, ...style }) as TextRun['font'];
        (r.sty ??= {}).text = d.name;
      }
      delete r.tsid; delete r.ovr; changed = true;
    }
    if (r.fsid !== undefined) {
      const d = defs[r.fsid];
      if (d?.fill) { r.fill = d.fill; (r.sty ??= {}).fill = d.name; }
      delete r.fsid; changed = true;
    }
  }
  return changed;
}

/** Applies the referenced styles to a node's styles (missing style records keep the inline values). */
/** `keepOwn` = an instance detaches this layer's fill style: keep its own paints as `ifill` */
export function applyStyleUse(st: Styles, raw: Any | null, use: StyleUse, defs: Record<string, StyleDef>, keepOwn = false): Styles {
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
    if (!fromStroke) {
      // the node's own paints are what an instance shows when it detaches the style without paints of its own
      if (keepOwn && out.fill && JSON.stringify(out.fill) !== JSON.stringify(f.fill)) out.ifill = out.fill;
      if (f.fill.length) out.fill = f.fill; else delete out.fill;
    }
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
  if (use.r && out.runs) { out.runs = out.runs.map((r) => ({ ...r })); resolveRuns(out.runs, defs, out.font?.nlh); }
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
  if (Array.isArray(st.runs) && resolveRuns(st.runs, defs, st.font?.nlh)) changed = true;
  if (Object.keys(names).length) st.sty = names;
  if (Object.keys(st).length) o.st = st;
  return changed;
}
