import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from '../sqlite.js';
import { svgToPng } from '../render.js';
import { CACHE_DIR_NAME, cacheRoot, repoRoot } from '../util.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Self-check: everything the skill needs besides Node itself ships inside dist/. Returns false if a check failed. */
export async function doctor(): Promise<boolean> {
  let ok = true;
  const line = (good: boolean, msg: string, fix?: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? 'OK    ' : 'FAIL  '} ${msg}${!good && fix ? `\n       → ${fix}` : ''}\n`);
  };
  const [maj, min] = process.versions.node.split('.').map(Number);
  line(maj > 22 || (maj === 22 && min >= 13), `Node.js ${process.version} (requires ≥ 22.13)`, 'install Node.js 22 LTS or newer');
  try {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(a); INSERT INTO t VALUES('x'); CREATE TABLE j(v TEXT); INSERT INTO j VALUES('{\"a\":1}');");
    const r = db.prepare("SELECT json_extract(v,'$.a') a FROM j").get() as { a: number };
    line(r.a === 1, 'node:sqlite with FTS5 and JSON (built in, no native dependency)');
  } catch (e) { line(false, `node:sqlite not usable: ${(e as Error).message}`, 'use Node.js ≥ 22.13'); }
  const worker = [path.join(here, 'fig-worker.js'), path.join(here, 'parsers', 'fig-worker.js')].find((p) => fs.existsSync(p));
  line(!!worker, '.fig-Worker (fig-worker.js)', 'run `npm run build` in the skill folder (or use the prebuilt dist/ folder)');
  try {
    const png = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#003064"/><text x="4" y="14" font-size="12" fill="#fff">Ab</text></svg>', 64, 40, 20);
    line(png.length > 100 && png.subarray(1, 4).toString() === 'PNG', 'Offline renderer (resvg-wasm + bundled fonts) for `screenshot`');
  } catch (e) { line(false, `Renderer: ${(e as Error).message}`, 'dist/resvg.wasm and dist/assets/fonts must sit next to cli.js'); }
  const root = cacheRoot();
  try {
    // probe writability without leaving anything behind: test the nearest existing ancestor if the cache does not exist yet
    let probe = root;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    fs.accessSync(probe, fs.constants.W_OK);
    const repo = repoRoot();
    const gi = path.join(repo, '.gitignore');
    const hasGit = fs.existsSync(path.join(repo, '.git'));
    const ignored = fs.existsSync(path.join(root, '.gitignore')) || (fs.existsSync(gi) && fs.readFileSync(gi, 'utf8').split(/\r?\n/).some((l) => l.trim().replace(/\/$/, '') === CACHE_DIR_NAME));
    line(true, `Cache folder ${root} writable${fs.existsSync(root) ? '' : ' (created on first ingest)'}${hasGit ? (ignored ? ', ignored by Git' : ' (added to .gitignore on first ingest)') : ''}`);
  } catch (e) { line(false, `Cache folder ${root} not writable: ${(e as Error).message}`, 'choose another location with DESIGN_INDEX_DIR=<path>'); }
  process.stdout.write(ok ? 'All set.\n' : 'There are problems (see above).\n');
  return ok;
}
