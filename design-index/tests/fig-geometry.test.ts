// Corner radius and stroke rules measured on a real Figma export (see parsers/fig-convert.ts), plus the saved "no stroke" cache of instances.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { Evaluator } from '../src/instances.js';
import { buildFig, type FigNode } from './helpers/fig-builder.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-geom-'));
const nodes = (): FigNode[] => [
  { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
  { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
  { id: [1, 1], type: 'FRAME', name: 'Screen', parent: [0, 1], pos: '!', w: 400, h: 300 },
  // per-corner value alone (no cornerRadius, no independent flag): Figma draws it square
  { id: [1, 2], type: 'FRAME', name: 'Unflagged', parent: [1, 1], pos: '!', w: 50, h: 20, radius: { tl: 100 } },
  { id: [1, 3], type: 'FRAME', name: 'Uniform', parent: [1, 1], pos: '"', w: 50, h: 20, radius: { cornerRadius: 9, tl: 9 } },
  { id: [1, 4], type: 'FRAME', name: 'Independent', parent: [1, 1], pos: '#', w: 50, h: 20, radius: { tl: 6, indep: true } },
  // only the top border has a width
  { id: [1, 5], type: 'FRAME', name: 'TopBorder', parent: [1, 1], pos: '$', w: 50, h: 20, stroke: { w: 1, top: 2, indep: true } },
  { id: [1, 6], type: 'FRAME', name: 'AllSides', parent: [1, 1], pos: '%', w: 50, h: 20, stroke: { w: 1 } },
  // component with a stroke; the instance saved an empty stroke outline for it
  { id: [2, 1], type: 'SYMBOL', name: 'Item', parent: [0, 1], pos: '"', w: 50, h: 20, stroke: { w: 1 } },
  { id: [3, 1], type: 'SYMBOL', name: 'Host', parent: [0, 1], pos: '#', w: 100, h: 40 },
  { id: [3, 2], type: 'INSTANCE', name: 'Inner', parent: [3, 1], pos: '!', w: 50, h: 20, symbol: [2, 1] },
  { id: [3, 3], type: 'INSTANCE', name: 'Outer', parent: [0, 1], pos: '$', w: 100, h: 40, symbol: [3, 1], derived: [{ path: [[3, 2]], w: 50, h: 20, x: 0, y: 0, noStroke: true }] },
];

let file = '';
beforeAll(async () => {
  process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache');
  file = path.join(tmp, 'geom.fig');
  fs.writeFileSync(file, buildFig(nodes()));
  await ingest(file, { quiet: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const styles = (id: string) => {
  const r = openIndex(file).db.prepare('SELECT styles FROM nodes WHERE id=?').get(id) as { styles: string | null };
  return JSON.parse(r.styles ?? '{}');
};

describe('fig corner radius', () => {
  it('ignores per-corner values without cornerRadius and independent flag', () => {
    expect(styles('1:2').r).toBeUndefined();
  });
  it('uses cornerRadius and independent per-corner values', () => {
    expect(styles('1:3').r).toBe(9);
    expect(styles('1:4').r).toEqual([6, 0, 0, 0]);
  });
});

describe('fig stroke', () => {
  it('uses per-side widths only with the independent flag; missing sides are 0', () => {
    expect(styles('1:5').stroke.w).toEqual([2, 0, 0, 0]);
    expect(styles('1:6').stroke.w).toBe(1);
  });
  it('drops the stroke of an instance occurrence whose saved stroke outline is empty', () => {
    const db = openIndex(file).db;
    const ev = new Evaluator(db, { maxDepth: 99, cap: 1000 });
    const tree = ev.build(ev.node('3:3')!);
    const inner = tree.kids[0];
    expect(JSON.parse(inner.row.styles ?? '{}').stroke).toBeUndefined();
    // the component itself declares a stroke, and the cache row carries the flag
    expect(styles('2:1').stroke).toBeDefined();
    expect((db.prepare('SELECT ns FROM derived WHERE inst=?').get('3:3') as { ns: number }).ns).toBe(1);
  });
});
