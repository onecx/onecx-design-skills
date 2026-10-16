import fs from 'node:fs';
import path from 'node:path';
import type { Opened } from '../cache.js';
import { getMeta } from '../db.js';
import { Out, safeJson } from '../output.js';
import { renderSvg, svgToPng } from '../render.js';
import type { Styles } from '../model.js';
import { fmtBytes } from '../util.js';
import { requireNode } from './structure.js';
import { svgName } from './spec.js';

const VECTOR = ['path', 'line', 'polygon', 'ellipse', 'boolean'];

const fmtOf = (ix: Opened): 'pen' | 'fig' => (getMeta(ix.db, 'format') === 'fig' ? 'fig' : 'pen');

export async function screenshot(ix: Opened, out: Out, id: string, o: { maxEdge: string; out?: string; svg?: boolean; noText?: boolean }): Promise<void> {
  const node = requireNode(ix.db, id);
  const maxEdge = Math.max(64, Math.min(4096, Number(o.maxEdge) || 1024));
  const r = renderSvg(ix.db, id, { assetsDir: path.join(ix.dir, 'assets'), format: fmtOf(ix), hideText: o.noText });
  const dir = path.join(ix.dir, 'screenshots');
  const base = o.out ? path.resolve(o.out) : path.join(dir, `${id}-${maxEdge}.${o.svg ? 'svg' : 'png'}`);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  let size: number;
  let dims = `${r.w}×${r.h}`;
  if (o.svg) { fs.writeFileSync(base, r.svg); size = Buffer.byteLength(r.svg); }
  else {
    let png: Buffer;
    try {
      png = await svgToPng(r.svg, maxEdge, r.w, r.h);
    } catch (e) {
      // the WASM rasterizer can trap on exotic input: keep the SVG so the run is not lost
      const svgFile = base.replace(/\.png$/i, '') + '.svg';
      fs.writeFileSync(svgFile, r.svg);
      throw new Error(`PNG rendering failed (${(e as Error).message}). The SVG was written to ${svgFile}. Try a smaller section (tree <id> --depth 1, then screenshot a child) or --no-text.`);
    }
    fs.writeFileSync(base, png);
    size = png.length;
    const scale = Math.min(1, maxEdge / Math.max(r.w, r.h));
    dims = `${Math.round(r.w * scale)}×${Math.round(r.h * scale)} (Original ${r.w}×${r.h})`;
  }
  out.add(`${base}  ${dims} ${fmtBytes(size)} · ${r.nodes} nodes · "${node.name}"`, { file: base, w: r.w, h: r.h, nodes: r.nodes });
  for (const n of r.notes.slice(0, 8)) out.add(`Note: ${n}`);
  if (r.notes.length > 8) out.add(`… ${r.notes.length - 8} more notes`);
  out.hint('Offline approximation from the index (not the original renderer): layout/fonts may deviate. View the PNG with the image viewing tool.');
  if (r.h > r.w * 4 && !o.svg) out.hint('Very tall frame: better capture sections one by one (children via `tree <id> --depth 1`).');
}

export function assetsExport(ix: Opened, out: Out, id: string, o: { out: string }): void {
  const db = ix.db;
  const root = requireNode(db, id);
  const dest = path.resolve(o.out);
  fs.mkdirSync(dest, { recursive: true });
  const sub = `WITH RECURSIVE t(id) AS (SELECT id FROM nodes WHERE id=? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id)`;
  const format = fmtOf(ix);
  const assetsDir = path.join(ix.dir, 'assets');
  let nSvg = 0, nImg = 0, missing = 0;

  // 1. raster images referenced by fills
  const withImg = db.prepare(`${sub} SELECT n.id, n.styles FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.styles LIKE '%"k":"img"%'`).all(id) as { id: string; styles: string }[];
  const seen = new Set<string>();
  for (const r of withImg) {
    const s = safeJson<Styles>(r.styles);
    for (const p of [...(s?.fill ?? []), ...(s?.stroke?.paints ?? [])]) {
      if (p.k !== 'img') continue;
      if (!p.asset) { missing++; continue; }
      if (seen.has(p.asset)) continue;
      seen.add(p.asset);
      const a = db.prepare('SELECT path,mime FROM assets WHERE hash=?').get(p.asset) as { path: string; mime: string } | undefined;
      if (!a) { missing++; continue; }
      fs.copyFileSync(path.join(ix.dir, a.path), path.join(dest, path.basename(a.path)));
      nImg++;
    }
  }

  // 2. vector nodes: one SVG each (names match the svg= entries in `spec`)
  const vecs = db.prepare(`${sub} SELECT n.id, n.name FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.type IN (${VECTOR.map(() => '?').join(',')}) AND n.visible=1 LIMIT 2000`).all(id, ...VECTOR) as { id: string; name: string }[];
  for (const v of vecs) {
    const r = renderSvg(db, v.id, { assetsDir, format, background: null, maxNodes: 200 });
    fs.writeFileSync(path.join(dest, svgName(v)), r.svg);
    nSvg++;
  }

  // 3. a small container made only of vectors (icon, logo) is exported as one combined SVG.
  //    Its size comes from the renderer, so auto-layout (hug) frames without stored size work as well.
  if (root.nchild && !VECTOR.includes(root.type)) {
    const textNodes = (db.prepare(`${sub} SELECT COUNT(*) c FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.type IN ('text','instance')`).get(id) as { c: number }).c;
    if (!textNodes) {
      const r = renderSvg(db, id, { assetsDir, format, background: null, maxNodes: 500 });
      if (r.w <= 400 && r.h <= 400 && r.w > 0 && r.h > 0) {
        fs.writeFileSync(path.join(dest, svgName(root)), r.svg);
        nSvg++;
      }
    }
  }
  out.add(`${nSvg} SVG, ${nImg} image(s) → ${o.out}${missing ? ` · ${missing} image reference(s) without file (missing in the source)` : ''}`, { svg: nSvg, images: nImg, missing, dir: o.out });
  if (!nSvg && !nImg) out.add('No exportable vectors/images in this subtree.');
  if (nImg) out.add('Images are in their original format (PNG/JPEG/WebP); conversion/scaling belongs in the project build.');
  out.hint('File names match the `svg=` entries from `spec`; library icons (icon=lucide:…) come from the project, not from the file.');
}
