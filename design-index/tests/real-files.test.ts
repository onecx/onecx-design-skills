// Optional checks against real Figma exports (never committed: see tests/fixtures/README.md for the download list).
// Runs only when DESIGN_INDEX_FIXTURES points to a folder with the files, e.g.
//   DESIGN_INDEX_FIXTURES=~/fig-fixtures npm test
// Each expectation is an oracle fact: something Figma itself saved in the file (laid-out sizes, glyph fonts, outlines) or what
// Figma renders for the authored case.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { buildSpec } from '../src/commands/spec.js';
import { renderSvg } from '../src/render.js';
import type { DatabaseSync } from '../src/sqlite.js';

const dir = process.env.DESIGN_INDEX_FIXTURES ?? '';
const fileOf = (name: string): string | undefined => {
  if (!dir) return undefined;
  for (const p of [path.join(dir, name), path.join(dir, 'f2s', name)]) if (fs.existsSync(p)) return p;
  return undefined;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-real-'));
let prevDir: string | undefined;
beforeAll(() => { prevDir = process.env.DESIGN_INDEX_DIR; process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache'); });
afterAll(() => { process.env.DESIGN_INDEX_DIR = prevDir; fs.rmSync(tmp, { recursive: true, force: true }); });

const ingested = new Map<string, DatabaseSync>();
async function open(name: string): Promise<DatabaseSync> {
  const f = fileOf(name)!;
  if (!ingested.has(f)) { await ingest(f, { quiet: true }); ingested.set(f, openIndex(f).db); }
  return ingested.get(f)!;
}
const spec = (db: DatabaseSync, id: string) => buildSpec(db, id, { maxTokens: Infinity }).text;
const first = (text: string) => text.split('\n').find((l) => !l.startsWith('#')) ?? '';
const styles = (db: DatabaseSync, id: string) => JSON.parse((db.prepare('SELECT styles FROM nodes WHERE id=?').get(id) as { styles: string }).styles ?? '{}');

describe.skipIf(!fileOf('gold-preview.fig'))('gold-preview.fig', () => {
  it('SPACE_EVENLY is space-between without gap (1:1697)', async () => {
    const l = first(spec(await open('gold-preview.fig'), '1:1697'));
    expect(l).toContain('jc=between');
    expect(l).not.toMatch(/gap=/);
  });
  it('FRAME + resizeToFit is a non-clipping group (1:1491)', async () => {
    const l = first(spec(await open('gold-preview.fig'), '1:1491'));
    expect(l).toMatch(/"Image" group /);
    expect(l).not.toContain('clip');
  });
  it('mirrored vector keeps its flip and visual box (Vector 131)', async () => {
    const text = spec(await open('gold-preview.fig'), '1:1491');
    expect(text).toMatch(/"Vector 131" path .*visual@52\.79,6\.89 .*flip=x/);
    expect(text).not.toMatch(/"Vector 131".* r=/);
  });
  it('Auto line height (text style LG/Medium) prints no multiplier', async () => {
    expect(styles(await open('gold-preview.fig'), '1:42').font.lh).toBeUndefined();
  });
  it('text style reference is resolved and named (1:757)', async () => {
    expect(spec(await open('gold-preview.fig'), '1:757')).toContain('styles{text:"XS/Medium"}');
  });
});

describe.skipIf(!fileOf('nuxtui.fig'))('nuxtui.fig', () => {
  it('button without stackPrimarySizing hugs its width; outline icon takes the instance colour (20:113156)', async () => {
    const text = spec(await open('nuxtui.fig'), '20:113156');
    expect(first(text)).toContain('hug(91)×hug(32)');
    const icon = text.split('\n').find((l) => l.includes('"icon" path'))!;
    expect(icon).toContain('fill=$colors-white-solid-text-color');
    expect(icon).not.toContain('stroke=');
  }, 180000);
  it('segmented button strokes follow per-corner radii (229:14504)', async () => {
    const svg = renderSvg(await open('nuxtui.fig'), '229:14504', { assetsDir: '', format: 'fig' }).svg;
    expect(svg).not.toMatch(/stroke="#d1d5dc"[^>]*rx=|rx="[^"]*"[^>]*stroke="#d1d5dc"/);
  }, 180000);
  it('independent corners with absent fields are 0 (229:14505)', async () => {
    expect(styles(await open('nuxtui.fig'), '229:14505').r).toEqual([0, 6, 6, 0]);
  }, 180000);
});

describe.skipIf(!fileOf('material3.fig'))('material3.fig', () => {
  it('the text style wins over the stale inline family (50716:11374)', async () => {
    expect(styles(await open('material3.fig'), '50716:11374').font.f).toBe('Roboto');
  }, 120000);
  it('independent corners: Bottom sheet is 16/0/0/16 (51827:5859)', async () => {
    expect(styles(await open('material3.fig'), '51827:5859').r).toEqual([16, 0, 0, 16]);
  }, 120000);
  it('GRID frames are reported as grid', async () => {
    const db = await open('material3.fig');
    expect((db.prepare(`SELECT COUNT(*) c FROM nodes WHERE json_extract(layout, '$.dir') = 'grid'`).get() as { c: number }).c).toBe(14);
  }, 120000);
  it('a rotated vector exports inside its transformed bounds (58005:8533, -95°)', async () => {
    const r = renderSvg(await open('material3.fig'), '58005:8533', { assetsDir: '', format: 'fig', background: null });
    expect(r.w).toBeGreaterThan(40);
    expect(r.h).toBeGreaterThan(40);
    expect(r.svg).toContain('matrix(');
  }, 120000);
  it('a masked image is drawn as a pattern fill, not a clipped layer (Mask group 54727:23627)', async () => {
    const db = await open('material3.fig');
    const svg = renderSvg(db, '54727:23627', { assetsDir: path.join(openIndex(fileOf('material3.fig')!).dir, 'assets'), format: 'fig' }).svg;
    expect(svg).toMatch(/<g mask="url\(#m\d+\)">/);
    expect(svg).toMatch(/<pattern [^>]*><image href="data:image\/png/);
    expect(svg).not.toMatch(/<image [^>]*clip-path=/);
  }, 120000);
  it('masks are marked in spec (Mask group 54727:23627)', async () => {
    expect(spec(await open('material3.fig'), '54727:23627')).toMatch(/"Rectangle 1" rect .* mask/);
  }, 120000);
});

describe.skipIf(!fileOf('variable-override-precedence.fig'))('variable-override-precedence.fig', () => {
  it('text bound to a variable shows what Figma renders for the four authored cases', async () => {
    const db = await open('variable-override-precedence.fig');
    const textOf = (id: string) => spec(db, id).match(/text="([^"]*)"/)?.[1];
    expect(textOf('9:1469')).toBe('Button-sm'); // same-literal
    expect(textOf('9:1472')).toBe('Button-sm'); // different-literal
    expect(textOf('9:1482')).toBe('Button-sm'); // return-to-inherited
    expect(textOf('9:1479')).toBe('Learn more'); // staged: bare entry clears the binding
  });
});

describe.skipIf(!fileOf('slots.fig'))('slots.fig', () => {
  it('slot frames show the assigned content (A filled 14:38)', async () => {
    const text = spec(await open('slots.fig'), '14:38');
    expect(text).toContain('"Added text"');
    expect(text).toContain('"Added rectangle"');
  });
});

describe.skipIf(!fileOf('circle-text.fig'))('circle-text.fig', () => {
  it('text on a path is extracted (0:7)', async () => {
    const db = await open('circle-text.fig');
    expect(db.prepare('SELECT type, text FROM nodes WHERE id=?').get('0:7')).toMatchObject({ type: 'text', text: 'ArnoCoenen.art' });
  });
  it('multi-colour logo keeps its region paints (ArnoIcon 0:6)', async () => {
    const svg = renderSvg(await open('circle-text.fig'), '0:6', { assetsDir: '', format: 'fig', background: null }).svg;
    expect(new Set(svg.match(/fill="#[0-9a-f]{6}"/g)).size).toBeGreaterThan(5);
  });
});

describe.skipIf(!fileOf('noise_and_grain.fig'))('fig2sketch noise_and_grain.fig', () => {
  it('RAW line height is a multiplier; NOISE/GRAIN are not turned into blurs', async () => {
    const db = await open('noise_and_grain.fig');
    const lhs = (db.prepare(`SELECT json_extract(styles, '$.font.lh') lh FROM nodes WHERE type='text'`).all() as { lh: number | null }[]).map((r) => r.lh);
    expect(lhs).toContain(0.87);
    const blurs = (db.prepare(`SELECT COUNT(*) c FROM nodes WHERE styles LIKE '%"k":"blur"%'`).get() as { c: number }).c;
    const warns = (db.prepare('SELECT msg FROM warnings').all() as { msg: string }[]).map((w) => w.msg).join('\n');
    expect(warns).toMatch(/effect type (NOISE|GRAIN) not supported/);
    expect(blurs).toBeLessThanOrEqual(2); // the two FOREGROUND_BLUR effects only
  });
});

describe.skipIf(!fileOf('open-peeps.fig'))('open-peeps.fig', () => {
  it('slices are not listed as UI nodes', async () => {
    const db = await open('open-peeps.fig');
    expect((db.prepare(`SELECT COUNT(*) c FROM nodes WHERE type='other'`).get() as { c: number }).c).toBe(0);
  });
  it('bold headings in a regular text are ranges (User Bio 0:2)', async () => {
    const db = await open('open-peeps.fig');
    const text = spec(db, '0:2');
    expect(text).toContain('runs[11-80 "An app that manages different…" w400; 93-137 "Buttons hard to find, Alarm t…" w400]');
    expect(renderSvg(db, '0:3', { assetsDir: '', format: 'fig' }).svg).toContain('<tspan font-weight="400">');
  });
});

describe.skipIf(!fileOf('material3.fig'))('material3.fig (0.1.4)', () => {
  it('link ranges take the colour of their fill style (54727:23654)', async () => {
    const db = await open('material3.fig');
    const l = spec(db, '54727:23654').split('\n').find((x) => x.includes('"Overview copy"'))!;
    expect(l).toContain('runs[0-16 "Material Symbols" w600 underline color=$schemes-primary(#6750a4) link=https://m3.material.io/styles/icons/ styles{fill:"M3/sys/light/primary"}');
    expect(l).toContain('268-291 "Material Symbols plugin" underline color=$schemes-primary(#6750a4) link=https://www.figma.com/community/plugin/1088610476491668236/material-symbols');
  }, 120000);
  it('MULTIPLY gradients and reverse paint order (56576:11826)', async () => {
    const db = await open('material3.fig');
    const text = spec(db, '56576:11826');
    expect(first(text)).toContain('z-reverse');
    expect(text).toMatch(/"Top app bar" frame .*fill=linear-gradient\([^)]*\)\|multiply/);
    const svg = renderSvg(db, '56576:11826', { assetsDir: '', format: 'fig' }).svg;
    expect(svg.match(/mix-blend-mode:multiply/g)?.length).toBe(2);
    // the album art (last child) is painted first
    expect(svg.indexOf('data-id="56576:11837"')).toBeLessThan(svg.indexOf('data-id="56576:11827"'));
  }, 120000);
});

describe.skipIf(!fileOf('gold-preview.fig'))('gold-preview.fig (0.1.4)', () => {
  it('a scaled instance (uniformScaleFactor 0.8908) keeps its own size and scales its content (1:3503)', async () => {
    const text = spec(await open('gold-preview.fig'), '1:3503');
    expect(first(text)).toContain('"Input" instance hug(393.57)×hug(39.38)');
    // the component's 14 px label: 14 × 0.8908
    expect(text).toContain('font=Inter/12.472/w500');
  });
});

describe.skipIf(!fileOf('Complex.fig'))('Complex.fig', () => {
  it('angular and diamond gradients are printed and drawn (frame "gradients" 73:3)', async () => {
    const db = await open('Complex.fig');
    const text = spec(db, '73:3');
    expect(text).toContain('"Angular 1" rect 400×400 @50,1050 fill=conic-gradient(from 180deg at 50% 50%, #d70000 0%, #000000 50.9%, #ffffff 100%)');
    expect(text).toContain('"Diamond 1" rect 400×400 @50,1550 fill=diamond-gradient(200px 200px at 50% 50%');
    const r = renderSvg(db, '79:11', { assetsDir: '', format: 'fig' });
    expect(r.notes.join(' ')).not.toMatch(/drawn as (radial|linear)/);
    expect(r.svg).toMatch(/<pattern [^>]*><g transform="translate/);
  });
});

describe.skipIf(!fileOf('stacks_wrap.fig'))('fig2sketch stacks_wrap.fig (Display-P3)', () => {
  it('converts Display-P3 colours to sRGB and says so', async () => {
    const db = await open('stacks_wrap.fig');
    expect(styles(db, '1:5').fill).toEqual([{ k: 'solid', c: '#ff9433' }]);
    expect(spec(db, '1:5')).toMatch(/^# colours: the document is Display-P3/m);
  });
});

// 0.1.5: emoji ranges, stroke paint blend modes
describe.skipIf(!fileOf('Complex.fig'))('Complex.fig (0.1.5)', () => {
  it('an EMOJI range (only the glyphs refer to it) is marked and drawn as a visible placeholder (375:15)', async () => {
    const db = await open('Complex.fig');
    expect(styles(db, '375:15').runs).toEqual([{ i: 0, n: 2, emoji: true }]);
    expect(first(spec(db, '375:15'))).toContain('runs[0-2 "👍" emoji]');
    const svg = renderSvg(db, '375:15', { assetsDir: '', format: 'fig' }).svg;
    expect(svg).toMatch(/<tspan fill="#f5c33b">●<\/tspan> Small Button/);
  });
});

describe.skipIf(!fileOf('Complex.fig'))('Complex.fig (0.1.5 review)', () => {
  it('characterStyleIDs are per code point: 11 ids for "👍 Emojito 🤣" (375:16)', async () => {
    const db = await open('Complex.fig');
    expect(styles(db, '375:16').runs).toMatchObject([{ i: 0, n: 2, emoji: true }, { i: 2, n: 9, font: { w: 700 } }, { i: 11, n: 2, font: { w: 700 }, emoji: true }]);
    expect(first(spec(db, '375:16'))).toContain('runs[0-2 "👍" font=Arial w400 emoji; 2-11 "Emojito" font=Arial w700; 11-13 "🤣" font=Arial w700 emoji]');
  });
});

describe.skipIf(!fileOf('tds-components.fig'))('tds-components.fig', () => {
  it('an emoji with a variation selector inside a font range (1363:4397)', async () => {
    const db = await open('tds-components.fig');
    expect(styles(db, '1363:4397').runs[0]).toMatchObject({ i: 0, n: 2, emoji: true });
    expect(first(spec(db, '1363:4397'))).toMatch(/runs\[0-2 "⚠️" emoji; 125-156 "2021-07-16 \(July\): Donna Vitan" w700\]/);
    expect(renderSvg(db, '1363:4397', { assetsDir: '', format: 'fig' }).svg).toContain('<tspan fill="#f5c33b">●</tspan>');
  }, 120000);
});

describe.skipIf(!fileOf('google_material_design.fig'))('google_material_design.fig (raw fig-kiwi v2)', () => {
  it('draws both gradient stroke paints, the second with soft-light (card 0:1020 in "search" 0:1019)', async () => {
    const db = await open('google_material_design.fig');
    expect(spec(db, '0:1019')).toMatch(/"card" path .*stroke=linear-gradient\([^)]*\)\+linear-gradient\([^)]*\)\|soft-light\/1\/inner/);
    const svg = renderSvg(db, '0:1019', { assetsDir: '', format: 'fig' }).svg;
    const card = /<g data-id="0:1020"[^>]*>(.*?)<\/g>/.exec(svg)![1];
    const strokes = card.match(/<path [^>]*fill="none" stroke="url\(#g\d+\)"[^>]*>/g) ?? [];
    expect(strokes).toHaveLength(2);
    expect(strokes[0]).not.toContain('mix-blend-mode');
    expect(strokes[1]).toContain('style="mix-blend-mode:soft-light"');
  });
});

describe.skipIf(!fileOf('medium-complex.fig'))('medium-complex.fig', () => {
  it('Auto line height is explicit with Figma\'s saved pitch (1:91, Avenir Next 24, 33 px)', async () => {
    expect(first(spec(await open('medium-complex.fig'), '1:91'))).toContain('font=Avenir Next/24/w700/lh-normal(33px)');
  });
});

describe('Auto line height: Figma\'s saved pitch (unrounded on legacy texts)', () => {
  it.skipIf(!fileOf('material3.fig'))('material3 53379:35518 (Roboto Bold 56, 3 lines, box 197)', async () => {
    expect(first(spec(await open('material3.fig'), '53379:35518'))).toMatch(/hug\(197\).*font=Roboto\/56\/w700\/lh-normal\(65\.63px\)/);
  }, 180000);
  it.skipIf(!fileOf('medium-complex.fig'))('medium-complex 1:105 (box 60)', async () => {
    expect(first(spec(await open('medium-complex.fig'), '1:105'))).toContain('font=Avenir Next/44/w700/lh-normal(60.1px)');
  });
  it.skipIf(!fileOf('gold-preview.fig'))('gold-preview 1:2104 (box 24)', async () => {
    expect(styles(await open('gold-preview.fig'), '1:2104').font.lpx).toBe(24.205);
  });
});
