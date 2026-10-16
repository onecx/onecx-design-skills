// Instance evaluation for the index: expands instances from their components with Figma's semantics.
//
// Ported (semantics, not code) from open-pencil's @open-pencil/fig `instance-overrides` (MIT,
// https://github.com/open-pencil/open-pencil/tree/main/packages/fig/docs/instance-evaluation.md):
//   - an instance expands its component's subtree; every owner contributes *layers* addressed relative to it,
//     the outermost owner wins where layers overlap
//   - structural layers (instance swap, property assignments) are routed down to the instance they configure BEFORE it
//     expands, so every occurrence expands exactly once with its effective component and complete assignment list
//   - property layers (text, visibility, styles, size) are applied by their declaring owner after its subtree is built
//   - component properties bind VISIBLE / TEXT_DATA / OVERRIDDEN_SYMBOL_ID of nodes; values start at the definition's default
//   - override paths are sequences of override keys across instance boundaries ([A, Label] != [B, Label]); a segment is never
//     searched across an instance boundary implicitly
//   - saved derived data (effective size/position per path) is a cache applied last
// Simplifications: no slot-content frames (none occur in the test files), no resize constraints, no variable-binding scales.
import type { DatabaseSync } from './sqlite.js';
import type { Styles } from './model.js';
import { mergeStyles, ovsOf, type Ov } from './overrides.js';
import { safeJson } from './output.js';
import type { NodeRec } from './commands/structure.js';

const COLS = 'id,parent_id,page,type,name,depth,ord,x,y,w,h,layout,styles,text,component_ref,visible,raw,nchild,stext';

type Val = unknown;
interface Binding { v: Val; origin: 'default' | 'assignment'; rank?: number; used: boolean }
type Bindings = Map<string, Binding>;
/** A structural layer: swap and/or assignments, path relative to the expansion that receives it. */
interface Layer { path: string[]; swap?: string; pa?: Record<string, Val>; rank: number }
interface Claim { path: string[]; ov: Ov }

export interface VNode {
  /** a copy of the source row with bindings, claims and derived geometry applied */
  row: NodeRec;
  kids: VNode[];
  /** hidden after evaluation (own flag, property binding or claim) */
  hidden: boolean;
  /** number of children that were not built because of the depth limit */
  truncated?: number;
  /** text values assigned to this instance that no node of its component consumed */
  unplaced?: string[];
  /** explicit variable modes set on this frame (collection = mode) */
  modes?: string[];
  /** fields set by an assignment, by the rank of the assigning owner */
  assigned: Map<string, number>;
  isInstance: boolean;
  /** geometry table key of a saved (resized) vector shape for this occurrence */
  geomKey?: string;
}

export class TooBig extends Error {}

export interface EvalOptions { maxDepth: number; cap: number }

const keyOf = (r: NodeRec, raw: Record<string, any> | null): string[] => [raw?.ok as string | undefined, r.id].filter(Boolean) as string[];

export class Evaluator {
  private rowC = new Map<string, NodeRec | undefined>();
  private rawC = new Map<string, Record<string, any> | null>();
  private kidsC = new Map<string, NodeRec[]>();
  private staticC = new Map<string, Map<string, { top: string; direct: boolean }>>();
  private defsC = new Map<string, Bindings>();
  private derivedC = new Map<string, { p: string[]; ps: string; w: number | null; h: number | null; x: number | null; y: number | null; geom: string | null }[]>();
  private modeNames = new Map<string, string>();
  private setNames = new Map<string, string>();
  private count = 0;
  private qRow;
  private qKids;
  private qDefs;
  private qDef;
  private qDerived;

  constructor(private db: DatabaseSync, private opts: EvalOptions) {
    this.qRow = db.prepare(`SELECT ${COLS} FROM nodes WHERE id=?`);
    this.qKids = db.prepare(`SELECT ${COLS} FROM nodes WHERE parent_id=? ORDER BY ord`);
    this.qDefs = db.prepare('SELECT id, initial, parent FROM propdefs WHERE owner=?');
    this.qDef = db.prepare('SELECT initial, parent FROM propdefs WHERE id=? LIMIT 1');
    this.qDerived = db.prepare('SELECT p,w,h,x,y,geom FROM derived WHERE inst=?');
    for (const m of db.prepare('SELECT set_id,set_key,set_name,mode_id,mode_name FROM varmodes').all() as { set_id: string; set_key: string | null; set_name: string; mode_id: string; mode_name: string }[]) {
      this.modeNames.set(m.mode_id, m.mode_name);
      this.setNames.set(m.set_id, m.set_name);
      if (m.set_key) this.setNames.set(m.set_key, m.set_name);
    }
  }

  node(id: string): NodeRec | undefined {
    if (!this.rowC.has(id)) this.rowC.set(id, this.qRow.get(id) as unknown as NodeRec | undefined);
    return this.rowC.get(id);
  }
  raw(r: NodeRec): Record<string, any> | null {
    if (!this.rawC.has(r.id)) this.rawC.set(r.id, safeJson<Record<string, any>>(r.raw));
    return this.rawC.get(r.id) ?? null;
  }
  kids(id: string): NodeRec[] {
    let k = this.kidsC.get(id);
    if (!k) { k = this.qKids.all(id) as unknown as NodeRec[]; this.kidsC.set(id, k); }
    return k;
  }

  // ---- component property defaults (propdefs table), definitions inherit through parentPropDefId ----
  private resolveInitial(initialJson: string | null, parent: string | null, depth = 0): Val {
    const v = initialJson == null ? null : JSON.parse(initialJson);
    if (v !== null && v !== undefined) return v;
    if (parent && depth < 8) {
      const p = this.qDef.get(parent) as { initial: string | null; parent: string | null } | undefined;
      if (p) return this.resolveInitial(p.initial, p.parent, depth + 1);
    }
    return null;
  }
  /** Defaults of a component; variants also see the definitions of their component set. */
  private defaults(component: NodeRec): Bindings {
    const cached = this.defsC.get(component.id);
    if (cached) return cached;
    const out: Bindings = new Map();
    const owners = [component.id];
    const parent = component.parent_id ? this.node(component.parent_id) : undefined;
    if (parent && this.raw(parent)?.isComponentSet) owners.unshift(parent.id);
    for (const o of owners) {
      for (const d of this.qDefs.all(o) as { id: string; initial: string | null; parent: string | null }[]) {
        const v = this.resolveInitial(d.initial, d.parent);
        if (v !== null && v !== undefined) out.set(d.id, { v, origin: 'default', used: false });
      }
    }
    this.defsC.set(component.id, out);
    return out;
  }

  // ---- static routing: which direct child of a container holds an override key (no instance interiors) ----
  private staticIndex(containerId: string): Map<string, { top: string; direct: boolean }> {
    let idx = this.staticC.get(containerId);
    if (idx) return idx;
    idx = new Map();
    const visit = (children: NodeRec[], top: string | null): void => {
      for (const c of children) {
        const t = top ?? c.id;
        for (const k of keyOf(c, this.raw(c))) if (!idx!.has(k)) idx!.set(k, { top: t, direct: top === null });
        if (c.type !== 'instance') visit(this.kids(c.id), t);
      }
    };
    visit(this.kids(containerId), null);
    this.staticC.set(containerId, idx);
    return idx;
  }
  private route(containerId: string, layers: Layer[]): Map<string, Layer[]> {
    const out = new Map<string, Layer[]>();
    if (!layers.length) return out;
    const idx = this.staticIndex(containerId);
    for (const l of layers) {
      const hit = idx.get(l.path[0]);
      if (!hit) continue; // stale or unresolvable: Figma keeps such records, they configure nothing
      const next: Layer = { ...l, path: hit.direct ? l.path.slice(1) : l.path };
      (out.get(hit.top) ?? out.set(hit.top, []).get(hit.top)!).push(next);
    }
    return out;
  }

  // ---- bindings ----
  private bindRow(row: NodeRec, bindings: Bindings): { row: NodeRec; assigned: Map<string, number> } {
    const raw = this.raw(row);
    const assigned = new Map<string, number>();
    if (!raw?.refs || !bindings.size) return { row, assigned };
    const out: NodeRec = { ...row };
    const take = (field: string, def: string | undefined, apply: (v: Val) => boolean): void => {
      if (!def) return;
      const b = bindings.get(def);
      if (!b) return;
      if (apply(b.v)) {
        b.used = true;
        if (b.origin === 'assignment' && b.rank !== undefined) assigned.set(field, b.rank);
      }
    };
    take('visible', raw.refs.V, (v) => { if (typeof v !== 'boolean') return false; out.visible = v ? 1 : 0; return true; });
    take('text', raw.refs.T, (v) => { if (typeof v !== 'string') return false; out.text = v; return true; });
    take('sym', raw.refs.S, (v) => { const s = (v as { sym?: string } | null)?.sym; if (!s) return false; out.component_ref = s; return true; });
    return { row: out, assigned };
  }

  private scopeOf(component: NodeRec, groups: { pa: Record<string, Val>; rank: number }[]): Bindings {
    const scope: Bindings = new Map();
    for (const [k, b] of this.defaults(component)) scope.set(k, { ...b });
    for (const g of groups) {
      for (const [def, v] of Object.entries(g.pa)) {
        if (v === null || v === undefined) continue;
        scope.set(def, { v, origin: 'assignment', rank: g.rank, used: false });
      }
    }
    return scope;
  }

  // ---- evaluation ----
  build(root: NodeRec): VNode {
    this.count = 0;
    return this.expand(root, new Map(), [], 0, 0);
  }

  private tick(): void {
    if (++this.count > this.opts.cap) throw new TooBig();
  }

  private expand(src: NodeRec, bindings: Bindings, layers: Layer[], rank: number, depth: number): VNode {
    this.tick();
    const bound = this.bindRow(src, bindings);
    const row = bound.row;
    const raw = this.raw(src);
    const node: VNode = { row, kids: [], hidden: !row.visible, assigned: bound.assigned, isInstance: false };
    if (raw?.vm) {
      const modes = (raw.vm as { s: string; m: string }[]).map((e) => `${this.setNames.get(e.s) ?? e.s}=${this.modeNames.get(e.m) ?? e.m}`);
      if (modes.length) node.modes = modes;
    }
    if (src.type === 'instance' && row.component_ref) return this.expandInstance(src, node, bindings, layers, rank, depth);

    // plain node or component definition: children expand with this scope; a component starts a new binding scope
    let scope = bindings;
    let rest = layers;
    if (src.type === 'component') {
      const root = layers.filter((l) => l.path.length === 0 && l.pa).sort((a, b) => b.rank - a.rank);
      scope = this.scopeOf(src, root.map((l) => ({ pa: l.pa!, rank: l.rank })));
      rest = layers.filter((l) => l.path.length > 0);
    }
    const children = this.kids(src.id);
    if (depth >= this.opts.maxDepth) { if (children.length) node.truncated = children.length; return node; }
    const routed = this.route(src.id, rest);
    node.kids = children.map((c) => this.expand(c, scope, routed.get(c.id) ?? [], rank + 1, depth + 1));
    (node as VNode & { scope?: Bindings }).scope = src.type === 'component' ? scope : undefined;
    return node;
  }

  private expandInstance(src: NodeRec, node: VNode, bindings: Bindings, layers: Layer[], rank: number, depth: number): VNode {
    node.isInstance = true;
    const raw = this.raw(src);
    const original = src.component_ref!;
    let effective = node.row.component_ref!; // after a binding-driven swap
    // own layers: paths are relative to this instance's component content
    const structural: Layer[] = [];
    const claims: Claim[] = [];
    for (const o of ovsOf(raw)) {
      if (!o.p) continue;
      const path = o.p.split('/');
      if (o.swap || o.pa) structural.push({ path, swap: o.swap, pa: o.pa, rank });
      if (o.t !== undefined || o.hidden || o.show || o.st || o.sz || o.vm) claims.push({ path, ov: o });
    }
    // an override without path swaps/configures the instance itself (pen refs never have one)
    const self = ovsOf(raw).find((o) => !o.p && o.swap);
    if (self?.swap) effective = self.swap;
    let swappedExplicitly = !!self?.swap;
    const all = [...structural, ...layers].sort((a, b) => b.rank - a.rank);

    const comp0 = this.node(effective);
    const rootKeys = new Set<string>([original, effective]);
    for (const id of [original, effective]) { const r = this.node(id); const ok = r && this.raw(r)?.ok; if (ok) rootKeys.add(ok); }
    const groups: { pa: Record<string, Val>; rank: number }[] = [{ pa: (raw?.pid as Record<string, Val>) ?? {}, rank }];
    const descendant: Layer[] = [];
    for (const l of all) {
      const addressesRoot = l.path.length === 0 || rootKeys.has(l.path[0]);
      if (!addressesRoot || l.path.length > 1) { descendant.push(addressesRoot ? { ...l, path: l.path.slice(1) } : l); continue; }
      if (l.swap) {
        swappedExplicitly = true;
        effective = l.swap;
        for (const id of [effective]) { const r = this.node(id); const ok = r && this.raw(r)?.ok; rootKeys.add(id); if (ok) rootKeys.add(ok); }
      }
      if (l.pa) groups.push({ pa: l.pa, rank: l.rank });
    }
    void comp0;
    // HEURISTIC (not in the open-pencil model): files store no "visible" record for a node that was hidden in its component and
    // then explicitly swapped and filled by an instance, yet Figma shows it. Treat an explicit swap as "in use" unless a property
    // binding decided visibility; later claims (visible=false) still win.
    if (swappedExplicitly && node.hidden && !node.assigned.has('visible')) { node.hidden = false; node.row = { ...node.row, visible: 1 }; }
    const comp = this.node(effective);
    node.row = { ...node.row, component_ref: effective };
    if (!comp) return node; // component not in the file (library): stays a childless instance
    // expand the component once with the complete assignment list and the layers addressed into it
    const rootLayers: Layer[] = groups.filter((g) => Object.keys(g.pa).length).map((g) => ({ path: [], pa: g.pa, rank: g.rank }));
    const base = this.expand(comp, new Map(), [...rootLayers, ...descendant], rank + 1, depth);
    node.kids = base.kids;
    node.truncated = base.truncated;
    // explicit variable modes set on the component's root apply to everything it contains
    if (base.modes?.length) node.modes = [...(node.modes ?? []), ...base.modes];
    // a swapped-in component also brings its own look (fill, stroke, radius, size); pen refs carry none of their own
    const swapped = effective !== original;
    const brow = base.row;
    if (swapped || !node.row.layout || !node.row.styles || node.row.w == null || node.row.h == null) {
      node.row = {
        ...node.row,
        layout: swapped ? brow.layout : node.row.layout ?? brow.layout,
        styles: swapped ? brow.styles : node.row.styles ?? brow.styles,
        w: swapped ? brow.w : node.row.w ?? brow.w,
        h: swapped ? brow.h : node.row.h ?? brow.h,
      };
    }
    // text values handed to this instance that no node of its component took
    const scope = (base as VNode & { scope?: Bindings }).scope;
    if (scope) {
      const own = new Set<string>();
      for (const g of groups) for (const k of Object.keys(g.pa)) own.add(k);
      const unplaced = [...own].filter((k) => { const b = scope.get(k); return b && b.origin === 'assignment' && !b.used && typeof b.v === 'string' && b.v.trim(); }).map((k) => String(scope.get(k)!.v));
      if (unplaced.length) node.unplaced = unplaced;
    }
    // property claims of this owner, then the saved layout cache; outer owners run after inner ones by construction
    for (const c of claims) {
      const target = this.resolve(node, c.path);
      if (target) this.applyClaim(target, c.ov, rank);
    }
    for (const d of this.derivedOf(src.id)) {
      const target = this.resolve(node, d.p);
      if (!target || target === node) continue;
      const r = { ...target.row };
      if (d.w != null) r.w = d.w;
      if (d.h != null) r.h = d.h;
      if (d.x != null) r.x = d.x;
      if (d.y != null) r.y = d.y;
      target.row = r;
      if (d.geom) target.geomKey = d.geom;
    }
    return node;
  }

  private derivedOf(inst: string): { p: string[]; ps: string; w: number | null; h: number | null; x: number | null; y: number | null; geom: string | null }[] {
    let d = this.derivedC.get(inst);
    if (!d) {
      d = (this.qDerived.all(inst) as { p: string; w: number | null; h: number | null; x: number | null; y: number | null; geom: string | null }[]).map((r) => ({ ...r, ps: r.p, p: r.p.split('/') }));
      this.derivedC.set(inst, d);
    }
    return d;
  }

  /** Find the node a path addresses: instance boundaries are explicit segments, containers are searched through. */
  private resolve(root: VNode, path: string[]): VNode | undefined {
    let cur = root;
    for (const [i, seg] of path.entries()) {
      if (i === 0) {
        const comp = cur.row.component_ref ? this.node(cur.row.component_ref) : undefined;
        const ok = comp && this.raw(comp)?.ok;
        if (seg === cur.row.component_ref || seg === ok) continue; // addresses the root itself
      }
      const found = this.findWithinBoundary(cur.kids, seg);
      if (!found) return undefined;
      cur = found;
    }
    return cur;
  }
  private findWithinBoundary(kids: VNode[], seg: string): VNode | undefined {
    for (const k of kids) {
      if (keyOf(k.row, this.raw(k.row)).includes(seg)) return k;
      if (!k.isInstance) { const f = this.findWithinBoundary(k.kids, seg); if (f) return f; }
    }
    return undefined;
  }

  private applyClaim(t: VNode, o: Ov, ownerRank: number): void {
    const ranked = (field: string): boolean => { const r = t.assigned.get(field); return r === undefined || r >= ownerRank; };
    const row = { ...t.row };
    if (o.t !== undefined && ranked('text')) row.text = o.t;
    if (o.hidden) { row.visible = 0; t.hidden = true; }
    if (o.show && ranked('visible')) { row.visible = 1; t.hidden = false; }
    if (o.st) row.styles = JSON.stringify(mergeStyles(safeJson<Styles>(row.styles) ?? {}, o.st));
    if (o.sz) { row.w = o.sz.w; row.h = o.sz.h; }
    if (o.vm?.length) t.modes = [...(t.modes ?? []), ...o.vm.map((e) => `${this.setNames.get(e.s) ?? e.s}=${this.modeNames.get(e.m) ?? e.m}`)];
    t.row = row;
  }
}
