import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from '../sqlite.js';
import { Out, q, safeJson } from '../output.js';
import { cssName, isAlias, loadTokens, modesOf, resolveValue, tokenNames, type TokenRec } from '../tokens.js';

interface CompRec { id: string; name: string; page: number; description: string; set_id: string | null; set_name: string | null; variant: string | null; props: string | null; instances: number }

export function components(db: DatabaseSync, out: Out, filter?: string): void {
  const rows = db.prepare('SELECT id,name,page,description,set_id,set_name,variant,props,instances FROM components ORDER BY COALESCE(set_name,name), name').all() as unknown as CompRec[];
  if (!rows.length) {
    out.head('# 0 components. The file contains no reusable components (pen: `reusable`, fig: SYMBOL).');
    out.hint('UI building blocks as repetitions: `audit` (duplicates) lists candidates for new components.');
    return;
  }
  const f = filter?.toLowerCase();
  const groups = new Map<string, CompRec[]>();
  for (const r of rows) {
    const key = r.set_name ?? r.name;
    if (f && !key.toLowerCase().includes(f) && !r.name.toLowerCase().includes(f)) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  out.head(`# ${groups.size} components (sets), ${rows.length} entries in total${f ? ` · filter "${filter}"` : ''}`);
  for (const [name, list] of groups) {
    const inst = list.reduce((a, b) => a + b.instances, 0);
    const first = list[0];
    const props = safeJson<Record<string, unknown>>(first.props);
    const variantAxes = new Map<string, Set<string>>();
    for (const r of list) for (const [k, v] of Object.entries(safeJson<Record<string, string>>(r.variant) ?? {})) (variantAxes.get(k) ?? variantAxes.set(k, new Set()).get(k)!).add(v);
    const parts = [`${q(name, 50)} id=${list.length === 1 || !first.set_id ? first.id : first.set_id}`, `${list.length > 1 ? list.length + ' variants' : '1'}`, `${inst}× used`];
    if (variantAxes.size) parts.push(`variants: ${[...variantAxes].map(([k, v]) => `${k}={${[...v].slice(0, 8).join('|')}${v.size > 8 ? '|…' : ''}}`).join(' ')}`);
    if (props && Object.keys(props).length) parts.push(`props: ${Object.entries(props).map(([k, v]) => `${k}:${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ').slice(0, 160)}`);
    if (first.description) parts.push(`„${first.description.replace(/\s+/g, ' ').slice(0, 100)}“`);
    out.add(parts.join(' · '), { name, id: first.id, variants: list.length, instances: inst, axes: Object.fromEntries([...variantAxes].map(([k, v]) => [k, [...v]])), props });
  }
  out.hint('`tree <id> --depth 2` or `spec <id>` shows the structure of a component; `states <id>` lists states.');
}

// ---- tokens -------------------------------------------------------------------------------------
const UNITLESS = /opacity|weight|ratio|z-?index|line-?height|scale|count|flex/i;

function cssValue(t: TokenRec, v: unknown, byId: Map<string, TokenRec>, names: Map<string, string>): string | undefined {
  if (isAlias(v)) {
    const target = byId.get(v.slice(6));
    return target ? `var(--${names.get(target.id) ?? cssName(target.name)})` : undefined;
  }
  const type = t.type.toLowerCase();
  if (type === 'color') return typeof v === 'string' ? v : undefined;
  if (type === 'number' || type === 'float') return typeof v === 'number' ? (UNITLESS.test(t.name) || v === 0 ? String(v) : `${v}px`) : undefined;
  if (type === 'string') return typeof v === 'string' ? (/font|family/i.test(t.name) && !v.includes(',') ? `"${v}"` : v) : undefined;
  return undefined;
}

const themeSel = (m: string) => `[data-theme="${m.replace(/^[^=]+=/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}"]`;

export function buildTokens(db: DatabaseSync, format: 'css' | 'json' | 'ts', derive: boolean): { text: string; count: number; themes: string[]; derived: boolean } {
  let tokens = loadTokens(db);
  const names = tokenNames(tokens);
  const nm = (t: TokenRec) => names.get(t.id) ?? cssName(t.name);
  const byId = new Map(tokens.flatMap((t) => (t.guid ? [[t.id, t], [t.guid, t]] : [[t.id, t]])) as [string, TokenRec][]);
  let derived = false;
  if (!tokens.length && derive) {
    derived = true;
    tokens = [];
    const u = db.prepare("SELECT kind,value,n FROM usage ORDER BY kind, n DESC").all() as { kind: string; value: string; n: number }[];
    const take = (kind: string, max: number) => u.filter((x) => x.kind === kind).slice(0, max);
    for (const x of take('color', 40)) tokens.push({ id: `c${x.value}`, name: `color-${x.value.slice(1)}`, collection: 'derived', type: 'color', values: { default: x.value } });
    take('fontSize', 20).sort((a, b) => Number(a.value) - Number(b.value)).forEach((x) => tokens.push({ id: `f${x.value}`, name: `font-size-${x.value}`, collection: 'derived', type: 'number', values: { default: Number(x.value) } }));
    for (const k of ['gap', 'pad'] as const) take(k, 20).sort((a, b) => Number(a.value) - Number(b.value)).forEach((x) => tokens.push({ id: `${k}${x.value}`, name: `space-${x.value}`, collection: 'derived', type: 'number', values: { default: Number(x.value) } }));
    take('radius', 12).sort((a, b) => Number(a.value) - Number(b.value)).forEach((x) => tokens.push({ id: `r${x.value}`, name: `radius-${x.value}`, collection: 'derived', type: 'number', values: { default: Number(x.value) } }));
    const seen = new Set<string>();
    tokens = tokens.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  }
  const modes = modesOf(tokens);
  const base = modes.includes('default') ? 'default' : modes[0];
  const themes = modes.filter((m) => m !== base);

  if (format === 'json') {
    const o: Record<string, unknown> = {};
    for (const t of tokens) o[nm(t)] = { name: t.name, collection: t.collection, type: t.type, values: Object.fromEntries(Object.keys(t.values).map((m) => [m, isAlias(t.values[m]) ? `{${nm(byId.get((t.values[m] as string).slice(6)) ?? t)}}` : t.values[m]])) };
    return { text: JSON.stringify(o, null, 2) + '\n', count: tokens.length, themes, derived };
  }
  if (format === 'ts') {
    const lines = ['// generated by design-query tokens', 'export const tokens = {'];
    for (const t of tokens) { const v = resolveValue(byId, t, base); lines.push(`  '${nm(t)}': ${JSON.stringify(v)},`); }
    lines.push('} as const;', 'export type TokenName = keyof typeof tokens;', `export const cssVar = (n: TokenName) => \`var(--\${n})\`;`);
    return { text: lines.join('\n') + '\n', count: tokens.length, themes, derived };
  }
  // css
  const lines: string[] = [`/* generated by design-query tokens${derived ? ' --derive (from values in use; the file defines no tokens)' : ''} */`, ':root {'];
  let lastColl = '';
  for (const t of tokens) {
    if (t.collection !== lastColl) { lastColl = t.collection; if (lastColl) lines.push(`  /* ${lastColl} */`); }
    const v = cssValue(t, t.values[base] ?? t.values[Object.keys(t.values)[0]], byId, names);
    if (v !== undefined) lines.push(`  --${nm(t)}: ${v};`);
  }
  lines.push('}');
  // per token: first mode is the default (:root); every other mode becomes a selector block.
  // Collections that look like color themes use [data-theme="x"]; others (density, breakpoint, ...) use [data-<collection>="x"].
  const THEMEISH = /theme|aura|appearance|colou?r|scheme|dark|light/i;
  const blocks = new Map<string, string[]>();
  const sel = (t: TokenRec, m: string) => (!t.collection || THEMEISH.test(t.collection) ? themeSel(m) : `[data-${cssName(t.collection)}="${m.replace(/^[^=]+=/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}"]`);
  for (const t of tokens) {
    const keys = Object.keys(t.values);
    const bv = cssValue(t, t.values[keys[0]], byId, names);
    for (const m of keys.slice(1)) {
      const v = cssValue(t, t.values[m], byId, names);
      if (v === undefined || v === bv) continue;
      const k = sel(t, m);
      (blocks.get(k) ?? blocks.set(k, []).get(k)!).push(`  --${nm(t)}: ${v};`);
    }
  }
  for (const [k, body] of blocks) lines.push('', `${k} {`, ...body, '}');
  void base;
  return { text: lines.join('\n') + '\n', count: tokens.length, themes, derived };
}

export function tokensCommand(db: DatabaseSync, out: Out, o: { format: string; out?: string; derive?: boolean }): void {
  const format = (['css', 'json', 'ts'].includes(o.format) ? o.format : 'css') as 'css' | 'json' | 'ts';
  const r = buildTokens(db, format, !!o.derive);
  if (!r.count) {
    out.head('# 0 tokens: the file defines no variables/styles.');
    const u = db.prepare("SELECT kind, COUNT(*) c FROM usage GROUP BY kind").all() as { kind: string; c: number }[];
    out.add(`distinct values in use: ${u.map((x) => `${x.kind}:${x.c}`).join(' ')}`);
    out.hint('`tokens --derive --out <file>` generates custom properties from the values actually used (marked as derived).');
    return;
  }
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, r.text);
    out.add(`${r.count} Tokens → ${o.out}${r.themes.length ? ` (modes: ${r.themes.slice(0, 8).join(', ')}${r.themes.length > 8 ? ` +${r.themes.length - 8}` : ''})` : ''}${r.derived ? ' [derived]' : ''}`, { count: r.count, file: o.out, themes: r.themes });
    return;
  }
  out.head(`# ${r.count} tokens · modes: ${r.themes.slice(0, 8).join(', ') || '-'}${r.derived ? ' [derived]' : ''} (preview; full output with --out <file>)`);
  for (const l of r.text.split('\n').slice(0, 400)) out.add(l);
  out.hint('Write into the project with `--out src/styles/tokens.css` instead of loading it into the context.');
}
