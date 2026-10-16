// Instance evaluation semantics ported from open-pencil's @open-pencil/fig (MIT): bindings with defaults, instance swap through a
// property, path-addressed overrides that stay distinct per instance, visibility property, saved derived geometry.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndex } from '../src/cache.js';
import { ingest } from '../src/ingest.js';
import { buildSpec } from '../src/commands/spec.js';
import { Evaluator } from '../src/instances.js';
import { buildFig, type FigNode } from './helpers/fig-builder.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-inst-'));
const nodes = (): FigNode[] => [
  { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
  { id: [0, 1], type: 'CANVAS', name: 'Page', parent: [0, 0], pos: '!' },
  { id: [1, 1], type: 'FRAME', name: 'Screen', parent: [0, 1], pos: '!', w: 800, h: 600, stack: 'VERTICAL', fill: [1, 1, 1] },
  // component "Card": text bound to a property, slot instance bound to a swap property, note bound to a visibility property
  { id: [2, 1], type: 'SYMBOL', name: 'Card', parent: [0, 1], pos: '"', w: 200, h: 100, stack: 'VERTICAL',
    defs: [{ id: [7, 1], init: { t: 'Default title' } }, { id: [7, 2], init: { sym: [3, 1] } }, { id: [7, 3], init: { b: false } }] },
  { id: [2, 2], type: 'TEXT', name: 'Title', parent: [2, 1], pos: '!', w: 100, h: 20, text: 'Default title', ok: [9, 1], refs: [{ def: [7, 1], field: 'TEXT_DATA' }] },
  { id: [2, 3], type: 'INSTANCE', name: 'Slot', parent: [2, 1], pos: '"', w: 100, h: 20, symbol: [3, 1], ok: [9, 2], refs: [{ def: [7, 2], field: 'OVERRIDDEN_SYMBOL_ID' }] },
  { id: [2, 4], type: 'TEXT', name: 'Note', parent: [2, 1], pos: '#', w: 100, h: 20, text: 'Note', ok: [9, 4], refs: [{ def: [7, 3], field: 'VISIBLE' }] },
  { id: [3, 1], type: 'SYMBOL', name: 'Placeholder', parent: [0, 1], pos: '#', w: 100, h: 20 },
  { id: [3, 2], type: 'TEXT', name: 'Ph', parent: [3, 1], pos: '!', w: 100, h: 20, text: 'Slot component' },
  { id: [4, 1], type: 'SYMBOL', name: 'Link', parent: [0, 1], pos: '$', w: 60, h: 16, defs: [{ id: [8, 1], init: { t: 'Link' } }] },
  { id: [4, 2], type: 'TEXT', name: 'LinkText', parent: [4, 1], pos: '!', w: 60, h: 16, text: 'Link', ok: [9, 3], refs: [{ def: [8, 1], field: 'TEXT_DATA' }] },
  // two instances of the same component with different values for the same nested keys
  { id: [5, 1], type: 'INSTANCE', name: 'A', parent: [1, 1], pos: '!', w: 200, h: 100, symbol: [2, 1],
    assign: [{ def: [7, 1], v: { t: 'Alpha' } }, { def: [7, 2], v: { sym: [4, 1] } }], overrides: [{ path: [[9, 2]], assign: [{ def: [8, 1], v: { t: 'Go A' } }] }] },
  { id: [5, 2], type: 'INSTANCE', name: 'B', parent: [1, 1], pos: '"', w: 200, h: 100, symbol: [2, 1],
    assign: [{ def: [7, 1], v: { t: 'Beta' } }, { def: [7, 2], v: { sym: [4, 1] } }], overrides: [{ path: [[9, 2]], assign: [{ def: [8, 1], v: { t: 'Go B' } }] }] },
  { id: [5, 3], type: 'INSTANCE', name: 'C', parent: [1, 1], pos: '#', w: 200, h: 100, symbol: [2, 1], assign: [{ def: [7, 3], v: { b: true } }] },
  { id: [5, 4], type: 'INSTANCE', name: 'D', parent: [1, 1], pos: '$', w: 200, h: 100, symbol: [2, 1], derived: [{ path: [[9, 1]], w: 77, h: 13, x: 3, y: 4 }] },
];

let file = '';
beforeAll(async () => {
  process.env.DESIGN_INDEX_DIR = path.join(tmp, 'cache');
  file = path.join(tmp, 'inst.fig');
  fs.writeFileSync(file, buildFig(nodes()));
  await ingest(file, { quiet: true });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const spec = () => buildSpec(openIndex(file).db, '1:1', { maxTokens: 6000 }).text;
const block = (text: string, name: string) => {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`  "${name}" instance`));
  const out: string[] = [];
  for (let k = i + 1; k < lines.length && lines[k].startsWith('    '); k++) out.push(lines[k]);
  return out.join('\n');
};

describe('instance evaluation', () => {
  it('binds text properties from assignments and falls back to the definition default', () => {
    const t = spec();
    expect(block(t, 'A')).toContain('text="Alpha"');
    expect(block(t, 'B')).toContain('text="Beta"');
    expect(block(t, 'C')).toContain('text="Default title"');
  });

  it('swaps the slot component through an instance-swap property and keeps nested values per instance', () => {
    const t = spec();
    expect(block(t, 'A')).toContain('text="Go A"');
    expect(block(t, 'A')).not.toContain('Go B');
    expect(block(t, 'B')).toContain('text="Go B"');
    expect(block(t, 'A')).not.toContain('Slot component');
    // the default (no assignment) keeps the placeholder content
    expect(block(t, 'C')).toContain('Slot component');
  });

  it('applies visibility from the property default and from an assignment', () => {
    const t = spec();
    expect(block(t, 'A')).not.toContain('text="Note"'); // default false
    expect(block(t, 'C')).toContain('text="Note"'); // assigned true
    expect(t).toMatch(/hidden .*"Note"/); // omitted nodes are named so a model can ask
  });

  it('uses the saved derived size of an occurrence', () => {
    expect(block(spec(), 'D')).toMatch(/"Title" text 77×13/);
  });

  it('inherits explicit variable modes from frames above the queried root', () => {
    const ix = openIndex(file);
    // the page frame sets a mode; a query that starts at a child must still see it
    const w = new DatabaseSync(path.join(ix.dir, 'index.db'));
    w.prepare("UPDATE nodes SET raw=? WHERE id='1:1'").run(JSON.stringify({ vm: [{ s: 'set-x', m: '0:9' }] }));
    w.close();
    const db = openIndex(file).db;
    const ev = new Evaluator(db, { maxDepth: 99, cap: 10000 });
    const child = ev.node('5:1')!;
    expect(ev.build(child).modes?.length).toBe(1);
    expect(ev.build(ev.node('1:1')!).modes?.length).toBe(1);
  });
});
