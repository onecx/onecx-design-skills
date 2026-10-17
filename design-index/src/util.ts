import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CACHE_DIR_NAME = '.design-index';

export const estTokens = (s: string): number => Math.ceil(s.length / 4);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function sha256File(file: string, onBytes?: (n: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    s.on('data', (c) => { h.update(c); onBytes?.(c.length); });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export const sha256Short = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex').slice(0, 16);

/** Nearest ancestor with .git, else nearest with package.json, else cwd. */
export function repoRoot(from = process.cwd()): string {
  for (const marker of ['.git', 'package.json']) {
    let dir = path.resolve(from);
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return path.resolve(from);
}

export function cacheRoot(): string {
  return process.env.DESIGN_INDEX_DIR ? path.resolve(process.env.DESIGN_INDEX_DIR) : path.join(repoRoot(), CACHE_DIR_NAME);
}

/** The cache is a throwaway folder in the repo: make sure git never sees it. */
export function ensureIgnored(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const self = path.join(root, '.gitignore');
  if (!fs.existsSync(self)) fs.writeFileSync(self, '*\n');
  const repo = path.dirname(root);
  if (!fs.existsSync(path.join(repo, '.git')) || process.env.DESIGN_INDEX_DIR) return;
  const gi = path.join(repo, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  if (!cur.split(/\r?\n/).some((l) => l.trim().replace(/\/$/, '') === CACHE_DIR_NAME)) {
    fs.appendFileSync(gi, `${cur && !cur.endsWith('\n') ? '\n' : ''}${CACHE_DIR_NAME}/\n`);
  }
}

export class Progress {
  private last = 0;
  private lastPct = 0;
  constructor(private label: string, private total: number, private enabled = true) {}
  update(done: number): void {
    if (!this.enabled || this.total <= 0) return;
    const pct = Math.min(100, Math.floor((done / this.total) * 100));
    const now = Date.now();
    if (process.stderr.isTTY) {
      if (now - this.last > 200) {
        this.last = now;
        process.stderr.write(`\r${this.label} ${pct}% (${fmtBytes(done)}/${fmtBytes(this.total)})   `);
      }
    } else if (pct >= this.lastPct + 10) {
      this.lastPct = pct - (pct % 10);
      process.stderr.write(`${this.label} ${pct}% (${fmtBytes(done)}/${fmtBytes(this.total)})\n`);
    }
  }
  done(msg = ''): void {
    if (!this.enabled) return;
    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(70) + '\r');
    if (msg) process.stderr.write(msg + '\n');
  }
}

export const log = (msg: string): void => { process.stderr.write(msg + '\n'); };

/** Round to 2 decimals and drop the trailing zeros; keeps output compact. */
export function n2(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '?';
  return String(Math.round(v * 100) / 100);
}

/** Phase timing for diagnostics: DESIGN_INDEX_DEBUG=1 prints durations to stderr. */
export function timed<T>(label: string, fn: () => T): T {
  if (!process.env.DESIGN_INDEX_DEBUG) return fn();
  const t = Date.now();
  const r = fn();
  process.stderr.write(`[time] ${label}: ${Date.now() - t} ms, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB\n`);
  return r;
}
