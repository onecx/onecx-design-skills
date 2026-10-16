import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { blobToPath, variantFromName } from '../src/parsers/fig-convert.js';
import { buildTokens } from '../src/commands/library.js';
import { buildSpec } from '../src/commands/spec.js';
import { Out } from '../src/output.js';
import { search } from '../src/commands/structure.js';
import { makePng } from './helpers/png.js';
import { buildFig, buildZip, sampleNodes } from './helpers/fig-builder.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-fig-'));
beforeAll(() => { process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache'); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('fig ingest', () => {
  it('reads a raw fig-kiwi file: tree, layout, components, variables', async () => {
    const f = path.join(tmp, 'raw.fig');
    fs.writeFileSync(f, buildFig(sampleNodes()));
    const r = await ingest(f, { quiet: true });
    expect(r.format).toBe('fig');
    const { db } = openIndex(f);
    const login = db.prepare("SELECT * FROM nodes WHERE name='Login'").get() as any;
    expect([login.depth, login.page, login.parent_id]).toEqual([0, 1, null]);
    expect(JSON.parse(login.layout)).toMatchObject({ dir: 'col', gap: 16 });
    const kids = db.prepare("SELECT name FROM nodes WHERE parent_id='1:1' ORDER BY ord").all() as { name: string }[];
    expect(kids.map((k) => k.name)).toEqual(['Title', 'Hint', 'Button']);
    const comp = db.prepare('SELECT * FROM components').get() as any;
    expect(JSON.parse(comp.variant)).toEqual({ State: 'Hover', Size: 'L' });
    expect(comp.description).toBe('Primary button');
    expect((db.prepare("SELECT component_ref FROM nodes WHERE id='2:2'").get() as any).component_ref).toBe('2:1');
    const css = buildTokens(db, 'css', false).text;
    expect(css).toContain('--brand-primary: #003366;');
    expect(css).toContain('[data-theme="dark"]');
  });

  it('reads the ZIP container, streams images and keeps them out of the database', async () => {
    const f = path.join(tmp, 'zip.fig');
    const img = makePng(8, 8, [255, 0, 0, 255]);
    fs.writeFileSync(f, buildZip({ 'canvas.fig': buildFig(sampleNodes()), 'meta.json': Buffer.from('{"file_name":"x"}'), 'images/abcdef': img }));
    await ingest(f, { quiet: true });
    const { db, dir } = openIndex(f);
    const a = db.prepare('SELECT * FROM assets').get() as any;
    expect(a.mime).toBe('image/png');
    expect(fs.existsSync(path.join(dir, a.path))).toBe(true);
    expect((db.prepare("SELECT value FROM meta WHERE key='figma_meta'").get() as any).value).toContain('file_name');
  });

  it('fails with a clear message for unknown content', async () => {
    const f = path.join(tmp, 'bad.fig');
    fs.writeFileSync(f, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(60)]));
    await expect(ingest(f, { quiet: true })).rejects.toThrow();
    const g = path.join(tmp, 'bad2.fig');
    fs.writeFileSync(g, Buffer.from('fig-kiwi\u0000\u0000\u0000\u0000'.padEnd(40, '\u0000'), 'latin1'));
    await expect(ingest(g, { quiet: true })).rejects.toThrow(/canvas\.fig|chunk|header|schema|compression/i);
  });

  it('warns for untested versions but still decodes', async () => {
    const f = path.join(tmp, 'v999.fig');
    fs.writeFileSync(f, buildFig(sampleNodes(), { version: 999 }));
    await ingest(f, { quiet: true });
    const { db } = openIndex(f);
    expect((db.prepare('SELECT msg FROM warnings').all() as any[]).some((w) => /version 999 is untested/.test(w.msg))).toBe(true);
  });
});

describe('fig instance overrides', () => {
  it('keeps style overrides, expands the instance in spec and finds override texts', async () => {
    const f = path.join(tmp, 'ov.fig');
    fs.writeFileSync(f, buildFig(sampleNodes()));
    await ingest(f, { quiet: true });
    const { db } = openIndex(f);
    const raw = JSON.parse((db.prepare("SELECT raw FROM nodes WHERE id='2:2'").get() as any).raw);
    expect(raw.overrides[0]).toMatchObject({ p: '2:3', t: 'Weiter', st: { font: { s: 20 } } });
    const spec = buildSpec(db, '1:1', { maxTokens: 4000 }).text;
    expect(spec).toMatch(/"Label" text .*text="Weiter" .*font=20/);
    const o = new Out({ maxTokens: 2000, json: true });
    search(db, o, 'Weiter', undefined, 5);
    const w = process.stdout.write; let out = ''; (process.stdout as any).write = (x: string) => { out += x; return true; };
    try { o.print(); } finally { process.stdout.write = w; }
    expect(out).toContain('2:2');
  });
});

describe('fig helpers', () => {
  it('decodes Figma path blobs', () => {
    const b = Buffer.alloc(1 + 8 + 1 + 8 + 1);
    b[0] = 1; b.writeFloatLE(1, 1); b.writeFloatLE(2, 5);
    b[9] = 2; b.writeFloatLE(3, 10); b.writeFloatLE(4, 14);
    b[18] = 0;
    expect(blobToPath(new Uint8Array(b))).toBe('M1 2L3 4Z');
  });
  it('parses variant names', () => {
    expect(variantFromName('State=Hover, Size=L')).toEqual({ State: 'Hover', Size: 'L' });
    expect(variantFromName('Button')).toBeNull();
  });
});
