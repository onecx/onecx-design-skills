#!/usr/bin/env node
// usage: node scripts/bench.mjs <file>...   (needs a built dist/)  -> Markdown table rows: ingest time, peak RSS, query latency
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const cli = path.resolve('dist/cli.js');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
const env = { ...process.env, DESIGN_INDEX_DIR: cache, NODE_NO_WARNINGS: '1' };
const run = (...a) => { const t = Date.now(); const r = spawnSync('node', [cli, ...a], { env, encoding: 'utf8', maxBuffer: 1 << 28 }); return { ms: Date.now() - t, out: r.stdout, err: r.stderr, code: r.status }; };

console.log('| File | Size | Format | Nodes | Ingest | Peak RSS | summary | tree | search | spec | audit |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const file of process.argv.slice(2)) {
  const size = fs.statSync(file).size;
  const r = run('ingest', file, '--json');
  if (r.code) { console.log(`| ${path.basename(file)} | ${(size / 1e6).toFixed(0)} MB | ERROR | | ${r.err.split('\n').slice(-3).join(' ')} |`); continue; }
  const j = JSON.parse(r.out);
  const db = new DatabaseSync(path.join(cache, j.hash, 'index.db'), { readOnly: true });
  const top = db.prepare("SELECT id FROM nodes WHERE depth>=1 AND nchild>3 AND type='frame' ORDER BY nchild DESC LIMIT 1").get();
  const word = (db.prepare("SELECT text FROM nodes WHERE type='text' AND length(text) BETWEEN 6 AND 14 LIMIT 1 OFFSET 7").get() ?? { text: 'Service' }).text.split(/\s+/)[0];
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM meta').all().map((m) => [m.key, m.value]));
  db.close();
  const lat = (...a) => { const t = []; for (let i = 0; i < 3; i++) t.push(run(...a, '--file', file).ms); return Math.round(t.sort((x, y) => x - y)[1]) + ' ms'; };
  console.log(`| ${path.basename(file)} | ${(size / 1e6).toFixed(0)} MB | ${j.format} | ${j.nodes} | ${(j.ms / 1000).toFixed(1)} s | ${meta.peak_rss_mb} MB | ${lat('summary')} | ${lat('tree', top.id, '--depth', '2')} | ${lat('search', word)} | ${lat('spec', top.id)} | ${lat('audit')} |`);
}
fs.rmSync(cache, { recursive: true, force: true });
