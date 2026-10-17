// 0.1.5: the last documented .fig limits of 0.1.4 — non-solid paints of text ranges (gradient, image, emoji), stroke paint blend
// modes, and auto layout under an explicit variable mode (gap, padding, size bound to a variable).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { buildSpec } from '../src/commands/spec.js';
import { renderSvg, svgToPng } from '../src/render.js';
import { bindVar, buildFig, buildZip, g, pathBlob, solid, type FigNode } from './helpers/fig-builder.js';
import { modesDemoNodes } from './helpers/modes-demo.js';
import { autoPitch, stylesStr } from '../src/output.js';
import { nameOfFor } from '../src/commands/structure.js';
import { makePng } from './helpers/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-lim-'));
const grad = (r0: number[], r1: number[], extra: Record<string, unknown> = {}) => ({
  type: 'GRADIENT_LINEAR', visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  stops: [{ color: { r: r0[0], g: r0[1], b: r0[2], a: 1 }, position: 0 }, { color: { r: r1[0], g: r1[1], b: r1[2], a: 1 }, position: 1 }], ...extra,
});
const emoji = (cps: number[]) => ({ type: 'EMOJI', opacity: 1, visible: true, blendMode: 'NORMAL', emojiCodePoints: cps });
const meta = (family: string, style: string, fontLineHeight: number, fontWeight: number) => ({ fontMetaData: [{ key: { family, style }, fontLineHeight, fontWeight }] });
const blobs = [pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [2, 0, 10], [0]])];

const nodes = (): FigNode[] => [
  { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
  { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
  { id: [1, 1], type: 'FRAME', name: 'Screen', parent: [0, 1], pos: '!', w: 800, h: 600 },
  // ---- text ranges with gradient, image and emoji paints ----
  { id: [2, 1], type: 'TEXT', name: 'GradRun', parent: [1, 1], pos: '!', w: 300, h: 50, text: 'ab WWWW',
    extra: { fontSize: 40, fontName: { family: 'Inter', style: 'Bold' }, fillPaints: [solid(0, 0, 0)],
      textData: { characters: 'ab WWWW', characterStyleIDs: [0, 0, 0, 1, 1, 1, 1], styleOverrideTable: [{ styleID: 1, fillPaints: [grad([0, 0, 1], [0, 0, 1])] }] } } },
  { id: [2, 2], type: 'TEXT', name: 'ImageRun', parent: [1, 1], pos: '"', w: 300, h: 50, text: 'ab WWWW',
    extra: { fontSize: 40, fontName: { family: 'Inter', style: 'Bold' }, fillPaints: [solid(0, 0, 0)],
      textData: { characters: 'ab WWWW', characterStyleIDs: [0, 0, 0, 1, 1, 1, 1], styleOverrideTable: [{ styleID: 1,
        fillPaints: [{ type: 'IMAGE', imageScaleMode: 'FILL', image: { hash: new Uint8Array([0xab, 0xcd, 0xef]) }, opacity: 1, visible: true }] }] } } },
  // Figma's emoji entry: only the saved glyphs refer to it, characterStyleIDs is absent (octopus Complex.fig 375:15)
  { id: [2, 3], type: 'TEXT', name: 'EmojiRun', parent: [1, 1], pos: '#', w: 300, h: 50, text: '👍 Small',
    extra: { fontSize: 40, fontName: { family: 'Inter', style: 'Regular' }, fillPaints: [solid(0, 0, 0)],
      textData: { characters: '👍 Small', styleOverrideTable: [{ styleID: 1, fillPaints: [emoji([128077])] }] } } },
  // an emoji with a variation selector inside a font range (tds-components 1363:4397)
  { id: [2, 4], type: 'TEXT', name: 'WarnRun', parent: [1, 1], pos: '$', w: 300, h: 50, text: '⚠️ Note',
    extra: { fontSize: 20, fontName: { family: 'Inter', style: 'Regular' }, fillPaints: [solid(0, 0, 0)],
      textData: { characters: '⚠️ Note', characterStyleIDs: [2, 2, 2, 2, 2, 2, 2], styleOverrideTable: [
        { styleID: 2, fontName: { family: 'Inter', style: 'Bold' } }, { styleID: 3, fillPaints: [emoji([9888])] }] } } },
  // characterStyleIDs per code point (octopus Complex.fig 375:16): 11 ids for 13 UTF-16 units
  { id: [2, 5], type: 'TEXT', name: 'AstralRun', parent: [1, 1], pos: '$0', w: 300, h: 50, text: '👍 Emojito 🤣',
    extra: { fontSize: 20, fontName: { family: 'Inter', style: 'Regular' }, fillPaints: [solid(0, 0, 0)],
      textData: { characters: '👍 Emojito 🤣', characterStyleIDs: [6, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9], styleOverrideTable: [
        { styleID: 1, fillPaints: [emoji([128077])] }, { styleID: 2, fillPaints: [emoji([129315])] },
        { styleID: 6, fontName: { family: 'Inter', style: 'Regular' } }, { styleID: 9, fontName: { family: 'Inter', style: 'Bold' } }] } } },
  // text-presentation characters stay text: only an emoji selector or keycap makes them emoji
  { id: [2, 6], type: 'TEXT', name: 'BareRun', parent: [1, 1], pos: '$1', w: 300, h: 50, text: '⚠ warn ⚠️ 1 1️⃣ ©',
    extra: { fontSize: 20, fillPaints: [solid(0, 0, 0)],
      textData: { characters: '⚠ warn ⚠️ 1 1️⃣ ©', styleOverrideTable: [{ styleID: 1, fillPaints: [emoji([9888])] }, { styleID: 2, fillPaints: [emoji([49])] }, { styleID: 3, fillPaints: [emoji([169])] }] } } },
  // skin tone and ZWJ sequences are one emoji each
  { id: [2, 7], type: 'TEXT', name: 'SeqRun', parent: [1, 1], pos: '$2', w: 300, h: 50, text: '👍🏽 👨‍👩‍👧',
    extra: { fontSize: 20, fillPaints: [solid(0, 0, 0)],
      textData: { characters: '👍🏽 👨‍👩‍👧', styleOverrideTable: [{ styleID: 1, fillPaints: [emoji([128077])] }, { styleID: 2, fillPaints: [emoji([128104])] }, { styleID: 3, fillPaints: [emoji([128105])] }] } } },
  // Auto line height (no lineHeight): explicit in spec, with Figma's pitch from the saved natural line height
  { id: [2, 8], type: 'TEXT', name: 'AutoLh', parent: [1, 1], pos: '$3', w: 300, h: 50, text: 'small BIG Other',
    extra: { fontSize: 20, fontName: { family: 'Inter', style: 'Regular' }, derivedTextData: { fontMetaData: [{ key: { family: 'Inter', style: 'Regular' }, fontLineHeight: 1.21, fontWeight: 400 }] },
      textData: { characters: 'small BIG Other', characterStyleIDs: [0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 2, 2, 2, 2, 2], styleOverrideTable: [
        { styleID: 1, fontSize: 30 }, { styleID: 2, fontName: { family: 'Roboto', style: 'Regular' } }] } } },
  { id: [2, 9], type: 'TEXT', name: 'AutoLhUnknown', parent: [1, 1], pos: '$4', w: 300, h: 50, text: 'x', extra: { fontSize: 20 } },
  { id: [2, 10], type: 'TEXT', name: 'FixedLh', parent: [1, 1], pos: '$5', w: 300, h: 50, text: 'x', extra: { fontSize: 20, lineHeight: { value: 30, units: 'PIXELS' } } },
  // letter spacing is printed with its unit (px; percentages are resolved against the font size)
  { id: [2, 11], type: 'TEXT', name: 'Tracking', parent: [1, 1], pos: '$6', w: 300, h: 50, text: 'ab cd',
    extra: { fontSize: 14, fontName: { family: 'Inter', style: 'Medium' }, lineHeight: { value: 20, units: 'PIXELS' }, letterSpacing: { value: 0.1, units: 'PIXELS' },
      textData: { characters: 'ab cd', characterStyleIDs: [0, 0, 0, 1, 1], styleOverrideTable: [{ styleID: 1, letterSpacing: { value: 5, units: 'PERCENT' } }] } } },
  // Figma's saved pitch (legacy, unrounded), an override with another family, a font size under a variable mode, a scaled instance
  { id: [5, 1], type: 'TEXT', name: 'LegacyPitch', parent: [1, 1], pos: '$7', w: 228, h: 197, text: 'Big',
    extra: { fontSize: 56, fontName: { family: 'Roboto', style: 'Bold' }, derivedTextData: { ...meta('Roboto', 'Bold', 1.17, 700), baselines: [{ lineHeight: 65.625 }, { lineHeight: 65.625 }, { lineHeight: 65.625 }] } } },
  { id: [5, 2], type: 'SYMBOL', name: 'Label', parent: [0, 1], pos: 'y0', w: 100, h: 30 },
  { id: [5, 3], type: 'TEXT', name: 'LabelText', parent: [5, 2], pos: '!', w: 100, h: 25, text: 'Hi', ok: [5, 30],
    extra: { fontSize: 21, fontName: { family: 'Inter', style: 'Regular' }, derivedTextData: meta('Inter', 'Regular', 1.17, 400) } },
  { id: [5, 4], type: 'INSTANCE', name: 'OtherFamily', parent: [1, 1], pos: '$8', w: 100, h: 30, symbol: [5, 2],
    overrides: [{ path: [[5, 30]], extra: { fontName: { family: 'Roboto', style: 'Regular' } } }] },
  { id: [5, 5], type: 'INSTANCE', name: 'HalfLabel', parent: [1, 1], pos: '$9', w: 50, h: 15, extra: { symbolData: { symbolID: g([5, 2]), uniformScaleFactor: 0.5 } } },
  { id: [5, 6], type: 'FRAME', name: 'LooseText', parent: [1, 1], pos: '$a', w: 100, h: 40,
    extra: { variableModeBySetMap: { entries: [{ variableSetID: { assetRef: { key: 'dset' } }, variableModeID: g([40, 2]) }] } } },
  { id: [5, 7], type: 'TEXT', name: 'ModeSized', parent: [5, 6], pos: '!', w: 100, h: 20, text: 'x',
    extra: { fontSize: 16, fontName: { family: 'Inter', style: 'Regular' }, derivedTextData: meta('Inter', 'Regular', 1.21, 400), variableConsumptionMap: { entries: [bindVar('FONT_SIZE', 'fsv')] } } },
  { id: [5, 8], type: 'VARIABLE', name: 'type/size', key: 'fsv', setKey: 'dset', varType: 'FLOAT', values: [{ mode: [40, 1], num: 16 }, { mode: [40, 2], num: 24 }] },
  // token references carry their resolved value (alias chain followed, explicit mode applied)
  { id: [6, 1], type: 'VARIABLE_SET', name: 'Colors', key: 'palset', modes: [{ id: [6, 2], name: 'Value' }] },
  { id: [6, 3], type: 'VARIABLE', name: 'colors/red-500', key: 'red500', setKey: 'palset', varType: 'COLOR', values: [{ mode: [6, 2], color: [0.937, 0.267, 0.267, 1] }] },
  { id: [6, 4], type: 'VARIABLE', name: 'colors/red-400', key: 'red400', setKey: 'palset', varType: 'COLOR', values: [{ mode: [6, 2], color: [0.973, 0.443, 0.443, 1] }] },
  { id: [6, 5], type: 'VARIABLE_SET', name: 'Theme', key: 'thmset', modes: [{ id: [6, 6], name: 'Light' }, { id: [6, 7], name: 'Dark' }] },
  { id: [6, 8], type: 'VARIABLE', name: 'theme/destructive', key: 'destr', setKey: 'thmset', varType: 'COLOR', values: [{ mode: [6, 6], alias: 'red500' }, { mode: [6, 7], alias: 'red400' }] },
  { id: [6, 9], type: 'VARIABLE', name: 'radius/lg', key: 'rlg', setKey: 'thmset', varType: 'FLOAT', values: [{ mode: [6, 6], num: 8 }, { mode: [6, 7], num: 8 }] },
  { id: [6, 10], type: 'ROUNDED_RECTANGLE', name: 'Danger', parent: [1, 1], pos: '$b', w: 40, h: 20,
    extra: { cornerRadius: 8, fillPaints: [solid(0.937, 0.267, 0.267, { colorVar: { value: { alias: { assetRef: { key: 'destr' } } }, dataType: 'ALIAS' } })],
      variableConsumptionMap: { entries: [bindVar('CORNER_RADIUS', 'rlg')] } } },
  { id: [6, 11], type: 'FRAME', name: 'DarkTheme', parent: [1, 1], pos: '$c', w: 100, h: 40,
    extra: { variableModeBySetMap: { entries: [{ variableSetID: { assetRef: { key: 'thmset' } }, variableModeID: g([6, 7]) }] } } },
  { id: [6, 12], type: 'ROUNDED_RECTANGLE', name: 'DarkDanger', parent: [6, 11], pos: '!', w: 40, h: 20,
    extra: { fillPaints: [solid(0.937, 0.267, 0.267, { colorVar: { value: { alias: { assetRef: { key: 'destr' } } }, dataType: 'ALIAS' } })] } },
  // alias into another collection (its default mode, not the source's mode name), alias cycle, missing alias target
  { id: [6, 20], type: 'VARIABLE_SET', name: 'Ramp', key: 'rampset', modes: [{ id: [6, 21], name: 'Base' }, { id: [6, 22], name: 'Light' }] },
  { id: [6, 23], type: 'VARIABLE', name: 'ramp/x', key: 'rampx', setKey: 'rampset', varType: 'COLOR', values: [{ mode: [6, 21], color: [0.0667, 0.0667, 0.0667, 1] }, { mode: [6, 22], color: [0.933, 0.933, 0.933, 1] }] },
  { id: [6, 24], type: 'VARIABLE', name: 'theme/accent', key: 'accent', setKey: 'thmset', varType: 'COLOR', values: [{ mode: [6, 6], alias: 'rampx' }, { mode: [6, 7], alias: 'rampx' }] },
  { id: [6, 25], type: 'VARIABLE', name: 'loop/a', key: 'loopa', setKey: 'palset', varType: 'COLOR', values: [{ mode: [6, 2], alias: 'loopb' }] },
  { id: [6, 26], type: 'VARIABLE', name: 'loop/b', key: 'loopb', setKey: 'palset', varType: 'COLOR', values: [{ mode: [6, 2], alias: 'loopa' }] },
  { id: [6, 27], type: 'VARIABLE', name: 'ghost', key: 'ghost', setKey: 'palset', varType: 'COLOR', values: [{ mode: [6, 2], alias: 'nothere' }] },
  { id: [6, 28], type: 'ROUNDED_RECTANGLE', name: 'Accent', parent: [1, 1], pos: '$d', w: 10, h: 10, extra: { fillPaints: [solid(0, 0, 0, { colorVar: { value: { alias: { assetRef: { key: 'accent' } } }, dataType: 'ALIAS' } })] } },
  { id: [6, 29], type: 'ROUNDED_RECTANGLE', name: 'Looped', parent: [1, 1], pos: '$e', w: 10, h: 10, extra: { fillPaints: [solid(0, 0, 0, { colorVar: { value: { alias: { assetRef: { key: 'loopa' } } }, dataType: 'ALIAS' } })] } },
  { id: [6, 30], type: 'ROUNDED_RECTANGLE', name: 'Ghosted', parent: [1, 1], pos: '$f', w: 10, h: 10, extra: { fillPaints: [solid(0, 0, 0, { colorVar: { value: { alias: { assetRef: { key: 'ghost' } } }, dataType: 'ALIAS' } })] } },
  // one line whose saved pitch comes from a bigger range: not the text's own pitch
  { id: [5, 9], type: 'TEXT', name: 'MixedLine', parent: [1, 1], pos: '$g', w: 200, h: 36, text: 'a B',
    extra: { fontSize: 20, fontName: { family: 'Inter', style: 'Regular' }, derivedTextData: { ...meta('Inter', 'Regular', 1.21, 400), baselines: [{ lineHeight: 36 }] },
      textData: { characters: 'a B', characterStyleIDs: [0, 0, 1], styleOverrideTable: [{ styleID: 1, fontSize: 30 }] } } },
  // ---- stroke paints with blend modes ----
  { id: [3, 1], type: 'FRAME', name: 'StrokeBlendBox', parent: [1, 1], pos: '%', w: 40, h: 40, fill: [1, 1, 0] },
  { id: [3, 2], type: 'ROUNDED_RECTANGLE', name: 'TwoStrokes', parent: [3, 1], pos: '!', w: 40, h: 40,
    extra: { strokeWeight: 10, strokeAlign: 'INSIDE', strokePaints: [solid(1, 0, 1), solid(1, 1, 0, { blendMode: 'MULTIPLY' })] } },
  { id: [3, 4], type: 'FRAME', name: 'EllipseBlendBox', parent: [1, 1], pos: '%0', w: 40, h: 40, fill: [1, 1, 0] },
  { id: [3, 5], type: 'ELLIPSE', name: 'EllipseStrokes', parent: [3, 4], pos: '!', w: 40, h: 40,
    extra: { strokeWeight: 10, strokeAlign: 'INSIDE', strokePaints: [solid(1, 0, 1), solid(1, 1, 0, { blendMode: 'MULTIPLY' })] } },
  { id: [3, 6], type: 'FRAME', name: 'BorderBlendBox', parent: [1, 1], pos: '%1', w: 40, h: 40, fill: [1, 1, 0] },
  { id: [3, 7], type: 'ROUNDED_RECTANGLE', name: 'TopBorder', parent: [3, 6], pos: '!', w: 40, h: 40,
    extra: { borderStrokeWeightsIndependent: true, borderTopWeight: 10, strokeWeight: 10, strokePaints: [solid(1, 0, 1), solid(1, 1, 0, { blendMode: 'MULTIPLY' })] } },
  { id: [3, 8], type: 'FRAME', name: 'LineBlendBox', parent: [1, 1], pos: '%2', w: 40, h: 40, fill: [1, 1, 0] },
  { id: [3, 9], type: 'LINE', name: 'BlendLine', parent: [3, 8], pos: '!', w: 40, h: 0, y: 20,
    extra: { strokeWeight: 6, strokePaints: [solid(1, 0, 1), solid(1, 1, 0, { blendMode: 'MULTIPLY' })] } },
  { id: [3, 3], type: 'VECTOR', name: 'VecStrokes', parent: [1, 1], pos: '&', w: 10, h: 10,
    extra: { fillGeometry: [{ commandsBlob: 0 }], fillPaints: [solid(0, 0, 1)], strokeWeight: 4,
      strokePaints: [grad([1, 0, 0], [1, 0, 0]), solid(0, 1, 0, { blendMode: 'SCREEN' })] } },
  ...modesDemoNodes(),
];

let file = '';
const db = () => openIndex(file).db;
const styles = (id: string) => JSON.parse((db().prepare('SELECT styles FROM nodes WHERE id=?').get(id) as { styles: string }).styles ?? '{}');
const specOf = (id: string) => buildSpec(db(), id, { maxTokens: Infinity }).text;
const lineOf = (id: string, name: string) => specOf(id).split('\n').find((l) => l.trimStart().startsWith(`"${name}"`)) ?? '';
const render = (id: string) => renderSvg(db(), id, { assetsDir: path.join(openIndex(file).dir, 'assets'), format: 'fig', background: null });
const box = (svg: string, id: string) => {
  const m = new RegExp(`data-id="${id}" transform="translate\\(([\\d.]+) ([\\d.]+)\\)"`).exec(svg);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
};

/** rendered pixels with the bundled fonts */
async function pixels(svg: string): Promise<{ w: number; at: (x: number, y: number) => number[]; count: (f: (p: number[]) => boolean) => number }> {
  await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 1, 1, 1);
  const mod = await import('@resvg/resvg-wasm');
  const dir = path.join(__dirname, '..', 'assets', 'fonts');
  const fontBuffers = fs.readdirSync(dir).filter((f) => f.endsWith('.ttf')).map((f) => new Uint8Array(fs.readFileSync(path.join(dir, f))));
  const img = new mod.Resvg(svg, { font: { fontBuffers, defaultFontFamily: 'Open Sans', loadSystemFonts: false } }).render();
  const d = img.pixels, w = img.width, h = img.height;
  const at = (x: number, y: number) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
  return { w, at, count: (f) => { let n = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (f(at(x, y))) n++; return n; } };
}

beforeAll(async () => {
  process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache');
  file = path.join(tmp, 'lim.fig');
  fs.writeFileSync(file, buildZip({ 'canvas.fig': buildFig(nodes(), { blobs, version: 101 }), 'images/abcdef': makePng(4, 4, [255, 0, 0, 255]) }));
  await ingest(file, { quiet: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('non-solid paints of text ranges', () => {
  it('prints and draws a gradient range fill', async () => {
    expect(styles('2:1').runs[0]).toMatchObject({ i: 3, n: 4, fill: [{ k: 'grad', t: 'linear' }] });
    expect(lineOf('1:1', 'GradRun')).toMatch(/runs\[3-7 "WWWW" color=linear-gradient\(90deg, #0000ff 0%, #0000ff 100%\)\]/);
    const r = render('2:1');
    expect(r.svg).toMatch(/<tspan fill="url\(#g\d+\)">WWWW<\/tspan>/);
    const px = await pixels(r.svg);
    expect(px.count(([R, G, B, A]) => A > 200 && B > 200 && R < 60 && G < 60)).toBeGreaterThan(100);
  });
  it('prints and draws an image range fill as a pattern', async () => {
    expect(lineOf('1:1', 'ImageRun')).toMatch(/runs\[3-7 "WWWW" color=img\(assets\/[^)]+\)\]/);
    const r = render('2:2');
    expect(r.svg).toMatch(/<pattern id="p\d+"[^>]*><image href="data:image\/png/);
    expect(r.svg).toMatch(/<tspan fill="url\(#p\d+\)">WWWW<\/tspan>/);
    const px = await pixels(r.svg);
    expect(px.count(([R, G, B, A]) => A > 200 && R > 200 && G < 60 && B < 60)).toBeGreaterThan(100);
  });
  it('marks emoji ranges found by their code points and draws them as visible placeholders, not in the text colour', async () => {
    expect(styles('2:3').runs).toEqual([{ i: 0, n: 2, emoji: true }]);
    expect(lineOf('1:1', 'EmojiRun')).toContain('runs[0-2 "👍" emoji]');
    const r = render('2:3');
    expect(r.svg).toContain('fill="#f5c33b">●</tspan>');
    expect(r.notes.join(' ')).toMatch(/Emoji drawn as yellow placeholder/);
    const px = await pixels(r.svg);
    expect(px.count(([R, G, B, A]) => A > 200 && R > 200 && G > 150 && B < 120)).toBeGreaterThan(100);
  });
  it('splits a font range at an emoji and covers its variation selector', () => {
    expect(styles('2:4').runs).toEqual([
      { i: 0, n: 2, font: { f: 'Inter', w: 700, st: null }, emoji: true },
      { i: 2, n: 5, font: { f: 'Inter', w: 700, st: null } },
    ]);
    expect(render('2:4').svg).toMatch(/<tspan font-weight="700" fill="#f5c33b">●<\/tspan>/);
  });
});

describe('style ids per code point; emoji sequences', () => {
  it('reads characterStyleIDs per code point and prints UTF-16 ranges', () => {
    expect(styles('2:5').runs).toMatchObject([{ i: 0, n: 2, emoji: true }, { i: 2, n: 9, font: { w: 700 } }, { i: 11, n: 2, font: { w: 700 }, emoji: true }]);
    expect(lineOf('1:1', 'AstralRun')).toContain('runs[0-2 "👍" emoji; 2-11 "Emojito" w700; 11-13 "🤣" w700 emoji]');
    expect(render('2:5').svg).toMatch(/<tspan fill="#f5c33b">●<\/tspan><tspan font-weight="700"> Emojito <\/tspan><tspan font-weight="700" fill="#f5c33b">●<\/tspan>/);
  });
  it('marks a text-presentation character only with an emoji selector or keycap', () => {
    expect(styles('2:6').runs).toEqual([{ i: 7, n: 2, emoji: true }, { i: 12, n: 3, emoji: true }]);
  });
  it('keeps skin tones and ZWJ sequences in one emoji run, drawn as one disc each', () => {
    expect(styles('2:7').runs).toEqual([{ i: 0, n: 4, emoji: true }, { i: 5, n: 8, emoji: true }]);
    expect(render('2:7').svg.match(/●/g)).toHaveLength(2);
  });
});

describe('Auto line height is printed explicitly', () => {
  it('prints lh-normal with Figma\'s pitch, per range with its own size, without px for another font', () => {
    const l = lineOf('1:1', 'AutoLh');
    expect(l).toContain('font=Inter/20/lh-normal(24px)');
    expect(l).toContain('runs[6-9 "BIG" size=30 lh-normal(36px); 10-15 "Other" font=Roboto lh-normal]');
  });
  it('prints lh-normal without px when the natural line height is unknown; multipliers stay', () => {
    expect(lineOf('1:1', 'AutoLhUnknown')).toMatch(/font=(?:[^ ]*\/)?20\/lh-normal( |$)/);
    expect(lineOf('1:1', 'FixedLh')).toMatch(/\/lh1\.5( |\/|$)/);
  });
});

describe('Auto line height: which pitch', () => {
  it('prints Figma\'s saved (unrounded) pitch when the text has one', () => {
    expect(styles('5:1').font.lpx).toBe(65.625);
    expect(lineOf('1:1', 'LegacyPitch')).toContain('/lh-normal(65.63px)');
  });
  it('drops the component font\'s metrics when an override changes the family', () => {
    expect(lineOf('5:4', 'LabelText')).toMatch(/font=Roboto\/21\/lh-normal( |$)/);
    expect(lineOf('5:2', 'LabelText')).toContain('lh-normal(25px)');
  });
  it('uses the font size of the explicit variable mode', () => {
    expect(lineOf('5:6', 'ModeSized')).toContain('lh-normal(29px)');
  });
  it('scales the unscaled pitch with the instance (round(1.17 × 21) × 0.5)', () => {
    expect(lineOf('5:5', 'LabelText')).toContain('lh-normal(12.5px)');
  });
});

describe('token references with their value', () => {
  it('prints $name(value): alias chains resolved, lengths in px, explicit mode applied', () => {
    expect(lineOf('1:1', 'Danger')).toContain('fill=$theme-destructive(#ef4444) r=$radius-lg(8px)');
    expect(lineOf('6:11', 'DarkDanger')).toContain('fill=$theme-destructive(#f87171)');
    expect(specOf('6:11')).not.toMatch(/\$[\w-]+\{/);
  });
  it('tree/node show the default-mode value', () => {
    const s = JSON.parse((db().prepare('SELECT styles FROM nodes WHERE id=?').get('6:10') as { styles: string }).styles);
    expect(stylesStr(s, { nameOf: nameOfFor(db()) })).toContain('fill=$theme-destructive(#ef4444) r=8 vars=radius:$radius-lg(8px)');
  });
});

describe('token value resolution edge cases', () => {
  it('resolves an alias into another collection in that collection\'s default mode', () => {
    expect(lineOf('1:1', 'Accent')).toContain('fill=$theme-accent(#111111)');
  });
  it('prints a plain $name for an alias cycle or a missing target', () => {
    expect(lineOf('1:1', 'Looped')).toMatch(/fill=\$loop-a( |$)/);
    expect(lineOf('1:1', 'Ghosted')).toMatch(/fill=\$ghost( |$)/);
  });
  it('rejects a saved pitch that does not fit the text\'s own size (one line with a bigger range)', () => {
    expect(styles('5:9').font.lpx).toBe(36);
    expect(lineOf('1:1', 'MixedLine')).toContain('/lh-normal(24px)');
    expect(autoPitch({ nlh: 1.21, s: 20, lpx: 36 })).toBe(24);
    expect(autoPitch({ nlh: 1.21, s: 20, lpx: 24.5 })).toBe(24.5);
  });
});

describe('font units', () => {
  it('prints letter spacing in px (also in ranges); font size stays a px number, lh a unitless multiplier', () => {
    const l = lineOf('1:1', 'Tracking');
    expect(l).toContain('font=Inter/14/w500/lh1.429/ls0.1px');
    expect(l).toContain('runs[3-5 "cd" ls0.7px]');
    expect(l).not.toMatch(/ls[\d.]+(?!px)[\/ \]]/);
  });
});

describe('stroke paint blend modes', () => {
  it('prints each stroke paint with its blend mode', () => {
    expect(lineOf('3:1', 'TwoStrokes')).toContain('stroke=#ff00ff+#ffff00|multiply/10/inner');
  });
  it('draws every stroke paint with its own blend mode (rectangle)', async () => {
    const r = render('3:1');
    expect(r.svg).toMatch(/stroke="#ffff00" style="mix-blend-mode:multiply"/);
    const px = await pixels(r.svg);
    expect(px.at(3, 20)).toEqual([255, 0, 0, 255]); // yellow multiply over magenta
    expect(px.at(20, 20)).toEqual([255, 255, 0, 255]); // the frame inside the stroke
  });
  it('draws blended stroke paints on ellipses, per-side borders and lines', async () => {
    let px = await pixels(render('3:4').svg);
    expect(px.at(3, 20)).toEqual([255, 0, 0, 255]);
    expect(px.at(20, 20)).toEqual([255, 255, 0, 255]);
    px = await pixels(render('3:6').svg);
    expect(px.at(20, 3)).toEqual([255, 0, 0, 255]);
    expect(px.at(20, 30)).toEqual([255, 255, 0, 255]);
    px = await pixels(render('3:8').svg);
    expect(px.at(20, 20)).toEqual([255, 0, 0, 255]);
    expect(px.at(20, 30)).toEqual([255, 255, 0, 255]);
  });
  it('creates one paint server per paint of a text, not one per line or segment', () => {
    const svg = render('2:2').svg;
    expect(svg.match(/<pattern /g)).toHaveLength(1);
  });
  it('draws gradient strokes and blended stroke paints on vectors', async () => {
    const r = render('3:3');
    expect(r.svg).toMatch(/<path d="[^"]+" fill="none" stroke="url\(#g\d+\)"/);
    expect(r.svg).toMatch(/fill="none" stroke="#00ff00" style="mix-blend-mode:screen"/);
    const px = await pixels(r.svg);
    expect(px.at(1, 5)).toEqual([255, 255, 0, 255]); // green screen red
    expect(px.at(5, 5)).toEqual([0, 0, 255, 255]);
  });
});

describe('auto layout under an explicit variable mode (gap, padding, size)', () => {
  it('prints the mode values', () => {
    expect(lineOf('40:32', 'Card loose')).toMatch(/col gap=\$space-gap\(24px\) pad=\$space-pad\(20px\)/);
  });
  it('keeps the saved layout without a mode', () => {
    const svg = render('40:31').svg;
    expect(box(svg, '40:21')).toEqual([12, 12]);
    expect(box(svg, '40:23')).toEqual([12, 68]);
  });
  it('re-lays out an instance under the mode: positions and hug size', () => {
    const r = render('40:32');
    expect([r.w, r.h]).toEqual([140, 148]);
    expect(box(r.svg, '40:21')).toEqual([20, 20]);
    expect(box(r.svg, '40:22')).toEqual([20, 64]);
    expect(box(r.svg, '40:23')).toEqual([20, 108]);
    expect(r.notes.join(' ')).toMatch(/Auto layout re-solved/);
  });
  it('propagates the new size to the auto-layout parent; other geometry stays saved', () => {
    const r = render('40:10');
    expect([r.w, r.h]).toEqual([400, 340]);
    expect(box(r.svg, '40:31')).toEqual([20, 20]);
    expect(box(r.svg, '40:32')).toEqual([180, 20]);
    expect(box(r.svg, '40:42')).toEqual([150, 0]); // after the 140 wide card and the row gap of 10
    expect(r.svg).toMatch(/data-id="40:40" transform="translate\(20 180\)"/);
  });
});
