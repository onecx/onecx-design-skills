// Tests for compare.mjs against fixture.html (run: node --test project-skills/compare-design/tests/compare.test.mjs).
// They need playwright (or @playwright/test) and Chromium where compare.mjs finds them (current folder, NODE_PATH, global);
// without them every test is skipped. This folder is optional: the skill works without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const script = join(dir, '..', 'compare.mjs');
const url = pathToFileURL(join(dir, 'fixture.html')).href;
const tmp = mkdtempSync(join(tmpdir(), 'compare-design-test-'));

const run = (expect, ...args) => {
  let file = expect;
  if (typeof expect !== 'string') { file = join(tmp, `e${Math.random().toString(36).slice(2)}.json`); writeFileSync(file, JSON.stringify(expect)); }
  const r = spawnSync(process.execPath, [script, url, file, '--max-lines', '100', ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const probe = run({ sel: 'body' });
const skip = probe.code === 2 && /playwright not found|cannot start chromium/.test(probe.err) ? 'playwright or Chromium not available' : false;

test('reference.md section 2 example: deliberate differences give exit 1 and the documented FAIL lines', { skip }, () => {
  const r = run(join(dir, 'expect.json'));
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /FAIL {2}spacing {4}Card {2}gap: expected 8 {2}measured 12/);
  assert.match(r.out, /FAIL {2}color {6}Card > Line 1 {2}color: expected #49454f {2}measured #000000/);
  assert.match(r.out, /FAIL {2}spacing {4}Card > Button {2}pad \(t,r,b,l\): expected 10,24,10,24 {2}measured 6,24,6,24/);
  assert.match(r.out, /RESULT: 18 PASS, 3 FAIL, 0 WARN, 0 SKIP/);
});

test('matching values pass with exit 0', { skip }, () => {
  const r = run({ sel: '.card', dir: 'col', gap: 12, pad: 16, bg: '#ffffff', borderColor: '#cac4d0', borderWidth: 1, radius: 8, children: [
    { sel: '.line1', text: 'First line', color: '#000000', fontSize: 14 },
    { sel: '.btn', pad: [6, 24], bg: '#6750a4', radius: 20, text: 'Save', color: '#ffffff', fontSize: 14, fontWeight: 500 }] });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /RESULT: \d+ PASS, 0 FAIL/);
});

test('hidden text (display:none, screen-reader-only) does not count; opacity:0 on an ancestor hides the element', { skip }, () => {
  const r = run([{ sel: '.b1', text: 'Save' }, { sel: '.ghost', text: 'ghost' }]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /PASS {2}text {7}\.b1 {2}text: expected "Save" {2}measured "Save"/);
  assert.match(r.out, /FAIL {2}hierarchy {2}\.ghost {2}visible: expected visible {2}measured opacity:0 on ancestor div/);
});

test('repeated top-level nodes take the next unused match', { skip }, () => {
  const r = run([{ sel: '.item', text: 'one' }, { sel: '.item', text: 'two' }]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /measured "two"/);
});

test('an invalid selector in expect.json exits 2 and names the node', { skip }, () => {
  const r = run({ sel: 'body', children: [{ sel: '.item' }, { sel: 'div[[' }] });
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /^ERROR .*is invalid:\n {2}node\[0\]\.children\[1\]: invalid CSS selector "div\[\["/);
});
