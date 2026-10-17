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
//   - slot content (SLOT_CONTENT_ID property): the slot frame shows the assigned content frame's children, without bindings
//   - text bound to a variable shows the variable's value; an owner's bare binding entry clears it (literal shows)
//   - uniformScaleFactor (instance "scale"): the expanded content is scaled after the claims and before the saved derived data
//   - text bound to a STRING variable resolves under the nearest explicit mode of its collection
// Simplifications: no resize constraints, no variable-binding scales.
import type { DatabaseSync } from './sqlite.js';
import type { Layout, Styles } from './model.js';
import { mergeStyles, ovsOf, type Ov } from './overrides.js';
import { safeJson } from './output.js';
import type { NodeRec } from './commands/structure.js';
import { AI, JC } from './parsers/fig-convert.js';
import { VarLookup } from './tokens.js';
import { pctLineHeight } from './parsers/fig-styles.js';

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
  /** size the saved shape (`geomKey`) was stored at, when an enclosing instance scaled the node afterwards */
  geomBox?: [number, number];
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
  private derivedC = new Map<string, DerivedRec[]>();
  private vars: VarLookup;
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
    this.qDef = db.prepare('SELECT owner, initial, parent FROM propdefs WHERE id=?');
    this.qDerived = db.prepare('SELECT p,w,h,x,y,geom,ns,sg FROM derived WHERE inst=?');
    const qVar = db.prepare('SELECT vals, collection FROM variables WHERE id=? OR guid=? LIMIT 1');
    this.vars = new VarLookup((id) => qVar.get(id, id) as { vals: string; collection: string } | undefined);
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
  // Definition ids are not unique in a document: the parent definition is the one declared by the nearest ancestor of the owner.
  private resolveInitial(initialJson: string | null, parent: string | null, owner: string, depth = 0): Val {
    const v = initialJson == null ? null : JSON.parse(initialJson);
    if (v !== null && v !== undefined) return v;
    if (parent && depth < 8) {
      const cands = this.qDef.all(parent) as { owner: string; initial: string | null; parent: string | null }[];
      let p = cands.length === 1 ? cands[0] : undefined;
      for (let o: NodeRec | undefined = this.node(owner), i = 0; !p && o && i < 40; o = o.parent_id ? this.node(o.parent_id) : undefined, i++) p = cands.find((c) => c.owner === o!.id);
      p ??= cands[0];
      if (p) return this.resolveInitial(p.initial, p.parent, p.owner, depth + 1);
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
        const v = this.resolveInitial(d.initial, d.parent, o);
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
    take('text', raw.refs.T, (v) => { if (typeof v !== 'string') return false; if (v !== out.text) out.styles = withoutRuns(out.styles); out.text = v; return true; });
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
    const tree = this.expand(root, new Map(), [], 0, 0);
    // explicit variable modes of the frames above the root apply to it as well (nearest wins, outer first)
    const inherited = this.ancestorModes(root);
    if (inherited.length) tree.modes = [...inherited, ...(tree.modes ?? [])];
    this.modeTexts(tree, []);
    return tree;
  }

  /** Text bound to a STRING variable shows its value under the nearest explicit mode of the variable's collection. */
  private modeTexts(v: VNode, inherited: string[]): void {
    const modes = v.modes ? [...inherited, ...v.modes] : inherited;
    if (modes.length && v.row.type === 'text' && v.row.styles?.includes('"text"')) {
      const ref = safeJson<Styles>(v.row.styles)?.vars?.text;
      const t = ref ? this.vars.string(ref, modes) : undefined;
      if (t !== undefined && t !== v.row.text) v.row = { ...v.row, text: t, styles: withoutRuns(v.row.styles) };
    }
    for (const k of v.kids) this.modeTexts(k, modes);
  }

  private ancestorModes(root: NodeRec): string[] {
    const chain: string[] = [];
    for (let p = root.parent_id ? this.node(root.parent_id) : undefined; p; p = p.parent_id ? this.node(p.parent_id) : undefined) {
      const vm = this.raw(p)?.vm as { s: string; m: string }[] | undefined;
      if (vm?.length) chain.unshift(...vm.map((e) => `${this.setNames.get(e.s) ?? e.s}=${this.modeNames.get(e.m) ?? e.m}`));
    }
    return chain;
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
    // a slot frame shows the content frame its SLOT_CONTENT_ID property names (expanded without the component's bindings)
    const slotDef = raw?.refs?.C as string | undefined;
    const slotB = slotDef ? bindings.get(slotDef) : undefined;
    const slotId = (slotB?.v as { slot?: string } | null | undefined)?.slot;
    if (slotB && slotId) slotB.used = true;
    const holder = slotId && this.node(slotId) ? slotId : src.id;
    if (holder !== src.id) scope = new Map();
    const children = this.kids(holder);
    if (depth >= this.opts.maxDepth) { if (children.length) node.truncated = children.length; return node; }
    const routed = this.route(holder, rest);
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
      if (o.t !== undefined || o.hidden || o.show || o.st || o.sz || o.vm || o.sp || o.rc || o.lo || o.vb) claims.push({ path, ov: o });
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
    // property claims of this owner, then the instance's uniform scale, then the saved layout cache; outer owners run after inner ones
    for (const c of claims) {
      const hit = this.resolveWithParent(node, c.path);
      if (hit) this.applyClaim(hit.node, c.ov, rank, hit.parent);
    }
    const usf = raw?.usf;
    if (typeof usf === 'number' && usf > 0 && usf !== 1) {
      // everything is scaled, then the instance record's own (placed-space) values are restored
      const own = { w: src.w, h: src.h, l: safeJson<Layout>(src.layout), s: safeJson<Styles>(src.styles) };
      scaleTree(node, usf);
      const r = { ...node.row, x: src.x, y: src.y, w: own.w, h: own.h };
      if (own.l && r.layout) {
        const l = safeJson<Layout>(r.layout) ?? {};
        for (const k of ['gap', 'pad', 'w', 'h'] as const) if (own.l[k] !== undefined) (l as Record<string, unknown>)[k] = own.l[k];
        r.layout = JSON.stringify(l);
      }
      if (own.s && r.styles) {
        const st = safeJson<Styles>(r.styles) ?? {};
        for (const k of ['r', 'fx', 'font', 'ow'] as const) if (own.s[k] !== undefined) (st as Record<string, unknown>)[k] = own.s[k];
        if (own.s.stroke && st.stroke) st.stroke = { ...st.stroke, w: own.s.stroke.w, dash: own.s.stroke.dash };
        r.styles = JSON.stringify(st);
      }
      node.row = r;
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
      const fromStroke = this.raw(target.row)?.geometryFrom === 'stroke';
      // saved outlines of this occurrence, already at its size; a stroke-only vector draws its saved stroke outline
      if (d.geom) { target.geomKey = d.geom; target.geomBox = undefined; }
      else if (fromStroke && d.sg) {
        target.geomKey = d.sg; target.geomBox = undefined;
        // (the saved outline already has the effective stroke weight `ow`; the renderer only widens outlines without a saved one)
      }
      if (d.ns && fromStroke && r.styles?.includes('"fill"')) { const st = safeJson<Styles>(r.styles) ?? {}; delete st.fill; target.row = { ...r, styles: JSON.stringify(st) }; }
      else if (d.ns && r.styles?.includes('"stroke"')) { const st = safeJson<Styles>(r.styles) ?? {}; delete st.stroke; target.row = { ...r, styles: JSON.stringify(st) }; }
    }
    return node;
  }

  private derivedOf(inst: string): DerivedRec[] {
    let d = this.derivedC.get(inst);
    if (!d) {
      d = (this.qDerived.all(inst) as (Omit<DerivedRec, 'p' | 'ps'> & { p: string })[]).map((r) => ({ ...r, ps: r.p, p: r.p.split('/') }));
      this.derivedC.set(inst, d);
    }
    return d;
  }

  /** Find the node a path addresses: instance boundaries are explicit segments, containers are searched through. */
  private resolve(root: VNode, path: string[]): VNode | undefined {
    return this.resolveWithParent(root, path)?.node;
  }
  private resolveWithParent(root: VNode, path: string[]): { node: VNode; parent?: VNode } | undefined {
    let cur = root;
    let parent: VNode | undefined;
    for (const [i, seg] of path.entries()) {
      if (i === 0) {
        const comp = cur.row.component_ref ? this.node(cur.row.component_ref) : undefined;
        const ok = comp && this.raw(comp)?.ok;
        if (seg === cur.row.component_ref || seg === ok) continue; // addresses the root itself
      }
      const found = this.findWithinBoundary(cur, seg);
      if (!found) return undefined;
      cur = found.node;
      parent = found.parent;
    }
    return { node: cur, parent };
  }
  private findWithinBoundary(v: VNode, seg: string): { node: VNode; parent: VNode } | undefined {
    for (const k of v.kids) {
      if (keyOf(k.row, this.raw(k.row)).includes(seg)) return { node: k, parent: v };
      if (!k.isInstance) { const f = this.findWithinBoundary(k, seg); if (f) return f; }
    }
    return undefined;
  }

  /** Applies one owner's override record to the addressed layer (absent fields inherit). */
  private applyClaim(t: VNode, o: Ov, ownerRank: number, parent?: VNode): void {
    const ranked = (field: string): boolean => { const r = t.assigned.get(field); return r === undefined || r >= ownerRank; };
    const row = { ...t.row };
    const raw = this.raw(t.row);
    const textApplies = o.t !== undefined && ranked('text');
    // new characters: the component's ranges indexed the old ones (the override brings its own ranges, if any, in st.runs)
    if (textApplies && o.t !== row.text) row.styles = withoutRuns(row.styles);
    if (textApplies) row.text = o.t!;
    if (o.hidden) { row.visible = 0; t.hidden = true; }
    if (o.show && ranked('visible')) { row.visible = 1; t.hidden = false; }
    if (o.st || o.sp || o.rc || o.vb) {
      let ov: Styles = o.st ?? {};
      // ranges belong to the override's characters: without them (outranked by a property value) they do not apply
      if (ov.runs && !textApplies) { const { runs: _r, ...rest } = ov; void _r; ov = rest; }
      // an override that detaches the fill style and brings no paints shows the layer's own paints (the style's values were a link)
      if (ov.sty?.fill === '' && !ov.fill) {
        const own = safeJson<Styles>(row.styles)?.ifill;
        if (own) ov = { ...ov, fill: own };
      }
      // a stroke-only vector draws its stroke outline as a fill: a stroke colour override recolours that fill
      if (raw?.geometryFrom === 'stroke' && ov.stroke) {
        const { stroke, ...rest } = ov;
        // an empty stroke list hides the outline (fill [] clears)
        ov = { ...rest, fill: stroke.paints };
      }
      const st = mergeStyles(safeJson<Styles>(row.styles) ?? {}, ov);
      if (o.sp && st.stroke && raw?.geometryFrom !== 'stroke') st.stroke = strokeWith(st.stroke, o.sp);
      // an outline icon whose stroke weight changes: its saved outline has the component's weight (the renderer widens it)
      if (o.sp && raw?.geometryFrom === 'stroke' && typeof o.sp.w === 'number') {
        if (Math.abs(o.sp.w - Number(raw.outlineW ?? o.sp.w)) > 1e-6) st.ow = o.sp.w; else delete st.ow;
      }
      if (o.rc && !['path', 'boolean', 'polygon'].includes(row.type)) {
        const r = radiusWith(st.r, o.rc);
        if (r === undefined) delete st.r; else st.r = r;
      }
      if (o.vb) {
        const vars: Record<string, string> = { ...st.vars };
        for (const [k, v] of Object.entries(o.vb)) { if (v) vars[k] = v; else delete vars[k]; }
        if (Object.keys(vars).length) st.vars = vars; else delete st.vars;
      }
      if (st.vars && !Object.keys(st.vars).length) delete st.vars;
      if (st.font) {
        // values an override stored without the font size (px line height, % tracking) are resolved against the target's size
        const s = typeof st.font.s === 'number' ? st.font.s : undefined;
        if (s && typeof st.font.lh === 'string' && st.font.lh.endsWith('px')) st.font.lh = Math.round((parseFloat(st.font.lh) / s) * 1000) / 1000;
        if (s && typeof st.font.ls === 'string' && st.font.ls.endsWith('%')) st.font.ls = Math.round(parseFloat(st.font.ls) * s) / 100;
        if (typeof st.font.lh === 'string' && st.font.lh.endsWith('%')) st.font.lh = pctLineHeight(st.font.lh, st.font.nlh);
      }
      row.styles = Object.keys(st).length ? JSON.stringify(st) : null;
    }
    if (o.lo) { const l = layoutWith(safeJson<Layout>(row.layout), o.lo, parent ? safeJson<Layout>(parent.row.layout)?.dir : undefined); row.layout = l ? JSON.stringify(l) : null; }
    if (o.sz) { row.w = o.sz.w; row.h = o.sz.h; }
    if (o.vm?.length) t.modes = [...(t.modes ?? []), ...o.vm.map((e) => `${this.setNames.get(e.s) ?? e.s}=${this.modeNames.get(e.m) ?? e.m}`)];
    // a text binding decides the content: a literal of a bound layer is retired (Figma shows the variable's value)
    if (row.type === 'text') {
      const v = safeJson<Styles>(row.styles)?.vars?.text;
      const s = v ? this.vars.string(v) : undefined;
      if (s !== undefined) { if (s !== row.text) row.styles = withoutRuns(row.styles); row.text = s; }
    }
    t.row = row;
  }
}

/** Styles JSON without text ranges (the characters they indexed were replaced). */
function withoutRuns(styles: string | null): string | null {
  if (!styles || !styles.includes('"runs"')) return styles;
  const st = safeJson<Styles>(styles) ?? {};
  delete st.runs;
  return Object.keys(st).length ? JSON.stringify(st) : null;
}

const rs = (v: number, f: number) => Math.round(v * f * 1000) / 1000;
/** Lengths of a styles record scaled by `f` (stroke, radius, dash, effects, font size/tracking, ranges). */
export function scaleStyles(st: Styles, f: number): Styles {
  const o: Styles = { ...st };
  if (o.stroke) {
    const w = o.stroke.w;
    o.stroke = { ...o.stroke, w: Array.isArray(w) ? w.map((x) => rs(x, f)) : typeof w === 'number' ? rs(w, f) : w, dash: o.stroke.dash?.map((x) => rs(x, f)) };
    if (!o.stroke.dash) delete o.stroke.dash;
  }
  if (o.r != null) o.r = Array.isArray(o.r) ? o.r.map((x) => rs(x, f)) : rs(o.r, f);
  if (o.fx) o.fx = o.fx.map((e) => ({ ...e, x: e.x != null ? rs(e.x, f) : e.x, y: e.y != null ? rs(e.y, f) : e.y, blur: e.blur != null ? rs(e.blur, f) : e.blur, spread: e.spread != null ? rs(e.spread, f) : e.spread }));
  const font = (x: Partial<NonNullable<Styles['font']>> | undefined) => {
    if (!x) return x;
    const y = { ...x };
    // Figma scales the unscaled pitch (saved, or round(natural × size)) with the instance
    const pitch = typeof y.lpx === 'number' ? y.lpx : typeof y.nlh === 'number' && typeof y.s === 'number' && y.lh == null ? Math.round(y.nlh * y.s) : undefined;
    if (pitch !== undefined) y.lpx = rs(pitch, f);
    if (typeof y.s === 'number') y.s = rs(y.s, f);
    if (typeof y.ls === 'number') y.ls = rs(y.ls, f);
    if (typeof y.lh === 'string' && y.lh.endsWith('px')) y.lh = `${rs(parseFloat(y.lh), f)}px`;
    return y;
  };
  if (o.font) o.font = font(o.font) as Styles['font'];
  if (o.runs) o.runs = o.runs.map((r) => (r.font ? { ...r, font: font(r.font) } : r));
  if (typeof o.ow === 'number') o.ow = rs(o.ow, f);
  return o;
}

/** Scales an occurrence and its content (instance uniformScaleFactor): positions, sizes, layout distances and style lengths. */
function scaleTree(v: VNode, f: number): void {
  const r = { ...v.row };
  if (v.geomKey && !v.geomBox && r.w != null && r.h != null) v.geomBox = [r.w, r.h];
  for (const k of ['x', 'y', 'w', 'h'] as const) if (r[k] != null) r[k] = Math.round((r[k] as number) * f * 1000) / 1000;
  if (r.styles || r.raw?.includes('"geometryFrom":"stroke"')) {
    const st = safeJson<Styles>(r.styles) ?? {};
    // an outline icon's stroke weight scales with it (raw.outlineW is the component's weight)
    if (st.ow === undefined && r.raw?.includes('"geometryFrom":"stroke"')) { const w = safeJson<{ outlineW?: number }>(r.raw)?.outlineW; if (typeof w === 'number') st.ow = w; }
    r.styles = JSON.stringify(scaleStyles(st, f));
  }
  if (r.layout) {
    const l = safeJson<Layout>(r.layout) ?? {};
    if (typeof l.gap === 'number') l.gap = rs(l.gap, f);
    if (l.pad) l.pad = l.pad.map((x) => rs(x, f));
    if (typeof l.w === 'number') l.w = rs(l.w, f);
    if (typeof l.h === 'number') l.h = rs(l.h, f);
    r.layout = JSON.stringify(l);
  }
  v.row = r;
  for (const k of v.kids) scaleTree(k, f);
}

interface DerivedRec { p: string[]; ps: string; w: number | null; h: number | null; x: number | null; y: number | null; geom: string | null; ns: number | null; sg: string | null }

/** Stroke width/alignment/dash override; per-side widths only with the independent flag (missing side = 0). */
function strokeWith(s: NonNullable<Styles['stroke']>, sp: NonNullable<Ov['sp']>): NonNullable<Styles['stroke']> {
  const out = { ...s };
  const curSides = Array.isArray(s.w) ? s.w : undefined;
  const uniform = typeof sp.w === 'number' ? sp.w : typeof s.w === 'number' ? s.w : undefined;
  const ind = sp.bw?.ind ?? !!curSides;
  if (ind && (sp.bw || curSides)) {
    const base = curSides ?? [uniform ?? 0, uniform ?? 0, uniform ?? 0, uniform ?? 0];
    out.w = [sp.bw?.t ?? base[0], sp.bw?.r ?? base[1], sp.bw?.b ?? base[2], sp.bw?.l ?? base[3]];
  } else out.w = uniform;
  if (sp.align) out.align = sp.align;
  if (sp.dash !== undefined) { if (sp.dash) out.dash = sp.dash; else delete out.dash; }
  return out;
}

/** Corner override (Figma rule: independent flag -> per-corner fields with absent = 0, otherwise cornerRadius). */
function radiusWith(cur: Styles['r'], rc: NonNullable<Ov['rc']>): number | number[] | undefined {
  const arr = Array.isArray(cur) ? cur : undefined;
  const uni = typeof cur === 'number' ? cur : 0;
  const ind = rc.ind ?? !!arr;
  let r: number | number[];
  if (ind) {
    const base = arr ?? [rc.cr ?? uni, rc.cr ?? uni, rc.cr ?? uni, rc.cr ?? uni];
    r = [rc.tl ?? base[0], rc.tr ?? base[1], rc.br ?? base[2], rc.bl ?? base[3]];
    if (new Set(r).size === 1) r = r[0];
  } else r = rc.cr ?? (arr ? Math.max(...arr) : uni);
  return (Array.isArray(r) ? r.some((x) => x > 0) : r > 0) ? r : undefined;
}

/** Auto-layout / text-resize override fields (Figma NodeChange names) applied to a layout rule; `parentDir` decides fill axes. */
export function layoutWith(cur: Layout | null, lo: Record<string, unknown>, parentDir?: string): Layout | null {
  const l: Layout = { ...cur };
  const mode = lo.stackMode as string | undefined;
  if (mode === 'NONE') { for (const k of ['dir', 'gap', 'pad', 'jc', 'ai', 'wrap'] as const) delete l[k]; }
  else if (mode === 'HORIZONTAL') l.dir = 'row';
  else if (mode === 'VERTICAL') l.dir = 'col';
  else if (mode === 'GRID') l.dir = 'grid';
  const set = (axis: 'w' | 'h', hug: boolean) => { if (hug) { if (l[axis] !== 'fill') l[axis] = 'hug'; } else if (l[axis] === 'hug') delete l[axis]; };
  const row = l.dir === 'row';
  if (l.dir === 'row' || l.dir === 'col') {
    if (lo.stackPrimarySizing !== undefined) set(row ? 'w' : 'h', String(lo.stackPrimarySizing).startsWith('RESIZE_TO_FIT'));
    if (lo.stackCounterSizing !== undefined) set(row ? 'h' : 'w', String(lo.stackCounterSizing).startsWith('RESIZE_TO_FIT'));
  }
  if (lo.stackPositioning !== undefined) { if (lo.stackPositioning === 'ABSOLUTE') l.abs = true; else delete l.abs; }
  if (parentDir === 'row' || parentDir === 'col') {
    const main = parentDir === 'row' ? 'w' : 'h', cross = parentDir === 'row' ? 'h' : 'w';
    if (typeof lo.stackChildPrimaryGrow === 'number') { if (lo.stackChildPrimaryGrow > 0) l[main] = 'fill'; else if (l[main] === 'fill') delete l[main]; }
    if (lo.stackChildAlignSelf !== undefined) { if (lo.stackChildAlignSelf === 'STRETCH') l[cross] = 'fill'; else if (l[cross] === 'fill') delete l[cross]; }
  }
  if (typeof lo.stackSpacing === 'number') { if (lo.stackSpacing) l.gap = Math.round(lo.stackSpacing * 100) / 100; else delete l.gap; }
  const pads: [string, number][] = [['stackVerticalPadding', 0], ['stackPaddingRight', 1], ['stackPaddingBottom', 2], ['stackHorizontalPadding', 3]];
  if (pads.some(([f]) => typeof lo[f] === 'number')) {
    const p = [...(l.pad ?? [0, 0, 0, 0])];
    for (const [f, i] of pads) if (typeof lo[f] === 'number') p[i] = Math.round((lo[f] as number) * 100) / 100;
    if (p.some((x) => x)) l.pad = p; else delete l.pad;
  }
  if (lo.stackPrimaryAlignItems !== undefined) { const jc = JC[String(lo.stackPrimaryAlignItems)]; if (jc) l.jc = jc; else delete l.jc; }
  if (l.jc === 'between' || l.jc === 'around' || l.jc === 'evenly') delete l.gap;
  if (lo.stackCounterAlignItems !== undefined) { const ai = AI[String(lo.stackCounterAlignItems)]; if (ai) l.ai = ai; else delete l.ai; }
  if (lo.stackWrap !== undefined) { if (lo.stackWrap === 'WRAP') l.wrap = true; else delete l.wrap; }
  const tar = lo.textAutoResize;
  if (tar === 'WIDTH_AND_HEIGHT') { set('w', true); set('h', true); }
  else if (tar === 'HEIGHT') { set('w', false); set('h', true); }
  else if (tar === 'NONE') { set('w', false); set('h', false); }
  return Object.keys(l).length ? l : null;
}
