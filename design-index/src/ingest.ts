import fs from 'node:fs';
import path from 'node:path';
import { dbFileFor, dirFor, hashFor, isIndexed, rememberFile } from './cache.js';
import { createIndexes, getMeta, IndexWriter, openDb, SCHEMA_VERSION } from './db.js';
import { analyze } from './analyze.js';
import { parsePen } from './parsers/pen.js';
import { parseFig } from './parsers/fig.js';
import { ensureIgnored, cacheRoot, fmtBytes, log, Progress } from './util.js';

export type Format = 'pen' | 'fig';

export function detectFormat(file: string): Format {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  fs.closeSync(fd);
  if (head.subarray(0, 2).toString('latin1') === 'PK' || head.subarray(0, 8).toString('latin1') === 'fig-kiwi') return 'fig';
  const text = head.toString('utf8').trimStart();
  if (text.startsWith('{') || text.startsWith('/')) return 'pen';
  throw new Error(`Unknown file format: ${path.basename(file)} (neither .pen JSON nor .fig ZIP/fig-kiwi)`);
}

export interface IngestResult {
  hash: string; format: Format; cached: boolean; nodes?: number; ms: number; peakRssMB: number; dir: string; warnings: number;
}

export async function ingest(file: string, opts: { force?: boolean; quiet?: boolean } = {}): Promise<IngestResult> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${file}`);
  const size = fs.statSync(abs).size;
  const format = detectFormat(abs);
  const t0 = Date.now();
  const hashProg = new Progress('hash', size, !opts.quiet && size > 20e6);
  let hashed = 0;
  const hash = await hashFor(abs, (n) => hashProg.update((hashed += n)));
  hashProg.done();
  const dir = dirFor(hash);

  if (!opts.force && isIndexed(hash)) {
    const db = openDb(dbFileFor(hash), { readonly: true });
    const ver = Number(getMeta(db, 'schema_version') ?? 0);
    const nodes = Number(getMeta(db, 'node_count') ?? 0);
    db.close();
    if (ver === SCHEMA_VERSION) {
      rememberFile(abs, hash);
      if (!opts.quiet) log(`Already indexed (${hash.slice(0, 12)}), skipped.`);
      return { hash, format, cached: true, nodes, ms: Date.now() - t0, peakRssMB: 0, dir, warnings: 0 };
    }
  }

  ensureIgnored(cacheRoot());
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const db = openDb(dbFileFor(hash), { create: true });
  const w = new IndexWriter(db);

  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const prog = new Progress('ingest', size, !opts.quiet);
  let read = 0;
  const onBytes = (n: number) => prog.update((read += n));
  const assetsDir = path.join(dir, 'assets');
  try {
    if (format === 'pen') await parsePen({ file: abs, assetsDir, sink: w, onBytes });
    else {
      let lastPct = -1;
      await parseFig({
        file: abs, assetsDir, sink: w, onBytes,
        onStage: (label, frac) => { const pct = Math.floor(frac * 10) * 10; if (!opts.quiet && pct > lastPct) { lastPct = pct; log(`${label} ${pct}%`); } },
        onPeak: (rss) => { peak = Math.max(peak, rss); },
      });
    }
    w.finish();
    prog.done();
    log('Index: secondary tables and analysis …');
    createIndexes(db);
    analyze(db, format);
    w.meta('schema_version', String(SCHEMA_VERSION));
    w.meta('format', format);
    w.meta('source', abs);
    w.meta('source_size', String(size));
    w.meta('node_count', String(w.nodeCount));
    w.meta('indexed_at', new Date().toISOString());
    const ms = Date.now() - t0;
    w.meta('ingest_ms', String(ms));
    peak = Math.max(peak, process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
    w.meta('peak_rss_mb', String(Math.round(peak / 1e6)));
    db.close();
  } catch (e) {
    clearInterval(sampler);
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  clearInterval(sampler);
  fs.writeFileSync(path.join(dir, 'DONE'), new Date().toISOString());
  rememberFile(abs, hash);
  const ms = Date.now() - t0;
  const rdb = openDb(dbFileFor(hash), { readonly: true });
  const warnings = (rdb.prepare('SELECT COUNT(*) c FROM warnings').get() as { c: number }).c;
  rdb.close();
  if (!opts.quiet) log(`${format.toUpperCase()} ${fmtBytes(size)} → ${w.nodeCount} nodes in ${(ms / 1000).toFixed(1)} s, peak ${Math.round(peak / 1e6)} MB RSS`);
  return { hash, format, cached: false, nodes: w.nodeCount, ms, peakRssMB: Math.round(peak / 1e6), dir, warnings };
}
