// Field semantics of .fig records, each pinned to what Figma itself saved in real files (see README 0.1.3 changelog):
// auto-layout defaults, line-height units, shared styles, override breadth, variable bindings, groups, masks, transforms.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { buildSpec } from '../src/commands/spec.js';
import { Evaluator, type VNode } from '../src/instances.js';
import { renderSvg, svgToPng } from '../src/render.js';
import { bindVar, buildFig, buildZip, g, pathBlob, solid, type FigNode } from './helpers/fig-builder.js';
import { makePng } from './helpers/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-sem-'));
const UNSET = { guid: { sessionID: 4294967295, localID: 4294967295 } };
const px = (value: number) => ({ value, units: 'PIXELS' });
const meta = (family: string, style: string, fontLineHeight: number, fontWeight: number) => ({ fontMetaData: [{ key: { family, style }, fontLineHeight, fontWeight }] });
const tf = (m00: number, m01: number, m02: number, m10: number, m11: number, m12: number) => ({ transform: { m00, m01, m02, m10, m11, m12 } });

// blobs: 0 = 10x10 square, 1 = small square (region), 2 = derived outline at instance size (20x20), 3 = rotated vector outline
const blobs = [
  pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [2, 0, 10], [0]]),
  pathBlob([[1, 2, 2], [2, 4, 2], [2, 4, 4], [2, 2, 4], [0]]),
  pathBlob([[1, -1, -1], [2, 21, -1], [2, 21, 21], [2, -1, 21], [0]]),
  pathBlob([[1, 0, 0], [2, 40, 0], [2, 40, 10], [2, 0, 10], [0]]),
];

const nodes = (): FigNode[] => [
  { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
  { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
  { id: [1, 1], type: 'FRAME', name: 'Screen', parent: [0, 1], pos: '!', w: 800, h: 600 },
  // ---- auto layout (F01, F06, F09) ----
  { id: [1, 2], type: 'FRAME', name: 'HugRow', parent: [1, 1], pos: '!', w: 91, h: 32, stack: 'HORIZONTAL', gap: 6,
    extra: { stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackHorizontalPadding: 10, stackVerticalPadding: 6 } },
  { id: [1, 3], type: 'FRAME', name: 'FixedRow', parent: [1, 1], pos: '"', w: 200, h: 40, stack: 'HORIZONTAL',
    extra: { stackPrimarySizing: 'FIXED', stackHorizontalPadding: 16, stackPaddingRight: 4, stackVerticalPadding: 8 } },
  { id: [1, 4], type: 'FRAME', name: 'Between', parent: [1, 1], pos: '#', w: 300, h: 48, stack: 'HORIZONTAL', gap: 10, extra: { stackPrimarySizing: 'FIXED', stackPrimaryAlignItems: 'SPACE_EVENLY' } },
  { id: [1, 5], type: 'FRAME', name: 'Around', parent: [1, 1], pos: '$', w: 300, h: 48, stack: 'VERTICAL', extra: { stackPrimaryAlignItems: 'SPACE_AROUND' } },
  { id: [1, 6], type: 'FRAME', name: 'Evenly', parent: [1, 1], pos: '%', w: 300, h: 48, stack: 'VERTICAL', extra: { stackPrimaryAlignItems: 'SPACE_EVENLY_CSS' } },
  { id: [1, 7], type: 'FRAME', name: 'Grid', parent: [1, 1], pos: '&', w: 300, h: 100, extra: { stackMode: 'GRID' } },
  { id: [1, 8], type: 'FRAME', name: 'Cell', parent: [1, 7], pos: '!', w: 40, h: 40, x: 33.7, y: 10 },
  // ---- groups, masks, constraints, transforms (F10, F13, F14, F34) ----
  { id: [2, 1], type: 'FRAME', name: 'Image', parent: [1, 1], pos: "'", w: 70, h: 44, x: 10, y: 300, extra: { resizeToFit: true, frameMaskDisabled: false } },
  { id: [2, 2], type: 'VECTOR', name: 'Mirrored', parent: [2, 1], pos: '!', w: 10, h: 10, extra: { ...tf(-1, 0, 70, 0, 1, 7), fillGeometry: [{ commandsBlob: 0 }], fillPaints: [solid(1, 0, 0)] } },
  { id: [2, 3], type: 'ROUNDED_RECTANGLE', name: 'MaskShape', parent: [2, 1], pos: '"', w: 40, h: 40, fill: [0, 0, 0], extra: { mask: true, cornerRadius: 20 } },
  { id: [2, 4], type: 'ROUNDED_RECTANGLE', name: 'Masked', parent: [2, 1], pos: '#', w: 70, h: 44, fill: [0, 1, 0] },
  { id: [2, 5], type: 'FRAME', name: 'Overlay', parent: [1, 1], pos: '(', w: 200, h: 100, x: 400, y: 300 },
  { id: [2, 6], type: 'FRAME', name: 'Close', parent: [2, 5], pos: '!', w: 16, h: 16, x: 176, y: 8, extra: { horizontalConstraint: 'MAX', verticalConstraint: 'SCALE' } },
  { id: [2, 7], type: 'VECTOR', name: 'Rotated', parent: [2, 5], pos: '"', w: 40, h: 10, x: 20, y: 50, extra: { ...tf(0, 1, 20, -1, 0, 50), fillGeometry: [{ commandsBlob: 3 }], fillPaints: [solid(0, 0, 1)] } },
  // ---- corners (F08) ----
  { id: [3, 1], type: 'FRAME', name: 'Segment', parent: [1, 1], pos: ')', w: 50, h: 20,
    extra: { cornerRadius: 6, rectangleCornerRadiiIndependent: true, rectangleTopRightCornerRadius: 6, rectangleBottomRightCornerRadius: 6, strokePaints: [solid(0, 0, 0)], strokeWeight: 1, strokeAlign: 'INSIDE', fillPaints: [solid(1, 1, 1)] } },
  // radius partly bound to a variable: unbound corners keep their numbers
  { id: [3, 5], type: 'FRAME', name: 'HalfBound', parent: [1, 1], pos: ')0', w: 50, h: 20,
    extra: { rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 6, rectangleTopRightCornerRadius: 4, variableConsumptionMap: { entries: [bindVar('RECTANGLE_TOP_LEFT_CORNER_RADIUS', 'rmd')] } } },
  // a rotated child of a flex parent: no position or visual box in spec
  { id: [3, 6], type: 'FRAME', name: 'FlexParent', parent: [1, 1], pos: ')1', w: 100, h: 40, stack: 'HORIZONTAL' },
  { id: [3, 7], type: 'ROUNDED_RECTANGLE', name: 'Tilted', parent: [3, 6], pos: '!', w: 10, h: 10, fill: [0, 0, 0], extra: { ...tf(0, 1, 0, -1, 0, 10) } },
  // an avatar: rounded mask over an image that reaches far outside the group
  { id: [2, 8], type: 'FRAME', name: 'Avatar', parent: [1, 1], pos: '(0', w: 40, h: 40, x: 600, y: 10, extra: { resizeToFit: true, frameMaskDisabled: false } },
  { id: [2, 9], type: 'ROUNDED_RECTANGLE', name: 'AvatarMask', parent: [2, 8], pos: '!', w: 40, h: 40, fill: [0, 0, 0], extra: { mask: true, cornerRadius: 20 } },
  { id: [2, 10], type: 'ROUNDED_RECTANGLE', name: 'AvatarImage', parent: [2, 8], pos: '"', w: 1200, h: 600, x: -500, y: -200,
    extra: { fillPaints: [{ type: 'IMAGE', imageScaleMode: 'FILL', image: { hash: new Uint8Array([0xab, 0xcd, 0xef]) }, opacity: 1, visible: true }] } },
  { id: [3, 2], type: 'FRAME', name: 'IndepNone', parent: [1, 1], pos: '*', w: 50, h: 20, extra: { cornerRadius: 16, rectangleCornerRadiiIndependent: true } },
  { id: [3, 3], type: 'FRAME', name: 'Stale', parent: [1, 1], pos: '+', w: 50, h: 20, extra: { cornerRadius: 8, rectangleTopLeftCornerRadius: 4, rectangleTopRightCornerRadius: 4, rectangleBottomRightCornerRadius: 4, rectangleBottomLeftCornerRadius: 4 } },
  { id: [3, 4], type: 'VECTOR', name: 'VecR', parent: [1, 1], pos: ',', w: 10, h: 10, extra: { cornerRadius: 6, fillGeometry: [{ commandsBlob: 0 }], fillPaints: [solid(0, 0, 0)] } },
  // ---- text (F02, F03, F12) ----
  { id: [4, 1], type: 'TEXT', name: 'Auto', parent: [1, 1], pos: '-', w: 24, h: 22, text: 'Ag',
    extra: { fontSize: 18, fontName: { family: 'Inter', style: 'Medium' }, lineHeight: { value: 100, units: 'PERCENT' }, derivedTextData: meta('Inter', 'Medium', 1.21, 500) } },
  { id: [4, 2], type: 'TEXT', name: 'Raw', parent: [1, 1], pos: '.', w: 24, h: 22, text: 'Ag', extra: { fontSize: 14, fontName: { family: 'Inter', style: 'Regular' }, lineHeight: { value: 1.4, units: 'RAW' } } },
  { id: [4, 3], type: 'TEXT', name: 'Pct', parent: [1, 1], pos: '/', w: 24, h: 22, text: 'Ag',
    extra: { fontSize: 13, fontName: { family: 'Titillium', style: 'Regular' }, lineHeight: { value: 125, units: 'PERCENT' }, derivedTextData: meta('Titillium', 'Regular', 1.2, 400) } },
  { id: [4, 4], type: 'TEXT', name: 'Styled', parent: [1, 1], pos: '0', w: 100, h: 20, text: 'Label',
    extra: { fontSize: 12, fontName: { family: 'Google Sans Text', style: 'Regular' }, lineHeight: px(16), styleIdForText: { assetRef: { key: 'tstyle' } }, styleIdForFill: { guid: g([9, 2]) }, fillPaints: [solid(0.2, 0, 0.6)] } },
  { id: [4, 5], type: 'TEXT', name: 'Attrs', parent: [1, 1], pos: '1', w: 100, h: 40, text: 'Hello world',
    extra: { fontSize: 14, fontName: { family: 'Inter', style: 'Italic' }, textCase: 'UPPER', textAlignVertical: 'CENTER', textTruncation: 'ENDING', maxLines: 2, textDecoration: 'UNDERLINE' } },
  { id: [4, 6], type: 'TEXT', name: 'List', parent: [1, 1], pos: '2', w: 100, h: 40, text: 'One\nTwo\nThree',
    extra: { fontSize: 14, textData: { characters: 'One\nTwo\nThree', lines: [{ lineType: 'UNORDERED_LIST', indentationLevel: 1 }, { lineType: 'UNORDERED_LIST', indentationLevel: 2 }, { lineType: 'PLAIN' }] } } },
  { id: [4, 9], type: 'TEXT', name: 'PctStyled', parent: [1, 1], pos: '2a', w: 100, h: 20, text: 'Ag',
    extra: { fontSize: 13, fontName: { family: 'Titillium', style: 'Regular' }, lineHeight: px(16), styleIdForText: { assetRef: { key: 'pctstyle' } }, derivedTextData: meta('Titillium', 'Regular', 1.1499, 400) } },
  { id: [4, 7], type: 'TEXT', name: 'Bound', parent: [1, 1], pos: '3', w: 100, h: 20, text: 'stale literal', extra: { fontSize: 14, parameterConsumptionMap: { entries: [bindVar('TEXT_DATA', 'labelvar')] } } },
  // ---- shared styles: effect and stroke on a frame, defined AFTER their consumers (F11) ----
  { id: [4, 8], type: 'FRAME', name: 'Card', parent: [1, 1], pos: '4', w: 100, h: 50,
    extra: { styleIdForEffect: { guid: g([9, 3]) }, effects: [], styleIdForStrokeFill: { guid: g([9, 2]) }, strokeWeight: 2, strokePaints: [solid(0, 0, 0)] } },
  // ---- variables on layout (F07) ----
  { id: [5, 1], type: 'FRAME', name: 'Tokens', parent: [1, 1], pos: '5', w: 100, h: 40, stack: 'HORIZONTAL', gap: 8,
    extra: { stackHorizontalPadding: 16, stackPaddingRight: 16, cornerRadius: 6,
      variableConsumptionMap: { entries: [bindVar('STACK_SPACING', 'oldgap'), bindVar('STACK_PADDING_LEFT', 'sp4'), bindVar('CORNER_RADIUS', 'rmd'), bindVar('OPACITY', 'cleared')] },
      parameterConsumptionMap: { entries: [bindVar('STACK_SPACING', 'sp2'), bindVar('STACK_PADDING_RIGHT', 'sp4'), bindVar('OPACITY')] } } },
  // ---- vectors: regions, polygon, arc, effects, image crop, gradient, dash (F15, F18-F21, F33) ----
  { id: [6, 1], type: 'VECTOR', name: 'Logo', parent: [1, 1], pos: '6', w: 10, h: 10,
    extra: { fillGeometry: [{ commandsBlob: 0, styleID: 0 }, { commandsBlob: 1, styleID: 2, windingRule: 'ODD' }], fillPaints: [solid(1, 1, 0)],
      vectorData: { styleOverrideTable: [{ styleID: 2, fillPaints: [solid(0, 0, 1)] }] } } },
  { id: [6, 10], type: 'VECTOR', name: 'StyledOutline', parent: [1, 1], pos: '6a', w: 10, h: 10,
    extra: { strokeWeight: 2, strokeGeometry: [{ commandsBlob: 0 }], styleIdForStrokeFill: { guid: g([9, 10]) } } },
  { id: [6, 2], type: 'REGULAR_POLYGON', name: 'Penta', parent: [1, 1], pos: '7', w: 10, h: 10, extra: { count: 5, fillPaints: [solid(0, 0, 0)] } },
  { id: [6, 3], type: 'ELLIPSE', name: 'Ring', parent: [1, 1], pos: '8', w: 10, h: 10, extra: { arcData: { startingAngle: 0, endingAngle: 3.14, innerRadius: 0.5 }, fillGeometry: [{ commandsBlob: 0 }], fillPaints: [solid(0, 0, 0)] } },
  { id: [6, 4], type: 'FRAME', name: 'Fx', parent: [1, 1], pos: '9', w: 10, h: 10, extra: { effects: [{ type: 'NOISE', radius: 4, visible: true }, { type: 'FOREGROUND_BLUR', radius: 8, visible: true }] } },
  { id: [6, 5], type: 'ROUNDED_RECTANGLE', name: 'Photo', parent: [1, 1], pos: ':', w: 100, h: 50,
    extra: { fillPaints: [{ type: 'IMAGE', imageScaleMode: 'STRETCH', image: { hash: new Uint8Array([0xab, 0xcd, 0xef]) }, opacity: 0.6, visible: true, transform: { m00: 0.5, m01: 0, m02: 0.25, m10: 0, m11: 0.5, m12: 0.25 } }] } },
  { id: [6, 6], type: 'ROUNDED_RECTANGLE', name: 'Grad', parent: [1, 1], pos: ';', w: 200, h: 100,
    extra: { fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, stops: [{ color: { r: 1, g: 1, b: 1, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 0, a: 1 }, position: 1 }] }] } },
  { id: [6, 7], type: 'ROUNDED_RECTANGLE', name: 'Dashed', parent: [1, 1], pos: '<', w: 100, h: 20, extra: { strokePaints: [solid(0, 0, 0)], strokeWeight: 1, dashPattern: [4, 2] } },
  { id: [6, 8], type: 'SLICE', name: 'Export region', parent: [1, 1], pos: '=', w: 100, h: 100 },
  { id: [6, 9], type: 'TEXT_PATH', name: 'Curved', parent: [1, 1], pos: '>', w: 100, h: 100, text: 'around the circle', extra: { fontSize: 12 } },
  // ---- component with a stroke-only icon, nested auto layout and per-corner frame; instance with overrides (F04, F05, F16) ----
  { id: [7, 1], type: 'SYMBOL', name: 'Button', parent: [0, 1], pos: '"', w: 120, h: 40, stack: 'HORIZONTAL', gap: 4,
    extra: { stackPrimarySizing: 'FIXED', strokePaints: [solid(0, 0, 0)], strokeWeight: 1, cornerRadius: 4 } },
  { id: [7, 2], type: 'VECTOR', name: 'icon', parent: [7, 1], pos: '!', w: 10, h: 10, ok: [8, 2],
    extra: { strokePaints: [solid(0.094, 0.094, 0.106)], strokeWeight: 1.5, strokeGeometry: [{ commandsBlob: 0 }] } },
  { id: [7, 3], type: 'TEXT', name: 'Label', parent: [7, 1], pos: '"', w: 60, h: 20, text: 'Button', ok: [8, 3], extra: { fontSize: 14, lineHeight: px(20), textAutoResize: 'WIDTH_AND_HEIGHT' } },
  { id: [7, 4], type: 'FRAME', name: 'Inner', parent: [7, 1], pos: '#', w: 20, h: 20, ok: [8, 4], stack: 'VERTICAL', extra: { stackPrimarySizing: 'FIXED' } },
  { id: [7, 5], type: 'INSTANCE', name: 'Primary', parent: [1, 1], pos: '?', w: 140, h: 40, symbol: [7, 1],
    overrides: [
      { path: [[8, 2]], extra: { strokePaints: [solid(0.063, 0.094, 0.157)], styleIdForStrokeFill: UNSET } },
      { path: [[8, 3]], extra: { size: { x: 70, y: 20 }, lineHeight: { value: 100, units: 'PERCENT' }, textAlignVertical: 'BOTTOM', textCase: 'UPPER' } },
      { path: [[8, 4]], extra: { stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackChildPrimaryGrow: 1, stackVerticalPadding: 4,
        rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 6, opacity: 0.5, effects: [{ type: 'DROP_SHADOW', radius: 4, offset: { x: 0, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.25 }, visible: true }] } },
      { path: [[7, 1]], extra: { strokeWeight: 3, styleIdForFill: { guid: g([9, 2]) } } },
    ],
    derived: [{ path: [[8, 2]], w: 20, h: 20, x: 5, y: 5, extra: { strokeGeometry: [{ commandsBlob: 2 }] } }],
    extra: { strokePaints: [solid(0, 0, 0)], strokeWeight: 1, cornerRadius: 4 } },
  { id: [7, 6], type: 'INSTANCE', name: 'NoIcon', parent: [1, 1], pos: '@', w: 120, h: 40, symbol: [7, 1],
    overrides: [{ path: [[8, 2]], extra: { strokePaints: [] } }] },
  // ---- style records and variables (Internal Only Canvas, after their consumers) ----
  { id: [0, 2], type: 'CANVAS', name: 'Internal Only Canvas', parent: [0, 0], pos: '~' },
  { id: [9, 1], type: 'TEXT', name: 'M3/label/large', parent: [0, 2], pos: '!', w: 10, h: 10, text: 'Ag',
    extra: { key: 'tstyle', styleType: 'TEXT', fontSize: 14, fontName: { family: 'Roboto', style: 'Medium' }, lineHeight: px(20), letterSpacing: { value: 0.5, units: 'PIXELS' } } },
  { id: [9, 9], type: 'TEXT', name: 'Body/125', parent: [0, 2], pos: '!0', w: 10, h: 10, text: 'Ag',
    extra: { key: 'pctstyle', styleType: 'TEXT', fontSize: 13, fontName: { family: 'Titillium', style: 'Regular' }, lineHeight: { value: 125, units: 'PERCENT' }, derivedTextData: meta('Titillium', 'Regular', 1.3, 400) } },
  { id: [9, 10], type: 'ROUNDED_RECTANGLE', name: 'Icon/Stroke', parent: [0, 2], pos: '!1', w: 10, h: 10, fill: [0, 0.5, 0], extra: { styleType: 'FILL' } },
  { id: [9, 2], type: 'ROUNDED_RECTANGLE', name: 'M3/sys/light/primary', parent: [0, 2], pos: '"', w: 10, h: 10, fill: [0.4, 0.31, 0.64], extra: { styleType: 'FILL' } },
  { id: [9, 3], type: 'ROUNDED_RECTANGLE', name: 'Drop Shadow/xs', parent: [0, 2], pos: '#', w: 10, h: 10,
    extra: { styleType: 'EFFECT', effects: [{ type: 'DROP_SHADOW', radius: 2, offset: { x: 0, y: 1 }, color: { r: 0, g: 0, b: 0, a: 0.1 }, visible: true }] } },
  { id: [9, 4], type: 'VARIABLE_SET', name: 'Spacing', key: 'spset', modes: [{ id: [9, 0], name: 'Default' }] },
  { id: [9, 5], type: 'VARIABLE', name: 'spacing/2', key: 'sp2', setKey: 'spset', varType: 'FLOAT', values: [{ mode: [9, 0], num: 8 }] },
  { id: [9, 6], type: 'VARIABLE', name: 'spacing/4', key: 'sp4', setKey: 'spset', varType: 'FLOAT', values: [{ mode: [9, 0], num: 16 }] },
  { id: [9, 7], type: 'VARIABLE', name: 'radius/md', key: 'rmd', setKey: 'spset', varType: 'FLOAT', values: [{ mode: [9, 0], num: 6 }] },
  { id: [9, 8], type: 'VARIABLE', name: 'label', key: 'labelvar', setKey: 'spset', varType: 'STRING', values: [{ mode: [9, 0], str: 'From variable' }] },
];

let file = '';
const db = () => openIndex(file).db;
const row = (id: string) => db().prepare('SELECT * FROM nodes WHERE id=?').get(id) as any;
const styles = (id: string) => JSON.parse(row(id).styles ?? '{}');
const layout = (id: string) => JSON.parse(row(id).layout ?? '{}');
const raw = (id: string) => JSON.parse(row(id).raw ?? '{}');
const specOf = (id: string) => buildSpec(db(), id, { maxTokens: Infinity }).text;
const lineOf = (id: string, name: string) => specOf(id).split('\n').find((l) => l.trimStart().startsWith(`"${name}"`)) ?? '';

beforeAll(async () => {
  process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache');
  file = path.join(tmp, 'sem.fig');
  fs.writeFileSync(file, buildZip({ 'canvas.fig': buildFig(nodes(), { blobs, version: 101 }), 'images/abcdef': makePng(4, 4, [255, 0, 0, 255]) }));
  await ingest(file, { quiet: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('auto layout (F01, F06, F09)', () => {
  it('reads an absent primary sizing as hug and an absent counter sizing as fixed', () => {
    expect(layout('1:2')).toMatchObject({ dir: 'row', w: 'hug', h: 'hug' });
    expect(layout('1:3').w).toBeUndefined();
    expect(layout('1:3').h).toBeUndefined();
    expect(lineOf('1:1', 'HugRow')).toContain('hug(91)×hug(32)');
  });
  it('reads absent trailing paddings as 0', () => {
    expect(layout('1:2').pad).toEqual([6, 0, 0, 10]);
    expect(layout('1:3').pad).toEqual([8, 4, 0, 16]);
  });
  it('maps SPACE_EVENLY to space-between (gap ignored) and the CSS-like values to around/evenly', () => {
    expect(layout('1:4').jc).toBe('between');
    expect(layout('1:4').gap).toBeUndefined();
    expect(layout('1:5').jc).toBe('around');
    expect(layout('1:6').jc).toBe('evenly');
  });
  it('marks GRID frames as grid; their children keep saved positions', () => {
    expect(layout('1:7').dir).toBe('grid');
    expect(lineOf('1:1', 'Grid')).toMatch(/ grid/);
    expect(lineOf('1:1', 'Cell')).toContain('@33.7,10');
  });
});

describe('groups, masks, transforms, constraints (F10, F13, F14, F34)', () => {
  it('reports FRAME + resizeToFit as a non-clipping group', () => {
    expect(row('2:1').type).toBe('group');
    expect(styles('2:1').clip).toBeUndefined();
    expect(lineOf('1:1', 'Image')).toMatch(/"Image" group 70×44/);
  });
  it('marks masks in spec and renders them as a mask of the following siblings', () => {
    expect(lineOf('1:1', 'MaskShape')).toContain(' mask');
    const svg = renderSvg(db(), '2:1', { assetsDir: '', format: 'fig' }).svg;
    expect(svg).toMatch(/<mask id="m\d+"[^>]*>.*data-id="2:3"/);
    expect(svg).toMatch(/<g mask="url\(#m\d+\)"><g data-id="2:4"/);
  });
  it('keeps mirroring: flip flag, full matrix and the visual box', () => {
    expect(styles('2:2')).toMatchObject({ flip: 'x' });
    expect(styles('2:2').rot).toBeUndefined();
    expect(raw('2:2').m).toEqual([-1, 0, 0, 1]);
    expect(lineOf('1:1', 'Mirrored')).toContain('visual@60,7 10×10');
    expect(lineOf('1:1', 'Mirrored')).toContain('flip=x');
    const svg = renderSvg(db(), '2:1', { assetsDir: '', format: 'fig' }).svg;
    expect(svg).toContain('transform="matrix(-1 0 0 1 70 7)"');
  });
  it('exports a rotated vector inside its transformed bounds', () => {
    // rot 90 (counter-clockwise): the 40×10 box becomes 10×40 above its origin
    expect(styles('2:7').rot).toBe(90);
    expect(lineOf('1:1', 'Rotated')).toContain('visual@20,10 10×40');
    const r = renderSvg(db(), '2:7', { assetsDir: '', format: 'fig', background: null });
    expect([r.w, r.h]).toEqual([10, 40]);
    expect(r.svg).toMatch(/matrix\(0 -1 1 0 0 40\)/);
  });
  it('prints constraints of absolutely positioned layers, SCALE included', () => {
    expect(raw('2:6')).toMatchObject({ hConstraint: 'MAX', vConstraint: 'SCALE' });
    expect(lineOf('1:1', 'Close')).toContain('pin=right,scale-y');
  });
});

describe('corner radius (F08)', () => {
  it('uses per-corner fields with absent = 0 when independent, else cornerRadius', () => {
    expect(styles('3:1').r).toEqual([0, 6, 6, 0]);
    expect(styles('3:2').r).toBeUndefined();
    expect(styles('3:3').r).toBe(8);
  });
  it('reports no radius for vectors (baked into the outline)', () => {
    expect(styles('3:4').r).toBeUndefined();
  });
});

describe('text (F02, F03, F12)', () => {
  it('reads {100, PERCENT} as the font\'s normal line height', () => {
    const f = styles('4:1').font;
    expect(f.lh).toBeUndefined();
    expect(f.nlh).toBe(1.21);
    expect(f.w).toBe(500);
    expect(lineOf('1:1', 'Auto')).toMatch(/font=Inter\/18\/w500( |$)/);
  });
  it('reads RAW as a multiplier and other PERCENT values as % of the natural line height', () => {
    expect(styles('4:2').font.lh).toBe(1.4);
    expect(styles('4:3').font.lh).toBe(1.5);
  });
  it('lets the text style and fill style win over stale inline values and names them', () => {
    const s = styles('4:4');
    expect(s.font).toMatchObject({ f: 'Roboto', s: 14, w: 500, lh: 1.429, ls: 0.5 });
    expect(s.fill).toEqual([{ k: 'solid', c: '#664fa3' }]);
    expect(s.sty).toEqual({ text: 'M3/label/large', fill: 'M3/sys/light/primary' });
    expect(lineOf('1:1', 'Styled')).toContain('styles{text:"M3/label/large",fill:"M3/sys/light/primary"}');
  });
  it('prints text case, vertical alignment, truncation, lists; "Italic" is the regular weight', () => {
    const f = styles('4:5').font;
    expect(f).toMatchObject({ case: 'upper', va: 'center', trunc: 2, w: 400, st: 'italic', deco: 'underline' });
    const l = lineOf('1:1', 'Attrs');
    expect(l).toContain('case=upper');
    expect(l).toContain('valign=center');
    expect(l).toContain('truncate lines=2');
    expect(lineOf('1:1', 'List')).toContain('list=ul,ul2,-');
  });
  it('shows the value of a STRING variable bound to the text', () => {
    expect(row('4:7').text).toBe('From variable');
  });
});

describe('fill/stroke/effect styles (F11)', () => {
  it('resolves styles defined after their consumers in the stream', () => {
    const s = styles('4:8');
    expect(s.fx).toEqual([{ k: 'shadow', x: 0, y: 1, blur: 2, c: '#0000001a' }]);
    expect(s.stroke.paints).toEqual([{ k: 'solid', c: '#664fa3' }]);
    expect(s.sty).toEqual({ effect: 'Drop Shadow/xs', stroke: 'M3/sys/light/primary' });
  });
});

describe('variable bindings (F07)', () => {
  it('reads both maps; parameter entries replace legacy ones, bare entries clear', () => {
    expect(styles('5:1').vars).toEqual({ gap: 'sp2', 'pad-left': 'sp4', 'pad-right': 'sp4', radius: 'rmd' });
  });
  it('prints token names in place of bound numbers', () => {
    const l = lineOf('1:1', 'Tokens');
    expect(l).toContain('gap=$spacing-2');
    expect(l).toContain('pad=0,$spacing-4');
    expect(l).toContain('r=$radius-md');
  });
});

describe('vectors, paints, effects (F15, F18-F21, F28, F33)', () => {
  it('draws per-region fills with their own winding rule', () => {
    expect(raw('6:1').regions).toEqual({ 2: [{ k: 'solid', c: '#0000ff' }] });
    const svg = renderSvg(db(), '6:1', { assetsDir: '', format: 'fig', background: null }).svg;
    expect(svg).toMatch(/<path d="M0 0L10 0L10 10L0 10Z" fill="#ffff00"/);
    expect(svg).toMatch(/<path d="M2 2L4 2L4 4L2 4Z" fill="#0000ff" fill-rule="evenodd"/);
  });
  it('reads the polygon count and draws ellipse arcs from their saved outline', () => {
    expect(raw('6:2').polygonCount).toBe(5);
    expect(raw('6:3').arc).toBeDefined();
    expect(renderSvg(db(), '6:3', { assetsDir: '', format: 'fig', background: null }).svg).toContain('<path d="M0 0L10 0');
  });
  it('ignores unknown effect types instead of turning them into a blur', () => {
    expect(styles('6:4').fx).toEqual([{ k: 'blur', blur: 8 }]);
  });
  it('reads STRETCH image paints as crop with transform and opacity', () => {
    const p = styles('6:5').fill[0];
    expect(p).toMatchObject({ k: 'img', mode: 'crop', o: 0.6, tf: [0.5, 0, 0.25, 0, 0.5, 0.25] });
    const svg = renderSvg(db(), '6:5', { assetsDir: path.join(openIndex(file).dir, 'assets'), format: 'fig' }).svg;
    expect(svg).toContain('transform="matrix(200 0 0 100 -50 -25)"');
    expect(svg).toContain('fill-opacity="0.6"');
    expect(svg).toMatch(/<pattern [^>]*width="100" height="50"/);
  });
  it('prints gradient direction and stop positions', () => {
    expect(lineOf('1:1', 'Grad')).toContain('fill=linear-gradient(90deg, #ffffff 0%, #000000 100%)');
  });
  it('prints dash patterns', () => {
    expect(lineOf('1:1', 'Dashed')).toContain('/dash4,2');
  });
  it('drops slices and extracts text on a path', () => {
    expect(row('6:8')).toBeUndefined();
    expect(row('6:9')).toMatchObject({ type: 'text', text: 'around the circle' });
  });
});

describe('instance overrides (F04, F05, F16)', () => {
  const tree = (): VNode => new Evaluator(db(), { maxDepth: 99, cap: 1000 }).build(row('7:5'));
  const kid = (t: VNode, name: string) => t.kids.find((k) => k.row.name === name)!;
  it('recolours the visible outline of a stroke-only icon and draws the saved outline unscaled', () => {
    const icon = kid(tree(), 'icon');
    const s = JSON.parse(icon.row.styles!);
    expect(s.fill).toEqual([{ k: 'solid', c: '#101828' }]);
    expect(s.stroke).toBeUndefined();
    const svg = renderSvg(db(), icon.row.id, { assetsDir: '', format: 'fig', background: null, vnode: icon }).svg;
    expect(svg).toContain('fill="#101828"');
    expect(svg).not.toContain('scale(');
  });
  it('applies size-only, text and layout overrides', () => {
    const t = tree();
    const label = kid(t, 'Label');
    expect([label.row.w, label.row.h]).toEqual([70, 20]);
    const f = JSON.parse(label.row.styles!).font;
    expect(f.lh).toBeUndefined(); // set back to auto
    expect(f).toMatchObject({ va: 'bottom', case: 'upper' });
    const inner = kid(t, 'Inner');
    expect(JSON.parse(inner.row.layout!)).toMatchObject({ dir: 'col', h: 'hug', w: 'fill', pad: [4, 0, 0, 0] });
    const s = JSON.parse(inner.row.styles!);
    expect(s).toMatchObject({ r: [6, 0, 0, 0], op: 0.5 });
    expect(s.fx[0]).toMatchObject({ k: 'shadow', blur: 4 });
  });
  it('applies stroke weight and fill-style overrides addressed to the instance root', () => {
    const s = JSON.parse(tree().row.styles!);
    expect(s.stroke.w).toBe(3);
    expect(s.fill).toEqual([{ k: 'solid', c: '#664fa3' }]);
  });
});

describe('format detection (F27)', () => {
  it('accepts fig-deck with a warning and does not warn for v101', async () => {
    const deck = path.join(tmp, 'deck.fig');
    fs.writeFileSync(deck, buildFig(nodes().slice(0, 3), { magic: 'fig-deck', version: 101 }));
    await ingest(deck, { quiet: true });
    const warns = (openIndex(deck).db.prepare('SELECT msg FROM warnings').all() as { msg: string }[]).map((w) => w.msg);
    expect(warns.some((w) => /fig-deck/.test(w))).toBe(true);
    expect(warns.some((w) => /untested/.test(w))).toBe(false);
  });
});

/** RGBA pixels of an SVG (resvg-wasm, initialised through svgToPng) */
async function pixels(svg: string, w: number): Promise<{ at: (x: number, y: number) => number[] }> {
  await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 1, 1, 1);
  const mod = await import('@resvg/resvg-wasm');
  const img = new mod.Resvg(svg).render();
  const d = img.pixels;
  return { at: (x, y) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)) };
}

describe('renderer regressions', () => {
  it('draws strokes and clips of per-corner radii with each corner (A)', () => {
    const svg = renderSvg(db(), '3:1', { assetsDir: '', format: 'fig' }).svg;
    expect(svg).not.toMatch(/rx="/);
    // the inside stroke follows the corners: square on the left, 5.5 (6 - half the stroke) on the right
    expect(svg).toContain('<path d="M0.5 0.5H44A5.5 5.5 0 0 1 49.5 6V14A5.5 5.5 0 0 1 44 19.5H0.5L0.5 19.5V0.5L0.5 0.5Z" fill="none" stroke="#000000"');
  });
  it('shows an image masked by a rounded shape although it reaches far outside the canvas (B)', async () => {
    const r = renderSvg(db(), '2:8', { assetsDir: path.join(openIndex(file).dir, 'assets'), format: 'fig', background: null });
    expect(r.svg).not.toMatch(/<mask[\s\S]*clip-path=[\s\S]*<\/svg>/);
    const px = await pixels(r.svg, r.w);
    expect(px.at(20, 20)).toEqual([255, 0, 0, 255]); // image inside the mask
    expect(px.at(1, 1)[3]).toBe(0); // rounded corner masked away
  });
});

describe('review fixes', () => {
  it('prints numbers for corners a partial radius binding leaves unbound', () => {
    expect(lineOf('1:1', 'HalfBound')).toContain('r=$radius-md,4,0,0');
  });
  it('resolves a percentage line height of a text style against the consumer\'s font', () => {
    // 125 % of the drawn font's natural height (1.1499), not of a guessed 1.2 or of the style record's font
    expect(styles('4:9').font.lh).toBe(1.437);
  });
  it('prints no position or visual box for children of flex parents', () => {
    const l = lineOf('1:1', 'Tilted');
    expect(l).not.toContain('visual@');
    expect(l).toContain('rot=90');
  });
  it('turns a stroke-only vector whose paint comes from a stroke style into its outline', () => {
    const s = styles('6:10');
    expect(raw('6:10').geometryFrom).toBe('stroke');
    expect(s.fill).toEqual([{ k: 'solid', c: '#008000' }]);
    expect(s.stroke).toBeUndefined();
  });
  it('hides an outline icon whose instance clears its stroke paints', () => {
    const t = new Evaluator(db(), { maxDepth: 99, cap: 1000 }).build(row('7:6'));
    const icon = t.kids.find((k) => k.row.name === 'icon')!;
    expect(JSON.parse(icon.row.styles ?? '{}').fill).toBeUndefined();
  });
});
