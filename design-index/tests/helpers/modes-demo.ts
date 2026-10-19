// Synthetic .fig content for gap/padding bound to a two-mode variable collection: a component saved in its default mode and
// instances shown under an explicit mode (Figma keeps the component's default-mode layout inside them). Used by
// tests/fig-limits.test.ts; the same nodes make the screenshot demo file.
import { bindVar, g, solid, type FigNode } from './fig-builder.js';

const loose = { variableModeBySetMap: { entries: [{ variableSetID: { assetRef: { key: 'dset' } }, variableModeID: g([40, 2]) }] } };
const spacing = () => ({
  variableConsumptionMap: { entries: [bindVar('STACK_SPACING', 'gapv'), bindVar('STACK_PADDING_TOP', 'padv'), bindVar('STACK_PADDING_RIGHT', 'padv'),
    bindVar('STACK_PADDING_BOTTOM', 'padv'), bindVar('STACK_PADDING_LEFT', 'padv')] },
});
// a hug column: gap 8 and padding 12 (default mode); in mode "Loose" gap 24 and padding 20
const card = { stackMode: 'VERTICAL', stackSpacing: 8, stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackHorizontalPadding: 12, stackVerticalPadding: 12,
  stackPaddingRight: 12, stackPaddingBottom: 12, fillPaints: [solid(0.93, 0.94, 0.97)], ...spacing() };

/** Node ids: demo frame 40:10, component 40:20, instances 40:31 (default), 40:32 (Loose), row 40:40 (Loose) with instance 40:41. */
export const modesDemoNodes = (): FigNode[] => [
  { id: [40, 3], type: 'VARIABLE_SET', name: 'Density', key: 'dset', modes: [{ id: [40, 1], name: 'Default' }, { id: [40, 2], name: 'Loose' }] },
  { id: [40, 4], type: 'VARIABLE', name: 'space/gap', key: 'gapv', setKey: 'dset', varType: 'FLOAT', values: [{ mode: [40, 1], num: 8 }, { mode: [40, 2], num: 24 }] },
  { id: [40, 5], type: 'VARIABLE', name: 'space/pad', key: 'padv', setKey: 'dset', varType: 'FLOAT', values: [{ mode: [40, 1], num: 12 }, { mode: [40, 2], num: 20 }] },
  { id: [40, 20], type: 'SYMBOL', name: 'Card', parent: [0, 1], pos: 'z0', w: 124, h: 100, x: 0, y: 600, extra: card },
  { id: [40, 21], type: 'ROUNDED_RECTANGLE', name: 'A', parent: [40, 20], pos: '!', w: 100, h: 20, x: 12, y: 12, ok: [40, 61], fill: [0.9, 0.3, 0.3] },
  { id: [40, 22], type: 'ROUNDED_RECTANGLE', name: 'B', parent: [40, 20], pos: '"', w: 100, h: 20, x: 12, y: 40, ok: [40, 62], fill: [0.3, 0.7, 0.3] },
  { id: [40, 23], type: 'ROUNDED_RECTANGLE', name: 'C', parent: [40, 20], pos: '#', w: 100, h: 20, x: 12, y: 68, ok: [40, 63], fill: [0.3, 0.4, 0.9] },
  { id: [40, 10], type: 'FRAME', name: 'Modes demo', parent: [0, 1], pos: 'z1', w: 400, h: 340, x: 300, y: 600, fill: [1, 1, 1] },
  { id: [40, 31], type: 'INSTANCE', name: 'Card default', parent: [40, 10], pos: '!', w: 124, h: 100, x: 20, y: 20, symbol: [40, 20], extra: card },
  // the instance record keeps the default-mode size and no saved layout of its content (what Figma's component layout gives)
  { id: [40, 32], type: 'INSTANCE', name: 'Card loose', parent: [40, 10], pos: '"', w: 124, h: 100, x: 180, y: 20, symbol: [40, 20], extra: { ...card, ...loose } },
  { id: [40, 40], type: 'FRAME', name: 'Loose row', parent: [40, 10], pos: '#', w: 154, h: 100, x: 20, y: 180,
    extra: { stackMode: 'HORIZONTAL', stackSpacing: 10, stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', frameMaskDisabled: true, ...loose } },
  { id: [40, 41], type: 'INSTANCE', name: 'Card in row', parent: [40, 40], pos: '!', w: 124, h: 100, symbol: [40, 20], extra: card },
  { id: [40, 42], type: 'ROUNDED_RECTANGLE', name: 'Tail', parent: [40, 40], pos: '"', w: 20, h: 20, x: 134, y: 0, fill: [0.2, 0.2, 0.2] },
];
