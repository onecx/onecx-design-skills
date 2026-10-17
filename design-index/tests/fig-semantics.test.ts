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

const grad = (type: string) => ({ type, visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }] });
const modeMap = (mode: [number, number]) => ({ variableModeBySetMap: { entries: [{ variableSetID: { assetRef: { key: 'thset' } }, variableModeID: g(mode) }] } });

// round 2 (0.1.4): the findings 0.1.3 left open
const more = (): FigNode[] => [
  // ---- mixed text styles, links, leading trim (F12) ----
  { id: [20, 1], type: 'TEXT', name: 'Mixed', parent: [1, 1], pos: 'a0', w: 200, h: 20, text: 'Hello big world',
    extra: { fontName: { family: 'Inter', style: 'Regular' }, fillPaints: [solid(0, 0, 0)],
      // ids for "big" only: the missing trailing entries are 0 (the text's own style)
      textData: { characters: 'Hello big world', characterStyleIDs: [0, 0, 0, 0, 0, 0, 1, 1, 1],
        styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' }, textDecoration: 'UNDERLINE', fillPaints: [solid(1, 0, 0)], hyperlink: { url: 'https://example.com/big' } }] } } },
  { id: [20, 2], type: 'TEXT', name: 'StyledRuns', parent: [1, 1], pos: 'a1', w: 200, h: 20, text: 'Read the terms now',
    extra: { fontName: { family: 'Inter', style: 'Regular' }, fillPaints: [solid(0.5, 0.5, 0.5)],
      textData: { characters: 'Read the terms now', characterStyleIDs: [0, 0, 0, 0, 0, 2, 2, 2, 0, 3, 3, 3, 3, 3], styleOverrideTable: [
        { styleID: 2, styleIdForFill: { guid: g([9, 2]) } },
        { styleID: 3, styleIdForText: { assetRef: { key: 'tstyle' } }, isOverrideOverTextStyle: true, fontName: { family: 'Roboto', style: 'Bold' } }] } } },
  { id: [20, 3], type: 'TEXT', name: 'NodeLink', parent: [1, 1], pos: 'a2', w: 40, h: 20, text: 'Go', extra: { hyperlink: { guid: g([1, 2]) }, leadingTrim: 'CAP_HEIGHT', textDecoration: 'UNDERLINE' } },
  { id: [20, 4], type: 'SYMBOL', name: 'Chip', parent: [0, 1], pos: 'a3', w: 100, h: 20 },
  { id: [20, 5], type: 'TEXT', name: 'ChipLabel', parent: [20, 4], pos: '!', w: 100, h: 20, text: 'Ab', ok: [20, 50],
    extra: { textData: { characters: 'Ab', characterStyleIDs: [1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' } }] } } },
  { id: [20, 6], type: 'INSTANCE', name: 'ChipNew', parent: [1, 1], pos: 'a4', w: 100, h: 20, symbol: [20, 4], overrides: [{ path: [[20, 50]], text: 'Cd' }] },
  // ---- blend modes and reverse paint order (F23) ----
  { id: [21, 1], type: 'FRAME', name: 'BlendBox', parent: [1, 1], pos: 'b0', w: 20, h: 20, x: 700, y: 500, fill: [1, 1, 0] },
  { id: [21, 2], type: 'ROUNDED_RECTANGLE', name: 'Multiply', parent: [21, 1], pos: '!', w: 20, h: 20, fill: [0, 1, 1], extra: { blendMode: 'MULTIPLY' } },
  { id: [21, 3], type: 'FRAME', name: 'PaintBlendBox', parent: [1, 1], pos: 'b1', w: 20, h: 20, x: 730, y: 500, fill: [1, 1, 0] },
  { id: [21, 4], type: 'ROUNDED_RECTANGLE', name: 'ScreenPaint', parent: [21, 3], pos: '!', w: 20, h: 20, extra: { fillPaints: [solid(0, 0, 1, { blendMode: 'SCREEN' })] } },
  { id: [27, 1], type: 'FRAME', name: 'Stacked', parent: [1, 1], pos: 'b2', w: 20, h: 20, stack: 'HORIZONTAL', extra: { stackReverseZIndex: true } },
  { id: [27, 2], type: 'ROUNDED_RECTANGLE', name: 'First', parent: [27, 1], pos: '!', w: 20, h: 20, fill: [1, 0, 0] },
  { id: [27, 3], type: 'ROUNDED_RECTANGLE', name: 'Second', parent: [27, 1], pos: '"', w: 20, h: 20, fill: [0, 0, 1] },
  // ---- angular and diamond gradients (F20) ----
  { id: [22, 1], type: 'ROUNDED_RECTANGLE', name: 'Sweep', parent: [1, 1], pos: 'c0', w: 100, h: 100, extra: { fillPaints: [grad('GRADIENT_ANGULAR')] } },
  { id: [22, 2], type: 'ROUNDED_RECTANGLE', name: 'Diamond', parent: [1, 1], pos: 'c1', w: 100, h: 100, extra: { fillPaints: [grad('GRADIENT_DIAMOND')] } },
  // ---- mask types; a clipping frame inside a mask (F13) ----
  { id: [23, 1], type: 'FRAME', name: 'OutlineMaskGroup', parent: [1, 1], pos: 'd0', w: 40, h: 40, extra: { resizeToFit: true } },
  { id: [23, 2], type: 'ROUNDED_RECTANGLE', name: 'OutlineMask', parent: [23, 1], pos: '!', w: 20, h: 40, extra: { mask: true, maskType: 'OUTLINE', fillPaints: [solid(0, 0, 0, { opacity: 0.2 })] } },
  { id: [23, 3], type: 'ROUNDED_RECTANGLE', name: 'OutlineMasked', parent: [23, 1], pos: '"', w: 40, h: 40, fill: [1, 0, 0] },
  { id: [23, 4], type: 'FRAME', name: 'LumaMaskGroup', parent: [1, 1], pos: 'd1', w: 40, h: 40, extra: { resizeToFit: true } },
  { id: [23, 5], type: 'ROUNDED_RECTANGLE', name: 'LumaMask', parent: [23, 4], pos: '!', w: 40, h: 40,
    extra: { mask: true, maskType: 'LUMINANCE', fillPaints: [{ ...grad('GRADIENT_LINEAR'), stops: [{ color: { r: 1, g: 1, b: 1, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 0, a: 1 }, position: 1 }] }] } },
  { id: [23, 6], type: 'ROUNDED_RECTANGLE', name: 'LumaMasked', parent: [23, 4], pos: '"', w: 40, h: 40, fill: [1, 0, 0] },
  { id: [23, 7], type: 'FRAME', name: 'ClipInMask', parent: [1, 1], pos: 'd2', w: 40, h: 40, extra: { resizeToFit: true } },
  { id: [23, 8], type: 'ROUNDED_RECTANGLE', name: 'RoundMask', parent: [23, 7], pos: '!', w: 40, h: 40, fill: [0, 0, 0], extra: { mask: true, cornerRadius: 20 } },
  { id: [23, 9], type: 'FRAME', name: 'Clipper', parent: [23, 7], pos: '"', w: 40, h: 40 },
  { id: [23, 10], type: 'ROUNDED_RECTANGLE', name: 'Huge', parent: [23, 9], pos: '!', w: 4000, h: 4000, x: -2000, y: -2000, fill: [0, 0, 1] },
  // ---- uniformScaleFactor (F17): the content is scaled, saved derived data wins ----
  { id: [24, 1], type: 'SYMBOL', name: 'Star', parent: [0, 1], pos: 'e0', w: 20, h: 20, stack: 'HORIZONTAL', gap: 4, extra: { stackHorizontalPadding: 2 } },
  { id: [24, 2], type: 'ROUNDED_RECTANGLE', name: 'StarBody', parent: [24, 1], pos: '!', w: 10, h: 10, x: 4, y: 6, ok: [24, 20], extra: { strokePaints: [solid(0, 0, 0)], strokeWeight: 2, cornerRadius: 4, fillPaints: [solid(1, 0.8, 0)] } },
  { id: [24, 3], type: 'TEXT', name: 'StarLabel', parent: [24, 1], pos: '"', w: 10, h: 12, text: 'x', ok: [24, 30], extra: { fontSize: 10 } },
  { id: [24, 6], type: 'FRAME', name: 'StarInner', parent: [24, 1], pos: '#', w: 8, h: 8, ok: [24, 60], stack: 'VERTICAL', gap: 2, extra: { stackHorizontalPadding: 4 } },
  { id: [24, 4], type: 'INSTANCE', name: 'HalfStar', parent: [1, 1], pos: 'e1', w: 10, h: 10, extra: { symbolData: { symbolID: g([24, 1]), uniformScaleFactor: 0.5 } } },
  { id: [24, 5], type: 'INSTANCE', name: 'HalfStarSaved', parent: [1, 1], pos: 'e2', w: 10, h: 10, extra: { symbolData: { symbolID: g([24, 1]), uniformScaleFactor: 0.5 } },
    derived: [{ path: [[24, 30]], w: 7, h: 7, x: 1, y: 1 }] },
  // ---- explicit variable modes for numbers and text (F31, F07) ----
  { id: [25, 1], type: 'FRAME', name: 'DarkZone', parent: [1, 1], pos: 'f0', w: 100, h: 40, extra: modeMap([9, 21]) },
  { id: [25, 2], type: 'ROUNDED_RECTANGLE', name: 'ModeRadius', parent: [25, 1], pos: '!', w: 40, h: 40, fill: [0, 0, 0], extra: { cornerRadius: 4, variableConsumptionMap: { entries: [bindVar('CORNER_RADIUS', 'radvar')] } } },
  { id: [25, 3], type: 'TEXT', name: 'ModeText', parent: [25, 1], pos: '"', w: 60, h: 20, text: 'stale', extra: { parameterConsumptionMap: { entries: [bindVar('TEXT_DATA', 'txtvar')] } } },
  { id: [25, 4], type: 'SYMBOL', name: 'Greeting', parent: [0, 1], pos: 'f1', w: 60, h: 20 },
  { id: [25, 5], type: 'TEXT', name: 'GreetingText', parent: [25, 4], pos: '!', w: 60, h: 20, text: 'stale', extra: { parameterConsumptionMap: { entries: [bindVar('TEXT_DATA', 'txtvar')] } } },
  { id: [25, 6], type: 'INSTANCE', name: 'DarkGreeting', parent: [25, 1], pos: '#', w: 60, h: 20, symbol: [25, 4] },
  { id: [25, 7], type: 'INSTANCE', name: 'OwnModeGreeting', parent: [1, 1], pos: 'f2', w: 60, h: 20, symbol: [25, 4], extra: modeMap([9, 21]) },
  { id: [9, 20], type: 'VARIABLE_SET', name: 'Theme', key: 'thset', modes: [{ id: [9, 22], name: 'Light' }, { id: [9, 21], name: 'Dark' }] },
  { id: [9, 23], type: 'VARIABLE', name: 'radius/card', key: 'radvar', setKey: 'thset', varType: 'FLOAT', values: [{ mode: [9, 22], num: 4 }, { mode: [9, 21], num: 12 }] },
  { id: [9, 24], type: 'VARIABLE', name: 'greeting', key: 'txtvar', setKey: 'thset', varType: 'STRING', values: [{ mode: [9, 22], str: 'Hello' }, { mode: [9, 21], str: 'Hallo' }] },
  // ---- the same property definition id on two component sets (F22); SetB comes first in the stream ----
  { id: [26, 4], type: 'FRAME', name: 'SetB', parent: [0, 1], pos: 'g0', w: 100, h: 100, extra: { isStateGroup: true }, defs: [{ id: [60, 1], name: 'Caption', init: { t: 'From B' }, type: 'TEXT' }] },
  { id: [26, 5], type: 'SYMBOL', name: 'Kind=B', parent: [26, 4], pos: '!', w: 50, h: 20, defs: [{ id: [60, 2], parent: [60, 1] }] },
  { id: [26, 6], type: 'TEXT', name: 'LabelB', parent: [26, 5], pos: '!', w: 50, h: 20, text: 'x', refs: [{ def: [60, 2], field: 'TEXT_DATA' }] },
  { id: [26, 1], type: 'FRAME', name: 'SetA', parent: [0, 1], pos: 'g1', w: 100, h: 100, extra: { isStateGroup: true }, defs: [{ id: [60, 1], name: 'Label', init: { t: 'From A' }, type: 'TEXT' }] },
  { id: [26, 2], type: 'SYMBOL', name: 'Kind=A', parent: [26, 1], pos: '!', w: 50, h: 20, defs: [{ id: [60, 2], parent: [60, 1] }] },
  { id: [26, 3], type: 'TEXT', name: 'LabelA', parent: [26, 2], pos: '!', w: 50, h: 20, text: 'x', refs: [{ def: [60, 2], field: 'TEXT_DATA' }] },
  { id: [26, 7], type: 'INSTANCE', name: 'UsesA', parent: [1, 1], pos: 'g2', w: 50, h: 20, symbol: [26, 2] },
  { id: [26, 8], type: 'INSTANCE', name: 'UsesB', parent: [1, 1], pos: 'g3', w: 50, h: 20, symbol: [26, 5] },
  { id: [26, 9], type: 'INSTANCE', name: 'AssignsA', parent: [1, 1], pos: 'g4', w: 50, h: 20, symbol: [26, 2], assign: [{ def: [60, 2], v: { t: 'Given' } }] },
  { id: [26, 10], type: 'INSTANCE', name: 'AssignsB', parent: [1, 1], pos: 'g5', w: 50, h: 20, symbol: [26, 5], assign: [{ def: [60, 2], v: { t: 'Given' } }] },
  // ---- approximations: a detached fill style without paints; a heavier stroke on an outline icon ----
  { id: [28, 1], type: 'SYMBOL', name: 'Tag', parent: [0, 1], pos: 'i0', w: 40, h: 20 },
  { id: [28, 2], type: 'ROUNDED_RECTANGLE', name: 'TagBg', parent: [28, 1], pos: '!', w: 40, h: 20, ok: [28, 20], extra: { styleIdForFill: { guid: g([9, 2]) }, fillPaints: [solid(0, 0.5, 0)] } },
  { id: [28, 3], type: 'INSTANCE', name: 'Detached', parent: [1, 1], pos: 'i1', w: 40, h: 20, symbol: [28, 1], overrides: [{ path: [[28, 20]], extra: { styleIdForFill: UNSET } }] },
  { id: [28, 4], type: 'INSTANCE', name: 'BoldIcon', parent: [1, 1], pos: 'i2', w: 120, h: 40, symbol: [7, 1], overrides: [{ path: [[8, 2]], extra: { strokeWeight: 3 } }] },
  // ---- review round: outline masks without fills, deep blends, outranked text, scale hints, link clearing, case, surrogates ----
  { id: [30, 1], type: 'FRAME', name: 'FrameMaskGroup', parent: [1, 1], pos: 'j0', w: 20, h: 20, extra: { resizeToFit: true } },
  { id: [30, 2], type: 'FRAME', name: 'FrameMask', parent: [30, 1], pos: '!', w: 20, h: 20, extra: { mask: true, maskType: 'OUTLINE', frameMaskDisabled: true } },
  { id: [30, 3], type: 'ROUNDED_RECTANGLE', name: 'FrameMaskDot', parent: [30, 2], pos: '!', w: 10, h: 10, fill: [0, 0, 0] },
  { id: [30, 4], type: 'ROUNDED_RECTANGLE', name: 'FrameMasked', parent: [30, 1], pos: '"', w: 20, h: 20, fill: [1, 0, 0] },
  { id: [30, 5], type: 'SYMBOL', name: 'DotIcon', parent: [0, 1], pos: 'j1', w: 20, h: 20, extra: { frameMaskDisabled: true } },
  { id: [30, 6], type: 'ROUNDED_RECTANGLE', name: 'DotIconDot', parent: [30, 5], pos: '!', w: 10, h: 10, fill: [0, 0, 0] },
  { id: [30, 7], type: 'FRAME', name: 'InstMaskGroup', parent: [1, 1], pos: 'j2', w: 20, h: 20, extra: { resizeToFit: true } },
  { id: [30, 8], type: 'INSTANCE', name: 'InstMask', parent: [30, 7], pos: '!', w: 20, h: 20, symbol: [30, 5], extra: { mask: true, maskType: 'OUTLINE', frameMaskDisabled: true } },
  { id: [30, 9], type: 'ROUNDED_RECTANGLE', name: 'InstMasked', parent: [30, 7], pos: '"', w: 20, h: 20, fill: [1, 0, 0] },
  { id: [30, 10], type: 'ROUNDED_RECTANGLE', name: 'LegacyOutline', parent: [30, 7], pos: '#', w: 20, h: 20, extra: { mask: true, maskIsOutline: true } },
  { id: [31, 1], type: 'FRAME', name: 'DeepBlend', parent: [1, 1], pos: 'k0', w: 20, h: 20, fill: [1, 1, 0] },
  { id: [31, 2], type: 'FRAME', name: 'Wrapper', parent: [31, 1], pos: '!', w: 20, h: 20, extra: { frameMaskDisabled: true } },
  { id: [31, 3], type: 'ROUNDED_RECTANGLE', name: 'DeepMultiply', parent: [31, 2], pos: '!', w: 20, h: 20, fill: [0, 1, 1], extra: { blendMode: 'MULTIPLY' } },
  { id: [32, 1], type: 'SYMBOL', name: 'Inner', parent: [0, 1], pos: 'k1', w: 40, h: 20, defs: [{ id: [32, 9], init: { t: 'Ab' }, name: 'Label', type: 'TEXT' }] },
  { id: [32, 2], type: 'TEXT', name: 'InnerText', parent: [32, 1], pos: '!', w: 40, h: 20, text: 'Ab', ok: [32, 20], refs: [{ def: [32, 9], field: 'TEXT_DATA' }],
    extra: { textData: { characters: 'Ab', characterStyleIDs: [1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' } }] } } },
  { id: [32, 3], type: 'SYMBOL', name: 'Outer', parent: [0, 1], pos: 'k2', w: 40, h: 20 },
  { id: [32, 4], type: 'INSTANCE', name: 'InnerUse', parent: [32, 3], pos: '!', w: 40, h: 20, symbol: [32, 1], ok: [32, 40],
    overrides: [{ path: [[32, 20]], extra: { textData: { characters: 'Zz', characterStyleIDs: [0, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' } }] } } }] },
  { id: [32, 5], type: 'INSTANCE', name: 'OuterUse', parent: [1, 1], pos: 'k3', w: 40, h: 20, symbol: [32, 3], overrides: [{ path: [[32, 40]], assign: [{ def: [32, 9], v: { t: 'Ab' } }] }] },
  { id: [33, 1], type: 'INSTANCE', name: 'HalfButton', parent: [1, 1], pos: 'k4', w: 60, h: 20, extra: { symbolData: { symbolID: g([7, 1]), uniformScaleFactor: 0.5 } } },
  { id: [34, 1], type: 'FRAME', name: 'PipeText', parent: [1, 1], pos: 'k5', w: 40, h: 20 },
  { id: [34, 2], type: 'TEXT', name: 'Pipe', parent: [34, 1], pos: '!', w: 40, h: 20, text: 'a|multiply runs[x] link=y' },
  { id: [35, 1], type: 'SYMBOL', name: 'Linked', parent: [0, 1], pos: 'k6', w: 40, h: 20 },
  { id: [35, 2], type: 'TEXT', name: 'LinkedText', parent: [35, 1], pos: '!', w: 40, h: 20, text: 'Go', ok: [35, 20], extra: { hyperlink: { url: 'https://example.com' } } },
  { id: [35, 3], type: 'INSTANCE', name: 'Unlinked', parent: [1, 1], pos: 'k7', w: 40, h: 20, symbol: [35, 1], overrides: [{ path: [[35, 20]], extra: { hyperlink: {} } }] },
  { id: [36, 1], type: 'TEXT', name: 'Sharp', parent: [1, 1], pos: 'k8', w: 400, h: 20, text: 'Straße x',
    extra: { textCase: 'UPPER', fontName: { family: 'Inter', style: 'Regular' }, textData: { characters: 'Straße x', characterStyleIDs: [0, 0, 0, 0, 0, 0, 0, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' } }] } } },
  { id: [36, 2], type: 'TEXT', name: 'Emoji', parent: [1, 1], pos: 'k9', w: 400, h: 20, text: '😀 hi',
    extra: { fontName: { family: 'Inter', style: 'Regular' }, textData: { characters: '😀 hi', characterStyleIDs: [0, 0, 1, 1], styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Bold' } }] } } },
  { id: [36, 3], type: 'TEXT', name: 'Linky', parent: [1, 1], pos: 'l0', w: 400, h: 20, text: 'one two',
    extra: { fontName: { family: 'Inter', style: 'Regular' }, hyperlink: { url: 'https://a.example' }, textData: { characters: 'one two', characterStyleIDs: [1, 1, 1, 0, 2, 2, 2], styleOverrideTable: [
      { styleID: 1, fontName: { family: 'Inter', style: 'Bold' }, hyperlink: { url: 'https://a.example' } }, { styleID: 2, hyperlink: { url: 'https://b.example' } }] } } },
  { id: [37, 1], type: 'FRAME', name: 'BrandDark', parent: [1, 1], pos: 'l1', w: 60, h: 20,
    extra: { variableModeBySetMap: { entries: [{ variableSetID: { assetRef: { key: 'brset' } }, variableModeID: g([9, 32]) }] } } },
  { id: [37, 2], type: 'TEXT', name: 'ThemeText', parent: [37, 1], pos: '!', w: 60, h: 20, text: 'stale', extra: { parameterConsumptionMap: { entries: [bindVar('TEXT_DATA', 'txtvar')] } } },
  { id: [9, 30], type: 'VARIABLE_SET', name: 'Brand', key: 'brset', modes: [{ id: [9, 31], name: 'Default' }, { id: [9, 32], name: 'Dark' }] },
  { id: [22, 3], type: 'ROUNDED_RECTANGLE', name: 'OneStopDiamond', parent: [1, 1], pos: 'c2', w: 100, h: 100,
    extra: { fillPaints: [{ ...grad('GRADIENT_DIAMOND'), transform: { m00: 0.7, m01: 0.7, m02: -0.2, m10: -0.7, m11: 0.7, m12: 0.5 }, stops: [{ color: { r: 0, g: 0.05, b: 0.3, a: 1 }, position: 0.35 }] }] } },
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
  fs.writeFileSync(file, buildZip({ 'canvas.fig': buildFig([...nodes(), ...more()], { blobs, version: 101 }), 'images/abcdef': makePng(4, 4, [255, 0, 0, 255]) }));
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

// ---------------------------------------------------------------------------------------------------------------------
// 0.1.4: findings left open by 0.1.3
const build = (id: string): VNode => new Evaluator(db(), { maxDepth: 99, cap: 1000 }).build(row(id));
const kidNamed = (t: VNode, name: string): VNode => {
  const stack = [t];
  while (stack.length) { const v = stack.shift()!; if (v.row.name === name) return v; stack.push(...v.kids); }
  throw new Error(`no ${name}`);
};
const st = (v: VNode) => JSON.parse(v.row.styles ?? '{}');
const render = (id: string, assets = '') => renderSvg(db(), id, { assetsDir: assets, format: 'fig', background: null });

describe('mixed text styles, links, leading trim (F12)', () => {
  it('turns characterStyleIDs + styleOverrideTable into ranges (missing trailing ids = the text\'s own style)', () => {
    expect(styles('20:1').runs).toEqual([{ i: 6, n: 3, font: { f: 'Inter', w: 700, st: null, deco: 'underline' }, fill: [{ k: 'solid', c: '#ff0000' }], link: 'https://example.com/big' }]);
    expect(lineOf('1:1', 'Mixed')).toContain('runs[6-9 "big" w700 underline color=#ff0000 link=https://example.com/big]');
  });
  it('resolves a range\'s fill style and text style; the range\'s own font wins when it overrides its style', () => {
    const runs = styles('20:2').runs;
    expect(runs[0]).toEqual({ i: 5, n: 3, fill: [{ k: 'solid', c: '#664fa3' }], sty: { fill: 'M3/sys/light/primary' } });
    expect(runs[1]).toMatchObject({ i: 9, n: 5, font: { f: 'Roboto', s: 14, w: 700 }, sty: { text: 'M3/label/large' } });
    expect(runs[1].tsid).toBeUndefined();
    const l = lineOf('1:1', 'StyledRuns');
    expect(l).toContain('5-8 "the" color=#664fa3 styles{fill:"M3/sys/light/primary"}');
    expect(l).toMatch(/9-14 "terms" font=Roboto size=14 w700 .*styles\{text:"M3\/label\/large"\}/);
  });
  it('draws each range as its own tspan', () => {
    const svg = render('20:1').svg;
    expect(svg).toMatch(/<tspan font-weight="700" text-decoration="underline" fill="#ff0000">big<\/tspan>/);
    expect(svg).toContain('Hello ');
  });
  it('prints node links and cap-height trim', () => {
    expect(styles('20:3')).toMatchObject({ link: '#1:2', font: { trim: 'cap' } });
    const l = lineOf('1:1', 'NodeLink');
    expect(l).toContain('link=#1:2');
    expect(l).toContain('trim=cap');
    // the first baseline sits at the cap height (0.7 × 16), not at the half-leading baseline
    expect(render('20:3').svg).toMatch(/<tspan x="0" y="11\.2">/);
  });
  it('drops the ranges when an instance replaces the characters', () => {
    expect(styles('20:5').runs).toHaveLength(1);
    const label = kidNamed(build('20:6'), 'ChipLabel');
    expect(label.row.text).toBe('Cd');
    expect(st(label).runs).toBeUndefined();
  });
});

describe('blend modes and paint order (F23)', () => {
  it('reads layer and paint blend modes and prints them', () => {
    expect(styles('21:2').blend).toBe('multiply');
    expect(styles('21:4').fill).toEqual([{ k: 'solid', c: '#0000ff', bm: 'screen' }]);
    expect(lineOf('21:1', 'Multiply')).toContain('blend=multiply');
    expect(lineOf('21:3', 'ScreenPaint')).toContain('fill=#0000ff|screen');
  });
  it('blends with the parent frame\'s paint in the renderer (inside its clip)', async () => {
    let r = render('21:1');
    expect(r.svg).toContain('mix-blend-mode:multiply');
    expect((await pixels(r.svg, r.w)).at(10, 10)).toEqual([0, 255, 0, 255]); // yellow × cyan
    r = render('21:3');
    expect((await pixels(r.svg, r.w)).at(10, 10)).toEqual([255, 255, 255, 255]); // yellow screen blue
  });
  it('paints the first child on top under stackReverseZIndex', async () => {
    expect(raw('27:1').revZ).toBe(true);
    expect(lineOf('1:1', 'Stacked')).toContain('z-reverse');
    const r = render('27:1');
    expect((await pixels(r.svg, r.w)).at(10, 10)).toEqual([255, 0, 0, 255]);
  });
});

describe('angular and diamond gradients (F20)', () => {
  it('prints conic and diamond notation', () => {
    expect(lineOf('1:1', 'Sweep')).toContain('fill=conic-gradient(from 90deg at 50% 50%, #ff0000 0%, #0000ff 100%)');
    expect(lineOf('1:1', 'Diamond')).toContain('fill=diamond-gradient(');
  });
  it('draws an angular gradient clockwise from the first handle', async () => {
    const r = render('22:1');
    expect(r.notes.join(' ')).not.toMatch(/drawn as/);
    const px = await pixels(r.svg, r.w);
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
    expect(near(px.at(95, 52), [255, 0, 0, 255])).toBe(true); // just after the start: first stop
    expect(near(px.at(95, 47), [0, 0, 255, 255])).toBe(true); // just before the end: last stop
    expect(near(px.at(50, 95), [191, 0, 64, 255])).toBe(true); // a quarter turn (down)
  });
  it('draws a diamond gradient with L1 contours through the handles', async () => {
    const r = render('22:2');
    const px = await pixels(r.svg, r.w);
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 12);
    expect(near(px.at(50, 50), [255, 0, 0, 255])).toBe(true);
    expect(near(px.at(75, 50), [128, 0, 128, 255])).toBe(true); // halfway to the handle
    expect(near(px.at(62, 62), [128, 0, 128, 255])).toBe(true); // same L1 distance on the diagonal
    expect(near(px.at(98, 98), [0, 0, 255, 255])).toBe(true);
  });
});

describe('mask types; clips inside masks (F13)', () => {
  it('uses only the shape of an OUTLINE mask (its paint opacity does not count)', async () => {
    expect(lineOf('1:1', 'OutlineMask')).toContain('mask(outline)');
    const r = render('23:1');
    const px = await pixels(r.svg, r.w);
    expect(px.at(10, 20)).toEqual([255, 0, 0, 255]);
    expect(px.at(30, 20)[3]).toBe(0);
  });
  it('uses luminance × alpha for a LUMINANCE mask', async () => {
    const r = render('23:4');
    const px = await pixels(r.svg, r.w);
    expect(px.at(1, 20)[3]).toBeGreaterThan(230);
    expect(px.at(38, 20)[3]).toBeLessThan(25);
  });
  it('keeps a clipping frame\'s content inside a mask although it reaches far outside the canvas', async () => {
    const r = render('23:7');
    expect(r.svg).not.toMatch(/clip-path=/);
    const px = await pixels(r.svg, r.w);
    expect(px.at(20, 20)).toEqual([0, 0, 255, 255]);
    expect(px.at(1, 1)[3]).toBe(0);
  });
});

describe('uniformScaleFactor (F17)', () => {
  it('scales the instance content before the saved derived data', () => {
    expect(raw('24:4').usf).toBe(0.5);
    const t = build('24:4');
    expect([t.row.w, t.row.h]).toEqual([10, 10]); // the instance record is already in placed space
    const body = kidNamed(t, 'StarBody');
    expect([body.row.x, body.row.y, body.row.w, body.row.h]).toEqual([2, 3, 5, 5]);
    expect(st(body)).toMatchObject({ r: 2, stroke: { w: 1 } });
    expect(st(kidNamed(t, 'StarLabel')).font.s).toBe(5);
    expect(JSON.parse(kidNamed(t, 'StarInner').row.layout!)).toMatchObject({ gap: 1, pad: [0, 0, 0, 2] });
    const saved = kidNamed(build('24:5'), 'StarLabel');
    expect([saved.row.x, saved.row.w]).toEqual([1, 7]);
    expect(st(saved).font.s).toBe(5);
  });
});

describe('explicit variable modes for numbers and text (F31, F07)', () => {
  it('prints the mode value of a bound number and draws it', () => {
    expect(lineOf('25:1', 'ModeRadius')).toContain('r=$radius-card{12}');
    expect(render('25:1').svg).toMatch(/rx="12"/);
  });
  it('shows a bound text under the explicit mode, also inside instances', () => {
    expect(lineOf('25:1', 'ModeText')).toContain('text="Hallo"');
    expect(lineOf('25:1', 'GreetingText')).toContain('text="Hallo"');
    expect(lineOf('25:7', 'GreetingText')).toContain('text="Hallo"');
    expect(lineOf('25:4', 'GreetingText')).toContain('text="Hello"');
  });
});

describe('component property definition ids that are not unique (F22)', () => {
  it('takes defaults from the definition in the component\'s own ancestry', () => {
    expect(kidNamed(build('26:7'), 'LabelA').row.text).toBe('From A');
    expect(kidNamed(build('26:8'), 'LabelB').row.text).toBe('From B');
  });
  it('names instance properties after the definition of their own component', () => {
    expect(raw('26:9').props).toEqual({ Label: 'Given' });
    expect(raw('26:10').props).toEqual({ Caption: 'Given' });
  });
});

describe('remaining approximations', () => {
  it('an override that detaches a fill style without paints shows the layer\'s own paints', () => {
    expect(styles('28:2').fill).toEqual([{ k: 'solid', c: '#664fa3' }]);
    expect(st(kidNamed(build('28:3'), 'TagBg')).fill).toEqual([{ k: 'solid', c: '#008000' }]);
  });
  it('widens an outline icon whose instance sets a heavier stroke and has no saved outline', () => {
    const icon = kidNamed(build('28:4'), 'icon');
    expect(st(icon).ow).toBe(3);
    expect(lineOf('28:4', 'icon')).toContain('(outline of a 3px stroke)');
    const svg = renderSvg(db(), icon.row.id, { assetsDir: '', format: 'fig', background: null, vnode: icon }).svg;
    expect(svg).toMatch(/stroke-width="1\.5" stroke-linejoin="round"/);
  });
});

describe('document-level format details (F24, F26)', () => {
  it('converts the colours of a Display-P3 document to sRGB and says so', async () => {
    const f = path.join(tmp, 'p3.fig');
    fs.writeFileSync(f, buildFig([
      { id: [0, 0], type: 'DOCUMENT', name: 'Document', extra: { documentColorProfile: 'DISPLAY_P3' } },
      { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
      { id: [1, 1], type: 'FRAME', name: 'Orange', parent: [0, 1], pos: '!', w: 10, h: 10, extra: { fillPaints: [solid(0.9490196, 0.6, 0.2901961)] } },
    ], { version: 101 }));
    await ingest(f, { quiet: true });
    const d = openIndex(f).db;
    expect(JSON.parse((d.prepare('SELECT styles FROM nodes WHERE id=?').get('1:1') as { styles: string }).styles).fill).toEqual([{ k: 'solid', c: '#ff9433' }]);
    expect(buildSpec(d, '1:1', { maxTokens: Infinity }).text).toMatch(/^# colours: the document is Display-P3/m);
  });
  it('reads geometry when the message stores the blobs before the nodes', async () => {
    const f = path.join(tmp, 'blobs-first.fig');
    fs.writeFileSync(f, buildFig([
      { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
      { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
      { id: [1, 1], type: 'VECTOR', name: 'Shape', parent: [0, 1], pos: '!', w: 10, h: 10, extra: { fillGeometry: [{ commandsBlob: 1 }], fillPaints: [solid(0, 0, 0)] } },
    ], { version: 101, blobs: [pathBlob([[1, 0, 0], [0]]), pathBlob([[1, 0, 0], [2, 10, 0], [2, 10, 10], [0]])], blobsFirst: true }));
    await ingest(f, { quiet: true });
    expect(openIndex(f).db.prepare('SELECT data FROM geometry WHERE node_id=?').get('1:1')).toEqual({ data: 'M0 0L10 0L10 10Z' });
  });
});

describe('review fixes (0.1.4)', () => {
  it('an OUTLINE mask without fills (frame, icon instance) masks with its content, not its box', async () => {
    for (const id of ['30:1', '30:7']) {
      const r = render(id);
      const px = await pixels(r.svg, r.w);
      expect(px.at(5, 5)).toEqual([255, 0, 0, 255]);
      expect(px.at(15, 15)[3]).toBe(0);
    }
  });
  it('reads the legacy maskIsOutline flag', () => {
    expect(raw('30:10').maskType).toBe('OUTLINE');
  });
  it('a blending grandchild sees the clipping frame\'s own paint', async () => {
    const r = render('31:1');
    expect((await pixels(r.svg, r.w)).at(10, 10)).toEqual([0, 255, 0, 255]);
  });
  it('text overrides store no empty ranges; an outranked text claim keeps the component\'s ranges', () => {
    expect(raw('20:6').overrides[0].st).toBeUndefined();
    const t = kidNamed(build('32:5'), 'InnerText');
    expect(t.row.text).toBe('Ab');
    expect(st(t).runs).toEqual([{ i: 0, n: 1, font: { f: 'Inter', w: 700, st: null } }]);
  });
  it('prints the scale of a scaled instance and its scaled outline stroke', () => {
    expect(lineOf('1:1', 'HalfButton')).toContain('scale=0.5');
    expect(lineOf('33:1', 'icon')).toContain('(outline of a 0.75px stroke)');
  });
  it('keeps a layer\'s own paints only where an instance detaches its fill style', () => {
    expect(styles('28:2').ifill).toEqual([{ k: 'solid', c: '#008000' }]);
    expect(styles('4:4').ifill).toBeUndefined();
  });
  it('prints no legend for notation that only occurs inside a text', () => {
    expect(specOf('34:1')).not.toMatch(/^# runs\[/m);
  });
  it('an override with an empty hyperlink removes the component\'s link', () => {
    expect(styles('35:2').link).toBe('https://example.com');
    expect(st(kidNamed(build('35:3'), 'LinkedText')).link).toBeUndefined();
  });
  it('applies the case per range although upper case changes the length (ß → SS)', () => {
    expect(render('36:1').svg).toContain('STRASSE <tspan font-weight="700">X</tspan>');
  });
  it('reads style ids per code point and prints ranges in UTF-16 units (surrogate pairs)', () => {
    expect(styles('36:2').runs[0]).toMatchObject({ i: 3, n: 2 });
    expect(lineOf('1:1', 'Emoji')).toContain('runs[3-5 "hi" w700]');
    expect(render('36:2').svg).toContain('😀 <tspan font-weight="700">hi</tspan>');
  });
  it('prints a range link only where it differs from the text\'s own link', () => {
    const l = lineOf('1:1', 'Linky');
    expect(l).toContain('link=https://a.example runs[0-3 "one" w700; 4-7 "two" link=https://b.example]');
  });
  it('matches explicit modes by collection: "Dark" of another collection does not apply', () => {
    expect(lineOf('37:1', 'ThemeText')).toContain('text="Hello"');
  });
  it('draws a one-stop diamond gradient without seams between its quadrants', async () => {
    const r = render('22:3');
    const px = await pixels(r.svg, r.w);
    let worst = 0;
    for (let y = 2; y < 98; y++) for (let x = 2; x < 98; x++) { const p = px.at(x, y); worst = Math.max(worst, Math.abs(p[0] - 0) + Math.abs(p[1] - 13) + Math.abs(p[2] - 77) + Math.abs(p[3] - 255)); }
    expect(worst).toBeLessThanOrEqual(3);
  });
});
