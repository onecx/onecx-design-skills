import { estTokens } from './util.js';
import type { Layout, Paint, Styles } from './model.js';

export interface OutOpts { maxTokens: number; json: boolean }

/** Collects output rows under a token budget. Rows beyond the budget are counted, not printed. */
export class Out {
  private heads: string[] = [];
  private rows: { text: string; data?: unknown }[] = [];
  private tail: string[] = [];
  private used = 0;
  skipped = 0;
  private hints: string[] = [];
  extra: Record<string, unknown> = {};

  constructor(public opts: OutOpts) {}

  /** Header lines are always printed. */
  head(text: string): void { this.heads.push(text); this.used += estTokens(text) + 1; }
  /** Footer lines (e.g. summary) are always printed after the rows. */
  foot(text: string): void { this.tail.push(text); this.used += estTokens(text) + 1; }

  /** Returns false (and drops the row) when the budget is exhausted. */
  add(text: string, data?: unknown): boolean {
    const cost = estTokens(text) + 1;
    if (this.used + cost > this.opts.maxTokens - 80 && this.rows.length > 0) { this.skipped++; return false; }
    this.used += cost;
    this.rows.push({ text, data });
    return true;
  }

  /** count rows that were not even attempted (callers that break out of a loop) */
  skip(n: number): void { this.skipped += n; }
  get full(): boolean { return this.used > this.opts.maxTokens - 80; }
  hint(text: string): void { this.hints.push(text); }

  print(): void {
    const hints = [...this.hints];
    if (this.skipped) hints.unshift(`${this.skipped} more lines truncated (use --max-tokens ${this.opts.maxTokens * 2} for more)`);
    if (this.opts.json) {
      process.stdout.write(JSON.stringify({
        head: this.heads, rows: this.rows.map((r) => r.data ?? r.text), foot: this.tail, truncated: this.skipped > 0, hints, ...this.extra,
      }) + '\n');
      return;
    }
    const lines = [...this.heads, ...this.rows.map((r) => r.text), ...this.tail];
    if (hints.length) lines.push(...hints.map((h) => `→ ${h}`));
    process.stdout.write(lines.join('\n') + '\n');
  }
}

// ---- compact formatting helpers --------------------------------------------------------------

export const q = (s: string | null | undefined, max = 60): string => {
  if (!s) return '""';
  const t = s.replace(/\s+/g, ' ').trim();
  return JSON.stringify(t.length > max ? t.slice(0, max - 1) + '…' : t);
};

const num = (v: number): string => String(Math.round(v * 100) / 100);

export function sizeStr(w: number | null, h: number | null, l: Layout | null): string {
  const f = (v: number | null, rule: Layout['w']) => (rule === 'fill' ? 'fill' : rule === 'hug' ? (v != null ? `hug(${num(v)})` : 'hug') : v != null ? num(v) : '?');
  if (w == null && h == null && !l?.w && !l?.h) return '';
  return `${f(w, l?.w)}×${f(h, l?.h)}`;
}

export function layoutStr(l: Layout | null | undefined): string {
  if (!l) return '';
  const p: string[] = [];
  if (l.dir) p.push(l.dir);
  if (l.gap !== undefined) p.push(`gap=${l.gap}`);
  if (l.pad) {
    const [t, r, b, le] = l.pad;
    p.push(`pad=${t === b && r === le ? (t === r ? t : `${t},${r}`) : `${t},${r},${b},${le}`}`);
  }
  if (l.jc) p.push(`jc=${l.jc}`);
  if (l.ai) p.push(`ai=${l.ai}`);
  if (l.wrap) p.push('wrap');
  if (l.abs) p.push('abs');
  return p.join(' ');
}

export type NameOf = (v: string, key?: string, saved?: string) => string;
const rnd = (v: number, d = 1) => { const f = 10 ** d; return Math.round(v * f) / f; };

/**
 * A gradient in CSS notation. With saved handles (`p`, node-normalized) and the node size it gives the CSS angle and stop positions
 * that reproduce Figma's gradient line; without them only the colours are known.
 */
export function gradientStr(p: Paint & { k: 'grad' }, w?: number | null, h?: number | null, color: (c: string) => string = (c) => c): string {
  const W = w || 1, H = h || 1;
  const hp = p.p;
  if (hp && p.t === 'linear' && hp.length >= 4) {
    const [x1, y1, x2, y2] = [hp[0] * W, hp[1] * H, hp[2] * W, hp[3] * H];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const ang = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const L = Math.abs(W * ux) + Math.abs(H * uy) || 1;
    const at = (t: number) => (((x1 + t * dx - W / 2) * ux + (y1 + t * dy - H / 2) * uy) / L + 0.5) * 100;
    return `linear-gradient(${rnd(ang, 0)}deg, ${p.stops.map(([c, t]) => `${color(c)} ${rnd(at(t))}%`).join(', ')})`;
  }
  if (hp && hp.length >= 6) {
    const [cx, cy, ax, ay, bx, by] = [hp[0] * W, hp[1] * H, hp[2] * W, hp[3] * H, hp[4] * W, hp[5] * H];
    const at = `at ${rnd((cx / W) * 100)}% ${rnd((cy / H) * 100)}%`;
    const stops = p.stops.map(([c, t]) => `${color(c)} ${rnd(t * 100)}%`).join(', ');
    if (p.t === 'angular') return `conic-gradient(from ${rnd(((90 + (Math.atan2(ay - cy, ax - cx) * 180) / Math.PI) % 360 + 360) % 360, 0)}deg ${at}, ${stops})`;
    const size = `${rnd(Math.hypot(ax - cx, ay - cy))}px ${rnd(Math.hypot(bx - cx, by - cy))}px`;
    return `${p.t === 'diamond' ? 'diamond' : 'radial'}-gradient(${size} ${at}, ${stops})`;
  }
  return `${p.t}-gradient(${p.stops.map((s) => color(s[0])).join('→')})`;
}

/**
 * Paint opacity of a token-bound solid paint: `/opA` after `$name(value)` (CSS: color-mix(in srgb, var(--name) A×100%, transparent),
 * or the value with alpha A); empty at full opacity.
 */
export const opSuffix = (o: number | undefined): string => (o != null && o < 1 ? `/op${Math.round(o * 1000) / 1000}` : '');

export function paintStr(p: Paint, nameOf?: NameOf, w?: number | null, h?: number | null): string {
  const bm = p.bm ? `|${p.bm}` : '';
  if (p.k === 'solid') return (p.v ? `$${nameOf ? nameOf(p.v, undefined, p.c) : p.v}` : p.c ?? '?') + bm;
  if (p.k === 'grad') return gradientStr(p, w, h) + bm;
  return `img(${p.asset ?? p.url ?? '?'}${p.mode && p.mode !== 'cover' && p.mode !== 'fill' ? ',' + p.mode : ''}${p.o != null ? ',op' + p.o : ''})${bm}`;
}

/**
 * Figma "Auto" line height, explicit: `lh-normal(33px)` = CSS `line-height: normal`, with Figma's own line pitch
 * round(natural line height × font size) when the font's natural line height is known; else `lh-normal`.
 */
export function lhNormal(f: { nlh?: unknown; lpx?: unknown; s?: unknown }, size?: unknown): string {
  const p = autoPitch(f, size);
  return p !== undefined ? `lh-normal(${Math.round(p * 100) / 100}px)` : 'lh-normal';
}

/**
 * Figma's line pitch (px) of an Auto line height: the node's saved pitch (`lpx`) while it fits the font size in effect, else
 * round(natural line height × size) as Figma computes it for current texts; undefined when the font's metrics are unknown.
 * `size` = the size in effect when it differs from the saved one (variable mode, range).
 */
// The saved pitch is trusted only within max(1px, 5 %) of natural line height × size: a one-line text whose saved line is
// taller because a range has a bigger size (the line takes the largest pitch) is rejected and falls back to round(nlh × size).
export function autoPitch(f: { nlh?: unknown; lpx?: unknown; s?: unknown }, size?: unknown): number | undefined {
  const s = typeof size === 'number' ? size : f.s;
  const nlh = typeof f.nlh === 'number' && f.nlh > 0 ? f.nlh : undefined;
  if (typeof f.lpx === 'number' && f.lpx > 0 && (size === undefined || size === f.s) && (!nlh || typeof s !== 'number' || Math.abs(f.lpx - nlh * s) <= Math.max(1, 0.05 * f.lpx))) return f.lpx;
  return nlh && typeof s === 'number' && s > 0 ? Math.round(nlh * s) : undefined;
}

/** Letter spacing with its unit: numbers are px (`ls0.1px`), unresolved percentages keep `%`, tokens stay as they are. */
export function lsStr(v: unknown): string {
  if (typeof v === 'number') return `ls${Math.round(v * 100) / 100}px`;
  const t = String(v);
  return /^-?\d*\.?\d+$/.test(t) ? `ls${t}px` : `ls${t}`;
}

/** Text attributes besides the font: case, vertical alignment, truncation. */
export function textAttrs(f: Styles['font'] | undefined): string[] {
  const out: string[] = [];
  if (!f) return out;
  if (f.case) out.push(`case=${f.case}`);
  if (f.va) out.push(`valign=${f.va}`);
  if (f.trunc) out.push(typeof f.trunc === 'number' ? `truncate lines=${f.trunc}` : 'truncate');
  if (f.trim) out.push(`trim=${f.trim}`);
  return out;
}

/** `fig` = absent line height is Figma's explicit Auto (printed `lh-normal`); .pen leaves it unspecified */
export function stylesStr(s: Styles | null | undefined, opts: { text?: boolean; isText?: boolean; nameOf?: NameOf; fig?: boolean } = {}): string {
  const pstr = (p: Paint) => paintStr(p, opts.nameOf);
  if (!s) return '';
  const p: string[] = [];
  if (s.fill?.length) p.push(`${opts.isText ? 'color' : 'fill'}=${s.fill.map(pstr).join('+')}`);
  if (s.stroke) p.push(`stroke=${s.stroke.paints.map(pstr).join('+')}${s.stroke.w != null ? `/${Array.isArray(s.stroke.w) ? s.stroke.w.join(',') : s.stroke.w}` : ''}${s.stroke.dash?.length ? `/dash${s.stroke.dash.join(',')}` : ''}`);
  if (s.r != null) p.push(`r=${Array.isArray(s.r) ? s.r.join(',') : s.r}`);
  if (s.op != null) p.push(`op=${s.op}`);
  if (s.blend) p.push(`blend=${s.blend}`);
  if (s.fx?.length) p.push(`fx=${s.fx.map((e) => (e.k === 'shadow' ? `shadow(${e.x ?? 0},${e.y ?? 0},${e.blur ?? 0}${e.c ? ',' + e.c : ''})` : `${e.k}(${e.blur ?? 0})`)).join('+')}`);
  if (s.font && opts.text !== false) {
    // .pen stores `$name` references in font fields: print them as `$name(value)` like bound variables
    const lit = (x: unknown, k?: string): unknown => (typeof x === 'string' && x.startsWith('$') && opts.nameOf ? `$${opts.nameOf(x.slice(1), k)}` : x);
    // .pen line height is a multiplier of the font size: its token value gets no unit
    const f = { ...s.font, f: lit(s.font.f, 'font-family') as string | undefined, s: lit(s.font.s, 'font-size') as number | string | undefined, lh: lit(s.font.lh) as number | string | undefined };
    p.push(`font=${[f.f, f.s != null ? `${f.s}` : '', f.w != null && f.w !== 'normal' && f.w !== 400 ? `w${f.w}` : '', f.lh != null ? `lh${f.lh}` : opts.fig ? lhNormal(f) : '', f.ls != null ? lsStr(f.ls) : '', f.al, f.st, f.deco].filter((x) => x !== '' && x != null).join('/')}`);
    p.push(...textAttrs(f));
  }
  if (s.rot) p.push(`rot=${s.rot}`);
  if (s.flip) p.push(`flip=${s.flip}`);
  if (s.sty) p.push(`styles{${Object.entries(s.sty).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(',')}}`);
  if (s.vars) p.push(`vars=${Object.entries(s.vars).map(([k, v]) => `${k}:$${opts.nameOf ? opts.nameOf(v, k) : v}`).join(',')}`);
  return p.join(' ');
}

export function safeJson<T = unknown>(s: string | null | undefined): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}
