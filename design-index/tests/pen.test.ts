import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { Out } from '../src/output.js';
import { nodeDetail, overview, search, tree } from '../src/commands/structure.js';
import { buildSpec } from '../src/commands/spec.js';
import { buildTokens } from '../src/commands/library.js';
import { renderSvg } from '../src/render.js';
import { makePng } from './helpers/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-pen-'));
const png = makePng(24, 16, [10, 120, 200, 255]);
const doc = `// comment before the document
{
  "version": "2.21",
  /* themes */
  "themes": { "mode": ["light", "dark"] },
  "variables": {
    "color.primary": { "type": "color", "value": [{ "value": "#0057AB", "theme": { "mode": "light" } }, { "value": "#66AAFF", "theme": { "mode": "dark" } }] },
    "space.m": { "type": "number", "value": 16 }
  },
  "children": [
    { "type": "frame", "id": "board", "name": "01 – Login", "x": 0, "y": 0, "width": 1600, "height": 1000, "layout": "none", "children": [
      { "type": "frame", "id": "scr1", "name": "Login", "x": 10, "y": 10, "width": 1312, "height": 800, "fill": "#FFFFFF", "layout": "vertical", "gap": "$space.m", "padding": [8, 16],
        "futureField": 42,
        "children": [
          { "type": "text", "id": "t1", "name": "Title", "content": "Willkommen", "fill": "$color.primary", "fontFamily": "Open Sans", "fontSize": 28, "fontWeight": "700", "width": "fill_container" },
          { "type": "text", "id": "t2", "name": "Hint", "content": "Lorem ipsum", "fontSize": 14 },
          { "type": "rectangle", "id": "img1", "name": "Photo", "width": 120, "height": 80, "fill": { "type": "image", "url": "data:image/png;base64,${png.toString('base64')}", "mode": "cover" } },
          { "type": "ref", "id": "inst1", "ref": "btn", "descendants": { "btnlabel": { "content": "Anmelden" } } },
          { "type": "icon", "id": "ic1", "library": "lucide", "icon": "user", "width": 16, "height": 16 },
          { "type": "hologram", "id": "weird" }
        ] },
      { "type": "frame", "id": "btn", "name": "Button", "reusable": true, "layout": "horizontal", "padding": 12, "cornerRadius": 8, "fill": "#003064", "children": [
        { "type": "text", "id": "btnlabel", "name": "Label", "content": "Button", "fill": "#FFFFFF", "fontSize": 14 }
      ] }
    ] }
  ]
}`;
const file = path.join(tmp, 'sample.pen');

beforeAll(async () => {
  process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache');
  fs.writeFileSync(file, doc);
  await ingest(file, { quiet: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const out = (n = 4000) => new Out({ maxTokens: n, json: false });
const text = (o: Out) => { const w = process.stdout.write; let s = ''; (process.stdout as any).write = (x: string) => { s += x; return true; }; try { o.print(); } finally { process.stdout.write = w; } return s; };

describe('pen ingest', () => {
  it('reads comments, nodes, components, variables and tolerates unknown fields/types', () => {
    const { db } = openIndex(file);
    const n = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;
    expect(n).toBe(10);
    expect((db.prepare("SELECT COUNT(*) c FROM components").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM variables").get() as { c: number }).c).toBe(2);
    const warns = (db.prepare('SELECT msg FROM warnings').all() as { msg: string }[]).map((w) => w.msg).join('|');
    expect(warns).toContain('unknown field "futureField"');
    expect(warns).toContain('unknown node type "hologram"');
  });

  it('streams data-URI images into assets/ and never stores them in the database', () => {
    const { db, dir } = openIndex(file);
    const a = db.prepare('SELECT * FROM assets').get() as { path: string; mime: string; w: number; h: number; size: number };
    expect(a.mime).toBe('image/png');
    expect([a.w, a.h]).toEqual([24, 16]);
    expect(fs.readFileSync(path.join(dir, a.path)).equals(png)).toBe(true);
    const raw = db.prepare("SELECT styles FROM nodes WHERE id='img1'").get() as { styles: string };
    expect(raw.styles).not.toContain('base64');
  });

  it('skips already indexed files via content hash', async () => {
    const r = await ingest(file, { quiet: true });
    expect(r.cached).toBe(true);
  });

  it('is deterministic about ids, hierarchy and sibling order', () => {
    const { db } = openIndex(file);
    const kids = db.prepare("SELECT id FROM nodes WHERE parent_id='scr1' ORDER BY ord").all() as { id: string }[];
    expect(kids.map((k) => k.id)).toEqual(['t1', 't2', 'img1', 'inst1', 'ic1', 'weird']);
  });
});

describe('queries', () => {
  it('tree uses compact notation and suggests the next command when truncated', () => {
    const { db } = openIndex(file);
    const o = out(); tree(db, o, 'board', 1, 40);
    const s = text(o);
    expect(s).toContain('scr1 frame "Login"');
    expect(s).toContain('… 6 children (tree scr1 --depth 2)');
  });

  it('respects the token budget and reports skipped rows', () => {
    const { db } = openIndex(file);
    const o = out(120); tree(db, o, 'board', 3, 40);
    expect(text(o)).toMatch(/more lines truncated/);
  });

  it('search finds names and texts', () => {
    const { db } = openIndex(file);
    const o = out(); search(db, o, 'willkom', undefined, 10);
    expect(text(o)).toContain('t1 text');
  });

  it('node shows layout, token binding and raw attributes', () => {
    const { db } = openIndex(file);
    const o = out(); nodeDetail(db, o, 'scr1');
    const s = text(o);
    expect(s).toContain('layout: col gap=$space.m pad=8,16');
    expect(s).toContain('"futureField":42');
  });

  it('overview lists pages and counts', () => {
    const { db } = openIndex(file);
    const o = out(); overview(db, o);
    expect(text(o)).toContain('Components: 1');
  });
});

describe('spec, tokens, render', () => {
  it('spec names tokens instead of hex values and lists asset paths', () => {
    const { db } = openIndex(file);
    const r = buildSpec(db, 'scr1', { maxTokens: 4000 });
    expect(r.text).toContain('color=$color-primary');
    expect(r.text).toContain('img(assets/');
    expect(r.text).toContain('→Button');
    expect(r.text).toContain('"Willkommen"');
  });

  it('tokens: CSS custom properties with themes as [data-theme]', () => {
    const { db } = openIndex(file);
    const css = buildTokens(db, 'css', false).text;
    expect(css).toContain('--color-primary: #0057ab;');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('--color-primary: #66aaff;');
    expect(css).toContain('--space-m: 16px;');
  });

  it('render expands component instances and applies overrides', () => {
    const { db, dir } = openIndex(file);
    const r = renderSvg(db, 'scr1', { assetsDir: path.join(dir, 'assets'), format: 'pen' });
    expect(r.svg).toContain('Anmelden');
    expect(r.svg).not.toContain('>Button<');
    expect(r.w).toBe(1312);
  });
});
