// .fig ingest: ZIP container streamed with yauzl (images -> assets/, canvas.fig -> temp file), Kiwi canvas decoded in a worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import yauzl from 'yauzl';
import type { Sink } from '../model.js';
import { AssetWriter } from '../assets.js';
import { timed } from '../util.js';

export interface FigOptions {
  file: string; assetsDir: string; sink: Sink;
  onBytes?: (n: number) => void;
  onStage?: (label: string, fraction: number) => void;
  onPeak?: (rssBytes: number) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function workerPath(): string {
  for (const p of [path.join(here, 'fig-worker.js'), path.join(here, '..', '..', 'dist', 'fig-worker.js')]) if (fs.existsSync(p)) return p;
  throw new Error('fig-worker.js not found (run npm run build)');
}

interface Extracted { canvasFile: string; imageMap: Record<string, string>; images: number }

function extractZip(opts: FigOptions, tmpCanvas: string): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    yauzl.open(opts.file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('ZIP could not be opened'));
      const imageMap: Record<string, string> = {};
      let canvas = false;
      let images = 0;
      let metaDone = false;
      zip.on('error', reject);
      zip.on('end', () => {
        if (!canvas) return reject(new Error('The .fig archive contains no canvas.fig (not a valid Figma export).'));
        resolve({ canvasFile: tmpCanvas, imageMap, images });
      });
      zip.on('entry', (e: yauzl.Entry) => {
        const next = () => { opts.onBytes?.(e.compressedSize); zip.readEntry(); };
        const name = e.fileName;
        if (name.endsWith('/')) return next();
        const isCanvas = name === 'canvas.fig';
        const img = /^images\/([^/]+)$/.exec(name);
        const isMeta = name === 'meta.json';
        if (!isCanvas && !img && !isMeta) return next();
        zip.openReadStream(e, (err2, rs) => {
          if (err2 || !rs) return reject(err2 ?? new Error(`Entry ${name} is not readable`));
          if (isCanvas) {
            canvas = true;
            const ws = fs.createWriteStream(tmpCanvas);
            rs.pipe(ws);
            ws.on('finish', next);
            ws.on('error', reject);
          } else if (img) {
            const w = new AssetWriter(opts.assetsDir);
            rs.on('data', (c: Buffer) => w.write(c));
            rs.on('end', () => {
              const row = w.finish();
              opts.sink.asset(row);
              imageMap[img[1].replace(/\.[a-z0-9]+$/i, '').toLowerCase()] = row.hash;
              images++;
              next();
            });
            rs.on('error', (e3) => { w.abort(); reject(e3); });
          } else {
            const parts: Buffer[] = [];
            let len = 0;
            rs.on('data', (c: Buffer) => { if (len < 1e6) { parts.push(c); len += c.length; } });
            rs.on('end', () => {
              if (!metaDone) { metaDone = true; opts.sink.meta('figma_meta', Buffer.concat(parts).toString('utf8').slice(0, 20000)); }
              next();
            });
            rs.on('error', reject);
          }
        });
      });
      zip.readEntry();
    });
  });
}

export async function parseFig(opts: FigOptions): Promise<void> {
  const { sink } = opts;
  const fd = fs.openSync(opts.file, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  const tmp = path.join(opts.assetsDir, '..', 'canvas.tmp');
  let ex: Extracted;
  if (head.subarray(0, 2).toString('latin1') === 'PK') ex = await extractZip(opts, tmp);
  else {
    ex = { canvasFile: opts.file, imageMap: {}, images: 0 };
    sink.warn('raw fig-kiwi file without ZIP: no images included');
  }
  sink.meta('fig_images', String(ex.images));
  opts.onStage?.('decode', 0);

  const canvasSize = fs.statSync(ex.canvasFile).size;
  const ack = new SharedArrayBuffer(4);
  const ackArr = new Int32Array(ack);
  // Heap limit for the worker. Streaming keeps the heap small; the limit is a safety net scaled with the compressed canvas size.
  const heapMb = Number(process.env.DESIGN_INDEX_WORKER_HEAP_MB) || Math.min(Math.floor((os.totalmem() / 1e6) * 0.6), Math.max(2048, Math.ceil((canvasSize / 1e6) * 40)));

  const done = await new Promise<any>((resolve, reject) => {
    const w = new Worker(workerPath(), { workerData: { canvasFile: ex.canvasFile, imageMap: ex.imageMap, ack }, resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    let finished = false;
    w.on('message', (m: any) => {
      switch (m.t) {
        case 'rows':
          for (const r of m.nodes) sink.node(r);
          for (const [id, d] of m.geoms) sink.geometry(id, d);
          for (const i of m.inters) sink.interaction(i);
          for (const n of m.notes) sink.note(n);
          Atomics.add(ackArr, 0, 1); Atomics.notify(ackArr, 0);
          opts.onPeak?.(process.memoryUsage().rss);
          break;
        case 'progress': opts.onStage?.('decode', m.frac); opts.onPeak?.(process.memoryUsage().rss); break;
        case 'done': finished = true; Atomics.add(ackArr, 0, 1); Atomics.notify(ackArr, 0); resolve(m); break;
        case 'error': finished = true; reject(new Error(m.message)); break;
      }
    });
    w.on('error', (e: Error & { code?: string }) => reject(e.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new Error(`The Kiwi worker exceeded its heap limit (${heapMb} MB). The file is unusually large: raise the limit via the DESIGN_INDEX_WORKER_HEAP_MB environment variable.`) : e));
    w.on('exit', (code) => { if (!finished) reject(new Error(`Worker exited (code ${code}) without a result`)); });
  });
  if (ex.canvasFile === tmp) fs.rmSync(tmp, { force: true });

  // ---- rows that need the complete picture ----
  done.canvases.forEach((c: any, i: number) => sink.page(i + 1, c.id, c.name));
  sink.run(`UPDATE pages SET internal=1 WHERE id IN (${done.canvases.filter((c: any) => c.internal).map(() => '?').join(',') || "''"})`, ...done.canvases.filter((c: any) => c.internal).map((c: any) => c.id));
  for (const v of done.variables) sink.variable(v);
  for (const c of done.components) sink.component(c);
  for (const [k, v, n] of done.usage) sink.usage(k, v, n);
  for (const [msg, n] of done.warns) sink.warn(msg, n);

  // second pass inside the database: sibling order, depth and page from parent links
  timed('fig:index', () => sink.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord)'));
  timed('fig:ord', () => sink.exec(`WITH r AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY pos, id) - 1 AS o FROM nodes) UPDATE nodes SET ord = r.o FROM r WHERE nodes.id = r.id`));
  timed('fig:depth', () => sink.exec(`WITH RECURSIVE t(id, depth, page) AS (
      SELECT n.id, 0, p.idx FROM nodes n JOIN pages p ON p.id = n.parent_id
      UNION ALL SELECT c.id, t.depth + 1, t.page FROM nodes c JOIN t ON c.parent_id = t.id)
    UPDATE nodes SET depth = t.depth, page = t.page FROM t WHERE nodes.id = t.id`));
  const orphans = (sink.query<{ c: number }>('SELECT COUNT(*) c FROM nodes WHERE page = 0')[0]).c;
  if (orphans) { sink.warn(`${orphans} nodes without a reachable parent were dropped`, orphans); sink.exec('DELETE FROM nodes WHERE page = 0'); }
  sink.exec('UPDATE nodes SET parent_id = NULL WHERE depth = 0');
  timed('fig:counts', () => sink.exec('UPDATE pages SET node_count = (SELECT COUNT(*) FROM nodes WHERE nodes.page = pages.idx)'));
  sink.exec('UPDATE components SET page = COALESCE((SELECT page FROM nodes WHERE nodes.id = components.id), 0)');

  // auto-layout "fill" children (needs parent direction, resolved in the worker)
  sink.exec('BEGIN');
  for (const [id, key, val] of done.fixups) sink.run(`UPDATE nodes SET layout = json_set(COALESCE(layout, '{}'), '$.' || ?, ?) WHERE id = ?`, key, val, id);
  sink.exec('COMMIT');

  // instance property keys (definition ids) -> property names
  const names: Record<string, string> = done.propNames;
  const inst = sink.query<{ id: string; raw: string }>(`SELECT id, raw FROM nodes WHERE component_ref IS NOT NULL AND raw LIKE '%"props"%'`);
  sink.exec('BEGIN');
  for (const r of inst) {
    const raw = JSON.parse(r.raw);
    if (raw.props) { raw.pid = raw.props; raw.props = Object.fromEntries(Object.entries(raw.props).map(([k, v]) => [names[k] ?? k, v])); sink.run('UPDATE nodes SET raw = ? WHERE id = ?', JSON.stringify(raw), r.id); }
  }
  sink.exec('COMMIT');

  const s = done.stats;
  sink.meta('fig_version', String(s.version));
  sink.meta('fig_canvas_uncompressed_mb', String(s.uncompressedMB));
  sink.meta('fig_worker_heap_mb', String(s.maxHeapMB));
}
