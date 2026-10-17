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

/** Styles.vars fields whose values are lengths in px */
const PX_KEYS = /^(gap|row-gap|pad-|radius|r-|width|height|min-|max-|font-size|line-height|letter-spacing|stroke-weight|border-|paragraph-|grid-)/;

export const isAlias = (v: unknown): v is string => typeof v === 'string' && v.startsWith('alias:');

/**
 * The explicit mode in effect for a variable: the innermost entry of `modes` ("Collection=Mode", outermost first) that names the
 * variable's own collection and one of its modes. Mode names alone are not unique across collections ("Dark" in two themes).
 * Bare entries (no "=") match by mode name only.
 */
export function pickMode(modes: string[] | undefined, collection: string, values: Record<string, unknown>): string | undefined {
  if (!modes?.length) return undefined;
  for (let i = modes.length - 1; i >= 0; i--) {
    const m = modes[i];
    const at = m.indexOf('=');
    if (at < 0) { if (m in values) return m; continue; }
    const name = m.slice(at + 1);
    if (m.slice(0, at) === collection && name in values) return name;
  }
  return undefined;
}

/** Resolves aliases (alias:<id>) to a concrete value for a mode; guards against cycles. */
export function resolveValue(byId: Map<string, TokenRec>, t: TokenRec, mode: string, depth = 0, modes?: string[]): unknown {
  const keys = Object.keys(t.values);
  const v = t.values[mode] ?? t.values[keys[0]];
  if (isAlias(v) && depth < 10) {
    const target = byId.get(v.slice(6));
    if (!target) return v;
    // an alias target of another collection resolves in that collection's explicit mode if the context sets one, else in its
    // default (first) mode; within the same collection the mode carries over
    const m = pickMode(modes, target.collection, target.values);
    return resolveValue(byId, target, m ?? (target.collection === t.collection ? mode : Object.keys(target.values)[0] ?? mode), depth + 1, modes);
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
  /** Concrete color of a token (by name or id); `modes` are explicit variable modes of the surrounding frames (outermost first). */
  colorValue(ref: string, modes?: string[]): string | undefined {
    const t = this.byName.get(ref) ?? this.byId.get(ref);
    if (!t) return undefined;
    if (!this.mode) {
      const all = modesOf(this.tokens);
      this.mode = all.includes('default') ? 'default' : all.find((m) => /light/i.test(m)) ?? all[0];
    }
    // the innermost explicit mode of this variable's collection wins; without one, the collection's first (default) mode
    const own = pickMode(modes, t.collection, t.values);
    const v = resolveValue(this.byId, t, own ?? Object.keys(t.values)[0] ?? this.mode, 0, modes);
    return typeof v === 'string' && v.startsWith('#') ? v : undefined;
  }
  /** Concrete value of any token (number, string, color) under the explicit modes (innermost first that the collection defines). */
  valueOf(ref: string, modes?: string[]): unknown {
    const t = this.byName.get(ref) ?? this.byId.get(ref);
    if (!t) return undefined;
    if (!this.mode) {
      const all = modesOf(this.tokens);
      this.mode = all.includes('default') ? 'default' : all.find((m) => /light/i.test(m)) ?? all[0];
    }
    const own = pickMode(modes, t.collection, t.values);
    // without an explicit mode a variable shows its collection's first (default) mode
    const v = resolveValue(this.byId, t, own ?? Object.keys(t.values)[0] ?? this.mode, 0, modes);
    return isAlias(v) ? undefined : v;
  }
  /** The value a token takes under `modes` when it differs from its default-mode value (else undefined). */
  modeValue(ref: string, modes?: string[]): unknown {
    if (!modes?.length) return undefined;
    const a = this.valueOf(ref, modes), b = this.valueOf(ref);
    return a !== undefined && a !== b ? a : undefined;
  }
  /**
   * A token reference with its value where it is used: `$name(value)` = use var(--name); here it resolves to value (aliases
   * followed, explicit modes applied). Lengths (`key` = a Styles.vars field such as gap, pad-top, radius, font-size) get `px`.
   * Without a concrete value just `$name`.
   */
  ref(id: string, modes?: string[], key?: string): string {
    const name = `$${this.nameFor(id)}`;
    const v = this.valueOf(id, modes);
    let s: string;
    if (typeof v === 'number') s = `${Math.round(v * 1000) / 1000}${key && PX_KEYS.test(key) ? 'px' : ''}`;
    else if (typeof v === 'string') s = v.length <= 40 && !/[()\s]/.test(v) ? v : JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
    else if (typeof v === 'boolean') s = String(v);
    else return name;
    return `${name}(${s})`;
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

/** Default-mode value of a variable by id or guid, following aliases (used for text bound to a STRING variable). */
export class VarLookup {
  private cache = new Map<string, { v: Record<string, unknown>; c: string } | null>();
  /** `get` returns the variable's values JSON and its collection name */
  constructor(private get: (id: string) => { vals: string; collection?: string | null } | undefined) {}
  private rec(id: string): { v: Record<string, unknown>; c: string } | null {
    if (!this.cache.has(id)) {
      const r = this.get(id);
      const v = safeJson<Record<string, unknown>>(r?.vals);
      this.cache.set(id, v ? { v, c: r?.collection ?? '' } : null);
    }
    return this.cache.get(id) ?? null;
  }
  /** `modes` = explicit modes in effect ("Collection=Mode", outermost first): the innermost one of the variable's collection wins. */
  value(id: string, depth = 0, modes?: string[]): unknown {
    const r = this.rec(id);
    if (!r) return undefined;
    const v = r.v;
    const m = pickMode(modes, r.c, v);
    const first = m !== undefined ? v[m] : Object.values(v)[0];
    if (isAlias(first) && depth < 10) return this.value(first.slice(6), depth + 1, modes);
    return first;
  }
  string(id: string, modes?: string[]): string | undefined {
    const v = this.value(id, 0, modes);
    return typeof v === 'string' && !isAlias(v) ? v : undefined;
  }
}
