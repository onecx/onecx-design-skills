// CLI level: common options before or after the command, --max-tokens validation, `node` honouring the budget.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeLimits } from '../src/commands/structure.js';

const root = path.join(__dirname, '..');
const cli = path.join(root, 'dist', 'cli.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'di-cli-'));
const file = path.join(tmp, 'cli.pen');
const longDesc = Array.from({ length: 120 }, (_, i) => `rule${i}`).join(' ');
const blob = Array.from({ length: 400 }, (_, i) => `item-${i}`).join(',');
const doc = JSON.stringify({
  version: '2.21',
  children: [{ type: 'frame', id: 'scr', name: 'Screen', x: 0, y: 0, width: 400, height: 300, layout: 'vertical', gap: 8, futureBlob: blob, children: [
    { type: 'text', id: 't1', name: 'Title', content: 'Hello', fontSize: 14 },
    { type: 'text', id: 't2', name: 'Long', content: 'word '.repeat(300), fontSize: 14 },
  ] }, { type: 'frame', id: 'card', name: 'Card', reusable: true, context: longDesc, x: 500, y: 0, width: 100, height: 50 }],
});
const env = { ...process.env, DESIGN_INDEX_DIR: path.join(tmp, 'cache') };
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

beforeAll(() => {
  if (!fs.existsSync(cli)) execFileSync('npx', ['tsup'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(file, doc);
  const r = run('ingest', file);
  if (r.status !== 0) throw new Error(r.stderr);
}, 120000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('common options before and after the command', () => {
  for (const cmd of [['node', 'scr'], ['spec', 'scr'], ['tree', 'scr'], ['search', 'Title']]) {
    it(`${cmd[0]}: --max-tokens before, after and as --max-tokens=N give the same output`, () => {
      const before = run('--max-tokens', '150', '--file', file, ...cmd);
      const after = run(...cmd, '--file', file, '--max-tokens', '150');
      const eq = run(...cmd, `--file=${file}`, '--max-tokens=150');
      expect(before.status).toBe(0);
      expect(before.stderr).toBe('');
      expect(after.stdout).toBe(before.stdout);
      expect(eq.stdout).toBe(before.stdout);
    });
  }
  it('--json before the command', () => {
    const r = run('--json', '--file', file, 'node', 't1');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).head[0]).toContain('t1 text');
  });
  it('the value closer to the command wins', () => {
    const a = run('--max-tokens', '100000', 'node', 'scr', '--file', file, '--max-tokens', '2000');
    expect(a.stdout).toBe(run('node', 'scr', '--file', file).stdout);
  });
});

describe('--max-tokens validation', () => {
  for (const v of ['abc', '0', '-5', '1.5', '', ' 12 ']) {
    it(`rejects ${JSON.stringify(v)}`, () => {
      for (const r of [run('node', 'scr', '--file', file, '--max-tokens', v), run(`--max-tokens=${v}`, 'node', 'scr', '--file', file)]) {
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/--max-tokens/);
        expect(r.stderr).toMatch(/positive integer, e\.g\. --max-tokens 4000/);
      }
    });
  }
});

describe('ingest and the common options', () => {
  it('rejects --file / --max-tokens before ingest like after it (exit code 1, clear message)', () => {
    for (const r of [run('--file', file, 'ingest', file), run('--max-tokens', '100', 'ingest', file)]) {
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/ingest takes the file as its argument/);
    }
    expect(run('ingest', file, '--max-tokens', '100').status).not.toBe(0);
    expect(run('--json', 'ingest', file).status).toBe(0);
  });
});

describe('components: cut props/descriptions name a budget that shows them in full', () => {
  it('the suggested node budget shows the description in full', () => {
    const r = run('components', '--file', file);
    const m = /props\/descriptions cut with …: `node <id> --max-tokens (\d+)`/.exec(r.stdout);
    expect(m).not.toBeNull();
    const n = run('node', 'card', '--file', file, '--max-tokens', m![1]);
    expect(n.stdout).toContain(longDesc.slice(-30));
    expect(n.stdout).not.toContain('truncated');
  });
});

describe('node honours the budget', () => {
  it('keeps the 0.1.x limits at the default budget', () => {
    expect(nodeLimits(2000)).toEqual({ text: 600, props: 300, desc: 160, raw: 700, inter: 8, notes: 5, note: 300 });
  });
  it('cuts raw with … and names a budget that shows it in full', () => {
    const r = run('node', 'scr', '--file', file);
    const raw = r.stdout.split('\n').find((l) => l.startsWith('raw: '))!;
    expect(raw.length).toBe('raw: '.length + 701);
    expect(raw.endsWith('…')).toBe(true);
    const m = /→ raw truncated \(700 of (\d+) chars\): node scr --max-tokens (\d+)/.exec(r.stdout);
    expect(m).not.toBeNull();
    const full = run('node', 'scr', '--file', file, '--max-tokens', m![2]);
    const json = full.stdout.split('\n').find((l) => l.startsWith('raw: '))!.slice(5);
    expect(json.length).toBe(Number(m![1]));
    expect(JSON.parse(json).futureBlob).toBe(blob);
    expect(full.stdout).not.toContain('truncated');
  });
  it('a larger budget shows a long text in full', () => {
    const def = run('node', 't2', '--file', file).stdout;
    expect(def).toMatch(/→ text truncated \(600 of 1500 chars\)/);
    const r = run('node', 't2', '--file', file, '--max-tokens', '6000');
    expect(r.stdout).toContain(JSON.stringify('word '.repeat(300).trimEnd()).slice(0, 40));
    expect(r.stdout).not.toContain('truncated');
  });
});
