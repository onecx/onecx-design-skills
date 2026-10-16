import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetRow } from './model.js';

export function sniffMime(head: Buffer): { mime: string; ext: string } {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (head[0] === 0xff && head[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  const t = head.toString('utf8', 0, 256).trimStart();
  if (t.startsWith('<svg') || t.startsWith('<?xml')) return { mime: 'image/svg+xml', ext: 'svg' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

/** PNG/JPEG/WebP/GIF dimensions from the first bytes; undefined if unknown. */
export function imageSize(head: Buffer): { w: number; h: number } | undefined {
  try {
    if (head.subarray(1, 4).toString('latin1') === 'PNG') return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
    if (head.subarray(0, 3).toString('latin1') === 'GIF') return { w: head.readUInt16LE(6), h: head.readUInt16LE(8) };
    if (head[0] === 0xff && head[1] === 0xd8) {
      let o = 2;
      while (o + 9 < head.length) {
        if (head[o] !== 0xff) { o++; continue; }
        const m = head[o + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: head.readUInt16BE(o + 5), w: head.readUInt16BE(o + 7) };
        o += 2 + head.readUInt16BE(o + 2);
      }
    }
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(12, 16).toString('latin1') === 'VP8X') {
      return { w: 1 + head.readUIntLE(24, 3), h: 1 + head.readUIntLE(27, 3) };
    }
  } catch { /* fall through */ }
  return undefined;
}

/** Writes bytes to a temp file while hashing; `finish` moves it to assets/<hash>.<ext>. */
export class AssetWriter {
  private fd: number;
  private tmp: string;
  private hash = createHash('sha256');
  private size = 0;
  private head: Buffer = Buffer.alloc(0);

  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.tmp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    this.fd = fs.openSync(this.tmp, 'w');
  }

  write(buf: Buffer): void {
    if (this.head.length < 8192) this.head = Buffer.concat([this.head, buf.subarray(0, 8192 - this.head.length)]);
    this.hash.update(buf);
    fs.writeSync(this.fd, buf);
    this.size += buf.length;
  }

  finish(): AssetRow {
    fs.closeSync(this.fd);
    const hash = this.hash.digest('hex').slice(0, 20);
    const { mime, ext } = sniffMime(this.head);
    const file = `${hash}.${ext}`;
    const dest = path.join(this.dir, file);
    if (fs.existsSync(dest)) fs.unlinkSync(this.tmp);
    else fs.renameSync(this.tmp, dest);
    const dim = imageSize(this.head);
    return { hash, path: path.join('assets', file), mime, size: this.size, w: dim?.w, h: dim?.h };
  }

  abort(): void {
    try { fs.closeSync(this.fd); fs.unlinkSync(this.tmp); } catch { /* ignore */ }
  }
}

/** Streaming base64 decoder: feed arbitrary string chunks, never holds more than 3 chars back. */
export class Base64Sink {
  private rest = '';
  constructor(private out: AssetWriter) {}
  push(chunk: string): void {
    const s = (this.rest + chunk).replace(/[^A-Za-z0-9+/=_-]/g, '');
    const n = s.length - (s.length % 4);
    this.rest = s.slice(n);
    if (n) this.out.write(Buffer.from(s.slice(0, n), 'base64'));
  }
  end(): void {
    if (this.rest) this.out.write(Buffer.from(this.rest, 'base64'));
    this.rest = '';
  }
}

/** Copies a file into assets/ streamed (chunked reads), returns the asset row. */
export function importFile(src: string, dir: string): AssetRow {
  const w = new AssetWriter(dir);
  const fd = fs.openSync(src, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      w.write(buf.subarray(0, n));
    }
  } catch (e) {
    w.abort();
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  return w.finish();
}
