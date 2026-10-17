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
import { buildFig, buildZip, pathBlob, solid, type FigNode } from './helpers/fig-builder.js';
import { modesDemoNodes } from './helpers/modes-demo.js';
import { makePng } from './helpers/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-lim-'));
const grad = (r0: number[], r1: number[], extra: Record<string, unknown> = {}) => ({
  type: 'GRADIENT_LINEAR', visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  stops: [{ color: { r: r0[0], g: r0[1], b: r0[2], a: 1 }, position: 0 }, { color: { r: r1[0], g: r1[1], b: r1[2], a: 1 }, position: 1 }], ...extra,
});
const emoji = (cps: number[]) => ({ type: 'EMOJI', opacity: 1, visible: true, blendMode: 'NORMAL', emojiCodePoints: cps });
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
    expect(lineOf('40:32', 'Card loose')).toMatch(/col gap=\$space-gap\{24\} pad=\$space-pad\{20\}/);
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
