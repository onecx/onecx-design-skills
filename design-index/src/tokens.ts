import type { DatabaseSync } from './sqlite.js';
import { safeJson } from './output.js';

export interface TokenRec { guid?: string; id: string; name: string; collection: string; type: string; values: Record<string, unknown> }

/** CSS custom property name for a token: "layer/background (contextual)" -> "layer-background-contextual". */
export function cssName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'token';
}

export function loadTokens(db: DatabaseSync): TokenRec[] {
  return (db.prepare('SELECT id,name,collection,type,vals,guid FROM variables ORDER BY collection,name').all() as { id: string; name: string; collection: string; type: string; vals: string; guid: string | null }[])
    .map((r) => ({ guid: r.guid ?? undefined, id: r.id, name: r.name, collection: r.collection, type: r.type, values: safeJson<Record<string, unknown>>(r.vals) ?? {} }));
}

/**
 * Unique CSS custom property name per token (keyed by id and guid). Names that occur in several collections get the
 * collection as prefix, remaining collisions get a numeric suffix, so `tokens` and `spec` always agree.
 */
export function tokenNames(tokens: TokenRec[]): Map<string, string> {
  const base = new Map<string, TokenRec[]>();
  for (const t of tokens) (base.get(cssName(t.name)) ?? base.set(cssName(t.name), []).get(cssName(t.name))!).push(t);
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const [name, list] of base) {
    const multi = new Set(list.map((t) => t.collection)).size > 1;
    list.forEach((t, i) => {
      let n = multi && t.collection ? `${cssName(t.collection)}-${name}` : name;
      if (used.has(n)) { let k = 2; while (used.has(`${n}-${k}`)) k++; n = `${n}-${k}`; }
      void i;
      used.add(n);
      out.set(t.id, n);
      if (t.guid) out.set(t.guid, n);
    });
  }
  return out;
}

export const isAlias = (v: unknown): v is string => typeof v === 'string' && v.startsWith('alias:');

/** Resolves aliases (alias:<id>) to a concrete value for a mode; guards against cycles. */
export function resolveValue(byId: Map<string, TokenRec>, t: TokenRec, mode: string, depth = 0): unknown {
  const keys = Object.keys(t.values);
  const v = t.values[mode] ?? t.values[keys[0]];
  if (isAlias(v) && depth < 10) {
    const target = byId.get(v.slice(6));
    return target ? resolveValue(byId, target, mode, depth + 1) : v;
  }
  return v;
}

export function modesOf(tokens: TokenRec[]): string[] {
  const s = new Set<string>();
  for (const t of tokens) for (const k of Object.keys(t.values)) s.add(k);
  return [...s];
}

/** Token name lookups used by `spec`: variable-bound names are exact; hex matches are hints only. */
export class TokenIndex {
  tokens: TokenRec[];
  byId = new Map<string, TokenRec>();
  byName = new Map<string, TokenRec>();
  colorByHex = new Map<string, string>();

  constructor(db: DatabaseSync) {
    this.tokens = loadTokens(db);
    for (const t of this.tokens) { this.byId.set(t.id, t); if (t.guid) this.byId.set(t.guid, t); this.byName.set(t.name, t); }
    const modes = modesOf(this.tokens);
    const mode = modes.includes('default') ? 'default' : modes.find((m) => /light/i.test(m)) ?? modes[0];
    for (const t of this.tokens) {
      if (t.type.toLowerCase() !== 'color') continue;
      const v = resolveValue(this.byId, t, mode);
      if (typeof v === 'string' && v.startsWith('#') && !this.colorByHex.has(v)) this.colorByHex.set(v, t.name);
    }
  }
  private mode?: string;
  /** Concrete color of a token (by name or id) in the default mode. */
  colorValue(ref: string): string | undefined {
    const t = this.byName.get(ref) ?? this.byId.get(ref);
    if (!t) return undefined;
    if (!this.mode) {
      const modes = modesOf(this.tokens);
      this.mode = modes.includes('default') ? 'default' : modes.find((m) => /light/i.test(m)) ?? modes[0];
    }
    const v = resolveValue(this.byId, t, this.mode);
    return typeof v === 'string' && v.startsWith('#') ? v : undefined;
  }
  get empty(): boolean { return this.tokens.length === 0; }
  private names?: Map<string, string>;
  nameFor(bound: string): string {
    this.names ??= tokenNames(this.tokens);
    const t = this.byId.get(bound) ?? this.byName.get(bound);
    return (t && this.names.get(t.id)) ?? cssName(bound);
  }
  hexMatch(hex: string): string | undefined {
    const n = this.colorByHex.get(hex);
    return n ? this.nameFor(n) : undefined;
  }
}
