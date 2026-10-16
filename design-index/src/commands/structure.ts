import type { DatabaseSync } from '../sqlite.js';
import path from 'node:path';
import type { Layout, Styles } from '../model.js';
import { layoutStr, Out, q, safeJson, sizeStr, stylesStr } from '../output.js';
import { getMeta } from '../db.js';
import { fmtBytes } from '../util.js';
import { TokenIndex } from '../tokens.js';

export interface NodeRec {
  id: string; parent_id: string | null; page: number; type: string; name: string; depth: number; ord: number;
  x: number | null; y: number | null; w: number | null; h: number | null; layout: string | null; styles: string | null;
  text: string | null; component_ref: string | null; visible: number; raw: string | null; nchild: number; stext?: string | null;
}

const compCache = new WeakMap<DatabaseSync, Map<string, string>>();
const tokCache = new WeakMap<DatabaseSync, TokenIndex>();
/** token display name for a bound variable id (cached per database) */
export function nameOfFor(db: DatabaseSync): (v: string) => string {
  let t = tokCache.get(db);
  if (!t) { t = new TokenIndex(db); tokCache.set(db, t); }
  const ti = t;
  return (v) => ti.nameFor(v);
}

/** "Button[State=Hover,Size=L]" for variants, plain name otherwise. */
export function compLabel(db: DatabaseSync, id: string | null): string {
  if (!id) return '';
  let m = compCache.get(db);
  if (!m) { m = new Map(); compCache.set(db, m); }
  const hit = m.get(id);
  if (hit !== undefined) return hit;
  const r = db.prepare('SELECT name,set_name,variant FROM components WHERE id=?').get(id) as { name: string; set_name: string | null; variant: string | null } | undefined;
  let label = id;
  if (r) {
    const v = safeJson<Record<string, string>>(r.variant);
    label = r.set_name && v ? `${r.set_name}[${Object.entries(v).map(([k, x]) => `${k}=${x}`).join(',')}]` : r.set_name ? `${r.set_name}/${r.name}` : r.name;
  }
  m.set(id, label);
  return label;
}

export function nodeLine(db: DatabaseSync, n: NodeRec, withStyle = true): string {
  const l = safeJson<Layout>(n.layout);
  const s = safeJson<Styles>(n.styles);
  const parts = [n.id, n.type];
  if (!(n.text && n.name === n.text) && !(n.text && n.text.startsWith(n.name.replace(/…$/, '')) && n.name.length >= 20)) parts.push(q(n.name, 50));
  const sz = sizeStr(n.w, n.h, l);
  if (sz) parts.push(sz);
  const ls = layoutStr(l);
  if (ls) parts.push(ls);
  if (n.component_ref) parts.push(`→${compLabel(db, n.component_ref)}`);
  if (n.text) parts.push(`text=${q(n.text, 50)}`);
  if (withStyle) { const st = stylesStr(s, { isText: n.type === 'text', nameOf: nameOfFor(db) }); if (st) parts.push(st); }
  if (!n.visible) parts.push('(hidden)');
  return parts.join(' ');
}

const COLS = 'id,parent_id,page,type,name,depth,ord,x,y,w,h,layout,styles,text,component_ref,visible,raw,nchild,stext';

export function getNode(db: DatabaseSync, id: string): NodeRec | undefined {
  return db.prepare(`SELECT ${COLS} FROM nodes WHERE id=?`).get(id) as NodeRec | undefined;
}

export function requireNode(db: DatabaseSync, id: string): NodeRec {
  const n = getNode(db, id);
  if (n) return n;
  const alt = db.prepare(`SELECT id,name FROM nodes WHERE id LIKE ? LIMIT 3`).all(id + '%') as { id: string; name: string }[];
  throw new Error(`Node "${id}" not found.` + (alt.length ? ` Did you mean: ${alt.map((a) => `${a.id} ${q(a.name, 30)}`).join(', ')}?` : ' Try: design-query search <text>'));
}

export function children(db: DatabaseSync, id: string, limit = 1e9): NodeRec[] {
  return db.prepare(`SELECT ${COLS} FROM nodes WHERE parent_id=? ORDER BY ord LIMIT ?`).all(id, limit) as unknown as NodeRec[];
}

export function ancestors(db: DatabaseSync, id: string): NodeRec[] {
  const out: NodeRec[] = [];
  let cur = getNode(db, id);
  while (cur?.parent_id) { cur = getNode(db, cur.parent_id); if (cur) out.unshift(cur); }
  return out;
}

// ---- overview -----------------------------------------------------------------------------------
export function overview(db: DatabaseSync, out: Out, page?: number): void {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const fmt = getMeta(db, 'format');
  const src = path.basename(getMeta(db, 'source') ?? '?');
  out.head(`# ${src} · ${fmt} · ${fmtBytes(Number(getMeta(db, 'source_size') ?? 0))} · ${getMeta(db, 'node_count')} nodes`);

  if (page == null) {
    const nComp = count('SELECT COUNT(*) c FROM components');
    const nVar = count('SELECT COUNT(*) c FROM variables');
    const nAsset = count('SELECT COUNT(*) c FROM assets');
    const nInter = count('SELECT COUNT(*) c FROM interactions');
    const nScreens = count('SELECT COUNT(*) c FROM screens');
    const colls = db.prepare(`SELECT collection, COUNT(*) c FROM variables GROUP BY collection ORDER BY c DESC LIMIT 8`).all() as { collection: string; c: number }[];
    out.head(`Components: ${nComp} · Tokens: ${nVar}${colls.length ? ` (${colls.map((c) => `${c.collection || '-'}:${c.c}`).join(', ')})` : ''} · Assets: ${nAsset} · Interactions: ${nInter} · Screens: ${nScreens}`);
    const themes = getMeta(db, 'themes');
    if (themes) out.head(`Themes: ${themes.slice(0, 160)}`);
  }

  const pages = (page != null
    ? db.prepare('SELECT idx,id,name,node_count,screen_count FROM pages WHERE idx=?').all(page)
    : db.prepare('SELECT idx,id,name,node_count,screen_count FROM pages ORDER BY idx').all()) as { idx: number; id: string; name: string; node_count: number; screen_count: number }[];
  if (page != null && !pages.length) throw new Error(`Page ${page} does not exist (1..${count('SELECT MAX(idx) c FROM pages')}).`);

  for (const p of pages) {
    out.add(`P${p.idx} ${q(p.name, 50)} id=${p.id} · ${p.node_count} nodes · ${p.screen_count} screens`, { page: p.idx, id: p.id, name: p.name, nodes: p.node_count, screens: p.screen_count });
    const kids = db.prepare(page != null
      ? `SELECT ${COLS} FROM nodes WHERE page=? AND depth=1 ORDER BY ord`
      : `SELECT ${COLS} FROM nodes WHERE page=? AND depth=0 ORDER BY ord`).all(p.idx) as unknown as NodeRec[];
    const cap = page != null ? 60 : 0;
    let shown = 0;
    for (const k of kids) {
      if (shown >= cap || !out.add(`  ${k.id} ${k.type} ${q(k.name, 40)} ${sizeStr(k.w, k.h, safeJson(k.layout))} (${k.nchild} children)`)) break;
      shown++;
    }
    if (kids.length > shown && page != null) out.add(`  … ${kids.length - shown} weitere`);
  }
  if (page == null) {
    out.hint('`overview --page N` lists the top-level frames of a page; `summary` and `screens` give the overall picture.');
  } else out.hint('`tree <id> --depth 2` shows the content of a frame.');
}

// ---- tree ---------------------------------------------------------------------------------------
export function tree(db: DatabaseSync, out: Out, id: string, depth: number, maxKids: number): void {
  const root = requireNode(db, id);
  const anc = ancestors(db, id).map((a) => `${a.name || a.type}(${a.id})`);
  if (anc.length) out.head(`# Path: ${anc.join(' › ')}`);
  let cut = 0;
  const walk = (n: NodeRec, d: number): void => {
    if (!out.add('  '.repeat(d) + nodeLine(db, n))) return;
    if (!n.nchild) return;
    if (d >= depth) { out.add('  '.repeat(d + 1) + `… ${n.nchild} children (tree ${n.id} --depth ${depth + 1})`); return; }
    const kids = children(db, n.id, maxKids);
    for (const k of kids) { if (out.full) { cut++; break; } walk(k, d + 1); }
    if (n.nchild > kids.length) out.add('  '.repeat(d + 1) + `… ${n.nchild - kids.length} more children of ${n.id} (--max-children ${n.nchild})`);
  };
  walk(root, 0);
  if (out.skipped || cut) out.hint(`Truncated: pick a smaller subtree, e.g. \`tree <child-id> --depth 2\`, or \`spec <child-id>\`.`);
}

// ---- search -------------------------------------------------------------------------------------
const TYPE_ALIASES: Record<string, string[]> = {
  frame: ['frame', 'group', 'section'], text: ['text'], component: ['component'], instance: ['instance'],
  rect: ['rect'], icon: ['icon'], path: ['path', 'line'], note: ['note'],
};

export function search(db: DatabaseSync, out: Out, text: string, type: string | undefined, limit: number): void {
  const terms = text.split(/[\s]+/).map((t) => t.replace(/["*]/g, '')).filter(Boolean);
  if (!terms.length) throw new Error('Search text is empty.');
  const match = terms.map((t) => `"${t}"*`).join(' AND ');
  const types = type ? TYPE_ALIASES[type] ?? [type] : null;
  let rows: NodeRec[] = [];
  try {
    rows = db.prepare(
      `SELECT ${COLS.split(',').map((c) => 'n.' + c).join(',')} FROM nodes_fts f JOIN nodes n ON n.rowid=f.rowid
       WHERE nodes_fts MATCH ? ${types ? `AND n.type IN (${types.map(() => '?').join(',')})` : ''} ORDER BY rank LIMIT ?`,
    ).all(match, ...(types ?? []), limit + 1) as unknown as NodeRec[];
  } catch { rows = []; }
  if (!rows.length) {
    const like = `%${text}%`;
    rows = db.prepare(`SELECT ${COLS} FROM nodes WHERE (name LIKE ? OR text LIKE ?) ${types ? `AND type IN (${types.map(() => '?').join(',')})` : ''} LIMIT ?`)
      .all(like, like, ...(types ?? []), limit + 1) as unknown as NodeRec[];
  }
  out.head(`# ${Math.min(rows.length, limit)}${rows.length > limit ? '+' : ''} matches for "${text}"${type ? ` (${type})` : ''}`);
  for (const r of rows.slice(0, limit)) {
    const par = r.parent_id ? (db.prepare('SELECT name FROM nodes WHERE id=?').get(r.parent_id) as { name: string } | undefined)?.name : '';
    out.add(`${nodeLine(db, r, false)}${r.stext ? ` [instance texts: ${q(r.stext, 90)}]` : ''}  [P${r.page}${par ? ' in ' + q(par, 30) : ''}]`, { id: r.id, type: r.type, name: r.name, page: r.page, text: r.text });
  }
  if (rows.length > limit) out.hint(`More matches: --limit ${limit * 2}; or narrow down with --type.`);
  if (!rows.length) out.hint('No matches. Try another spelling or browse `screens`.');
  else out.hint('`tree <id> --depth 2` or `spec <id>` for details.');
}

// ---- node ---------------------------------------------------------------------------------------
export function nodeDetail(db: DatabaseSync, out: Out, id: string): void {
  const n = requireNode(db, id);
  const anc = ancestors(db, id).map((a) => `${a.name || a.type}(${a.id})`);
  out.head(`${n.id} ${n.type} ${q(n.name, 80)} page=${n.page} depth=${n.depth} ord=${n.ord}${n.visible ? '' : ' HIDDEN'}`);
  if (anc.length) out.add(`path: ${anc.join(' › ')}`);
  out.add(`bbox: x=${n.x ?? '?'} y=${n.y ?? '?'} w=${n.w ?? '?'} h=${n.h ?? '?'}  children: ${n.nchild}`);
  const l = safeJson<Layout>(n.layout);
  if (l) out.add(`layout: ${layoutStr(l) || '-'}  size: ${sizeStr(n.w, n.h, l) || '-'}`);
  const s = safeJson<Styles>(n.styles);
  if (s) out.add(`styles: ${stylesStr(s, { isText: n.type === 'text', nameOf: nameOfFor(db) })}`);
  if (n.text) out.add(`text: ${JSON.stringify(n.text.length > 600 ? n.text.slice(0, 600) + '…' : n.text)}`);
  if (n.component_ref) out.add(`instance of: ${compLabel(db, n.component_ref)} (${n.component_ref})`);
  const comp = db.prepare('SELECT * FROM components WHERE id=?').get(id) as { description: string; variant: string; props: string; instances: number } | undefined;
  if (comp) out.add(`component: ${comp.instances} instances${comp.description ? ` · ${q(comp.description, 160)}` : ''}${comp.variant ? ` · variant ${comp.variant}` : ''}${comp.props ? ` · props ${comp.props.slice(0, 300)}` : ''}`);
  const raw = safeJson<Record<string, unknown>>(n.raw);
  if (raw) out.add(`raw: ${JSON.stringify(raw).slice(0, 700)}`);
  const inter = db.prepare('SELECT trigger,action,target_id,detail FROM interactions WHERE node_id=?').all(id) as { trigger: string; action: string; target_id: string | null; detail: string | null }[];
  for (const i of inter.slice(0, 8)) out.add(`interaction: ${i.trigger} → ${i.action}${i.target_id ? ' ' + i.target_id : ''}${i.detail ? ' ' + i.detail : ''}`);
  const notes = db.prepare('SELECT kind,text FROM notes WHERE node_id=?').all(id) as { kind: string; text: string }[];
  for (const t of notes.slice(0, 5)) out.add(`note(${t.kind}): ${q(t.text, 300)}`);
  const g = db.prepare('SELECT length(data) len FROM geometry WHERE node_id=?').get(id) as { len: number } | undefined;
  if (g) out.add(`vector geometry: ${g.len} chars (assets export ${id})`);
  out.hint(n.nchild ? `\`tree ${id} --depth 2\` for children, \`spec ${id}\` for the implementation spec.` : `\`spec ${id}\` for the spec.`);
}
