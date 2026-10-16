import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from './sqlite.js';
import { getMeta, openDb, SCHEMA_VERSION } from './db.js';
import { cacheRoot, ensureIgnored, sha256File } from './util.js';

interface FileEntry { size: number; mtimeMs: number; hash: string }
interface Registry { current?: { hash: string; file: string }; files: Record<string, FileEntry> }

const regPath = () => path.join(cacheRoot(), 'registry.json');

export function readRegistry(): Registry {
  try { return JSON.parse(fs.readFileSync(regPath(), 'utf8')); } catch { return { files: {} }; }
}
export function writeRegistry(r: Registry): void {
  ensureIgnored(cacheRoot());
  fs.writeFileSync(regPath(), JSON.stringify(r, null, 1));
}

export const dirFor = (hash: string) => path.join(cacheRoot(), hash);
export const dbFileFor = (hash: string) => path.join(dirFor(hash), 'index.db');
export const isIndexed = (hash: string) => fs.existsSync(path.join(dirFor(hash), 'DONE'));

/** Hash of a file, reusing the registry when size and mtime are unchanged (avoids re-reading 200 MB per query). */
export async function hashFor(file: string, onBytes?: (n: number) => void): Promise<string> {
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  const reg = readRegistry();
  const e = reg.files[abs];
  if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && isIndexed(e.hash)) return e.hash;
  return sha256File(abs, onBytes);
}

export function rememberFile(file: string, hash: string): void {
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  const reg = readRegistry();
  reg.files[abs] = { size: st.size, mtimeMs: st.mtimeMs, hash };
  reg.current = { hash, file: abs };
  writeRegistry(reg);
}

export interface Opened { db: DatabaseSync; hash: string; dir: string; file: string }

/** Opens the index for `--file` or the most recently indexed file. Sync and fast (no hashing when registry matches). */
export function openIndex(file?: string): Opened {
  const reg = readRegistry();
  let hash: string | undefined;
  let src: string | undefined;
  if (file) {
    const abs = path.resolve(file);
    const e = reg.files[abs];
    if (e && fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      if (st.size === e.size && st.mtimeMs === e.mtimeMs) hash = e.hash;
    }
    if (!hash) throw new Error(`"${file}" is not indexed (or has changed). Run first: design-query ingest "${file}"`);
    src = abs;
  } else {
    if (!reg.current) throw new Error('No index available. Run first: design-query ingest <file>');
    hash = reg.current.hash; src = reg.current.file;
  }
  if (!isIndexed(hash)) throw new Error('Index incomplete or deleted. Run again: design-query ingest <file>');
  const db = openDb(dbFileFor(hash), { readonly: true });
  if (Number(getMeta(db, 'schema_version') ?? 0) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`The index was created by a different design-query version. Re-index with: design-query ingest "${src}" --force`);
  }
  return { db, hash, dir: dirFor(hash), file: src! };
}
