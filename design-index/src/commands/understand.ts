// Commands for the understanding mode (grill-me). Everything inferred is labelled "derived".
import path from 'node:path';
import type { DatabaseSync } from '../sqlite.js';
import { getMeta } from '../db.js';
import { P3_NOTE } from './spec.js';
import { Out, q, safeJson } from '../output.js';
import { fmtBytes } from '../util.js';
import { loadTokens, modesOf } from '../tokens.js';
import { requireNode } from './structure.js';

interface Screen { node_id: string; page: number; name: string; w: number | null; h: number | null; ord: number; purpose: string; group_key: string; state_hint: string | null; device: string; texts: string; n_nodes: number; board_name: string }

const one = <T>(db: DatabaseSync, sql: string, ...a: any[]): T => db.prepare(sql).get(...a) as T;
const purposeLabel = (p: string) => p.split(' ← ')[0];

function guessLanguage(db: DatabaseSync): string {
  const rows = db.prepare(`SELECT text FROM nodes WHERE type='text' AND text IS NOT NULL AND length(text) BETWEEN 12 AND 200 LIMIT 1500`).all() as { text: string }[];
  const de = /\b(und|der|die|das|nicht|mit|für|ein|eine|ist|zu|von|sie|Ihre|Bestellung|Service|bitte)\b/gi;
  const en = /\b(and|the|of|to|for|with|your|you|is|are|please|order|this|that|from|not)\b/gi;
  let d = 0, e = 0;
  for (const r of rows) { d += (r.text.match(de) ?? []).length; e += (r.text.match(en) ?? []).length; }
  if (d + e < 5) return 'not detectable';
  return d > e * 1.5 ? 'mostly German' : e > d * 1.5 ? 'mostly English' : 'mixed German/English';
}

export function summary(db: DatabaseSync, out: Out): void {
  const fmt = getMeta(db, 'format');
  const count = (sql: string) => one<{ c: number }>(db, sql).c;
  const nScreens = count('SELECT COUNT(*) c FROM screens');
  const nPages = count('SELECT COUNT(*) c FROM pages');
  out.head(`# Summary · ${path.basename(getMeta(db, 'source') ?? '')} (${fmt}, ${fmtBytes(Number(getMeta(db, 'source_size') ?? 0))}, ${getMeta(db, 'node_count')} nodes)`);
  out.head('Note: statements marked "derived" or "~" are heuristics from names/structure and must be confirmed by the user.');
  if (getMeta(db, 'color_profile') === 'DISPLAY_P3') out.head(`Note: ${P3_NOTE}.`);

  // 1. structure
  const boards = db.prepare(`SELECT board_name, COUNT(*) c, MIN(node_id) first FROM screens GROUP BY board_name ORDER BY MIN(ord)`).all() as { board_name: string; c: number; first: string }[];
  out.add(`1. Structure: ${nPages} ${fmt === 'fig' ? 'pages (canvases)' : 'top-level frames (.pen has no pages)'}, ${nScreens} detected screens in ${boards.length} areas (derived: screen = frame of viewport size, area = surrounding board/section).`);
  for (const b of boards.slice(0, 14)) out.add(`   - ${q(b.board_name || '(no board)', 50)}: ${b.c} screen(s), e.g. ${b.first}`);
  if (boards.length > 14) out.add(`   … ${boards.length - 14} more areas (\`screens\`)`);

  // 2. screen types
  const purposes = new Map<string, number>();
  for (const s of db.prepare('SELECT purpose FROM screens').all() as { purpose: string }[]) purposes.set(purposeLabel(s.purpose), (purposes.get(purposeLabel(s.purpose)) ?? 0) + 1);
  if (purposes.size) out.add(`2. Screen types (derived): ${[...purposes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ')}`);

  // 3. components
  const nc = count('SELECT COUNT(*) c FROM components');
  if (nc) {
    const sets = count('SELECT COUNT(DISTINCT COALESCE(set_id, id)) c FROM components');
    const top = db.prepare(`SELECT COALESCE(set_name,name) n, SUM(instances) i FROM components GROUP BY COALESCE(set_id,id) ORDER BY i DESC LIMIT 6`).all() as { n: string; i: number }[];
    out.add(`3. Component library: ${nc} components in ${sets} sets/single components. Most used: ${top.map((t) => `${t.n} (${t.i}×)`).join(', ')}`);
    const unused = count('SELECT COUNT(*) c FROM components WHERE instances=0');
    if (unused) out.add(`   ${unused} components without an instance in the file.`);
  } else out.add('3. Component library: no reusable components in the file (everything drawn directly).');

  // 4. tokens
  const tokens = loadTokens(db);
  if (tokens.length) {
    const colls = new Map<string, number>();
    for (const t of tokens) colls.set(t.collection || '-', (colls.get(t.collection || '-') ?? 0) + 1);
    const modes = modesOf(tokens);
    out.add(`4. Token system: ${tokens.length} variables (${[...colls].slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(', ')}); themes/modes: ${modes.slice(0, 10).join(', ') || 'none'}${modes.length > 10 ? ` (+${modes.length - 10} more)` : ''}`);
  } else {
    const u = (k: string) => one<{ c: number }>(db, 'SELECT COUNT(*) c FROM usage WHERE kind=?', k).c;
    out.add(`4. Token system: none defined. Used directly: ${u('color')} colors, ${u('fontSize')} font sizes, ${u('font')} font famil(ies) [${(db.prepare("SELECT value FROM usage WHERE kind='font' ORDER BY n DESC LIMIT 3").all() as { value: string }[]).map((x) => x.value).join(', ')}], ${u('gap') + u('pad')} spacing values.`);
  }

  // 5. breakpoints / variants
  const dev = db.prepare(`SELECT device, COUNT(*) c, MIN(w) mn, MAX(w) mx FROM screens GROUP BY device`).all() as { device: string; c: number; mn: number; mx: number }[];
  if (dev.length) out.add(`5. Widths (derived): ${dev.map((d) => `${d.device} ×${d.c} (${d.mn === d.mx ? d.mn : d.mn + '–' + d.mx}px)`).join(', ')}`);
  const multi = one<{ c: number }>(db, 'SELECT COUNT(*) c FROM (SELECT group_key FROM screens GROUP BY group_key HAVING COUNT(*) > 1)').c;
  if (multi) {
    const gs = db.prepare(`SELECT group_key, COUNT(*) c FROM screens GROUP BY group_key HAVING c > 1 ORDER BY c DESC LIMIT 4`).all() as { group_key: string; c: number }[];
    out.add(`   State variants (derived from names): ${multi} screen groups with several variants, e.g. ${gs.map((g) => `${q(g.group_key, 30)}×${g.c}`).join(', ')}`);
  }

  // 6. language, interactions, notes, audit
  out.add(`6. Language (derived): ${guessLanguage(db)}`);
  const ni = count('SELECT COUNT(*) c FROM interactions');
  const nav = count("SELECT COUNT(*) c FROM interactions WHERE action NOT IN ('SWAP_STATE','NONE')");
  const edges = count('SELECT COUNT(*) c FROM edges');
  out.add(`7. Flows: ${ni ? `${ni} prototype interactions, of which ${nav} navigation/overlay/scroll and ${ni - nav} state swaps inside components (facts); ${edges} screen→screen connections (see \`flows\`)` : 'no prototype connections; flows can only be derived from naming'}. Notes/dev notes: ${count('SELECT COUNT(*) c FROM notes')}`);
  const f = db.prepare('SELECT severity s, COUNT(*) c FROM findings GROUP BY severity ORDER BY severity DESC').all() as { s: number; c: number }[];
  out.add(`8. Audit: ${f.length ? f.map((x) => `${x.c}× severity ${x.s}`).join(', ') : 'no findings'} → \`audit\`, \`notes\``);
  const w = db.prepare('SELECT msg, n FROM warnings ORDER BY n DESC LIMIT 3').all() as { msg: string; n: number }[];
  if (w.length) out.add(`   Parser warnings: ${w.map((x) => `${x.msg} (${x.n}×)`).join('; ')}`);
  out.hint('Next steps of the grill-me session: `screens`, `flows`, then `audit` and `notes`.');
}

export function screensCmd(db: DatabaseSync, out: Out, page?: number): void {
  const rows = (page != null
    ? db.prepare('SELECT * FROM screens WHERE page=? ORDER BY ord').all(page)
    : db.prepare('SELECT * FROM screens ORDER BY ord').all()) as unknown as Screen[];
  out.head(`# ${rows.length} screens${page != null ? ` on page ${page}` : ''} · purpose/state/device are derived (~) from name, heading, structure`);
  let lastBoard: string | undefined;
  let lastPage = -1;
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    if (s.page !== lastPage || s.board_name !== lastBoard) {
      lastPage = s.page; lastBoard = s.board_name;
      if (!out.add(`P${s.page} ${q(s.board_name || '(top level)', 50)}`)) { out.skip(rows.length - i - 1); break; }
    }
    const texts = safeJson<string[]>(s.texts) ?? [];
    const sibs = one<{ c: number }>(db, 'SELECT COUNT(*) c FROM screens WHERE group_key=?', s.group_key).c;
    const ok = out.add(`  ${s.node_id} ${q(s.name, 44)} ${s.w ?? '?'}×${s.h ?? '?'} ${s.device} · ~${purposeLabel(s.purpose)}${s.state_hint ? ` · ~state: ${s.state_hint.slice(0, 40)}` : ''}${sibs > 1 ? ` · group×${sibs}` : ''}${texts.length ? ` · texts: ${texts.slice(0, 3).map((t) => `„${t.slice(0, 22)}“`).join(' ')}` : ''}`,
      { id: s.node_id, name: s.name, page: s.page, board: s.board_name, w: s.w, h: s.h, device: s.device, purpose: purposeLabel(s.purpose), purposeBasis: s.purpose.split(' ← ')[1], state: s.state_hint, derived: true });
    if (!ok) { out.skip(rows.length - i - 1); break; }
  }
  if (!rows.length) out.add('No screens detected (no frames of viewport size). Use `overview` and `tree` to inspect manually.');
  out.hint(page == null ? '`screens --page N` for one page; `states <id>` for the states of a screen; `spec <id>` to implement.' : '`spec <id>` or `screenshot <id>` for a screen.');
}

export function flows(db: DatabaseSync, out: Out): void {
  const edges = db.prepare('SELECT src,dst,trigger,action FROM edges').all() as { src: string; dst: string; trigger: string; action: string }[];
  const name = (id: string) => (one<{ name: string } | undefined>(db, 'SELECT name FROM nodes WHERE id=?', id)?.name) ?? id;
  if (edges.length) {
    out.head(`# Prototype connections (facts from the file): ${edges.length} screen→screen`);
    const bySrc = new Map<string, typeof edges>();
    for (const e of edges) (bySrc.get(e.src) ?? bySrc.set(e.src, []).get(e.src)!).push(e);
    for (const [src, list] of bySrc) {
      if (!out.add(`${src} ${q(name(src), 36)} → ${list.map((e) => `${e.dst} ${q(name(e.dst), 28)} [${e.trigger.toLowerCase()}${e.action ? '/' + e.action.toLowerCase() : ''}]`).join('; ')}`)) break;
    }
  } else {
    const ni = one<{ c: number }>(db, 'SELECT COUNT(*) c FROM interactions').c;
    const nav = one<{ c: number }>(db, "SELECT COUNT(*) c FROM interactions WHERE action NOT IN ('SWAP_STATE','NONE')").c;
    out.head(ni ? `# No screen→screen connections in the prototype (${ni} interactions, ${nav} of them navigation but without a screen as source and target; the rest are state swaps inside components).` : '# No prototype connections in the file.');
  }

  // derived: numbered boards "04 – Service bestellen - Service finden"
  const boards = db.prepare('SELECT board_name, MIN(node_id) first, COUNT(*) c, MIN(page) page FROM screens GROUP BY board_name ORDER BY MIN(ord)').all() as { board_name: string; first: string; c: number; page: number }[];
  const flowsMap = new Map<string, { n: number; step: string; id: string; c: number }[]>();
  const seen = new Set<string>();
  let dupBoards = 0;
  for (const b of boards) {
    const m = /^\s*(\d+)\s*[–\-.:]\s*(.+)$/.exec(b.board_name ?? '');
    if (!m) continue;
    if (seen.has(b.board_name)) { dupBoards++; continue; }
    seen.add(b.board_name);
    const parts = m[2].split(/\s+[–\-]\s+/);
    const flow = parts.length > 1 ? parts[0] : m[2];
    const step = parts.length > 1 ? parts.slice(1).join(' - ') : m[2];
    (flowsMap.get(flow) ?? flowsMap.set(flow, []).get(flow)!).push({ n: Number(m[1]), step, id: b.first, c: b.c });
  }
  if (flowsMap.size) {
    out.add('');
    out.add('[derived] Flows from numbering/naming of the boards (no prototype data, please confirm):');
    for (const [flow, steps] of [...flowsMap].sort((a, b) => a[1][0].n - b[1][0].n)) {
      out.add(`  Flow ${q(flow, 40)}: ${steps.sort((a, b) => a.n - b.n).map((s) => `${String(s.n).padStart(2, '0')} ${s.step.slice(0, 34)} (${s.id}${s.c > 1 ? `, ${s.c} screens` : ''})`).join(' → ')}`);
    }
    if (dupBoards) out.add(`  Note: ${dupBoards} board name(s) occur several times in the file (see \`audit\`, duplicates).`);
  }
  // derived: step sequences inside a board
  const seqs = db.prepare(`SELECT board_name, GROUP_CONCAT(node_id || ' ' || name, ' → ') s, COUNT(*) c FROM (SELECT * FROM screens ORDER BY ord) WHERE name GLOB '*[Ss]chritt [0-9]*' OR name GLOB '*[Ss]tep [0-9]*' GROUP BY board_name HAVING c >= 2`).all() as { board_name: string; s: string; c: number }[];
  for (const sq of seqs) out.add(`  [derived] Step sequence in ${q(sq.board_name, 36)}: ${sq.s.slice(0, 300)}`);
  if (!edges.length && !flowsMap.size && !seqs.length) out.add('No derivable flows: order and linking of the screens is open and should be asked.');
  out.hint('Always ask flow questions with screen IDs; record answers in design-decisions.md.');
}

const STATE_SQL = ['hover', 'focus', 'active', 'pressed', 'disabled', 'inaktiv', 'error', 'fehler', 'empty', 'leer', 'loading', 'lade', 'success', 'erfolg', 'selected', 'ausgewählt', 'expanded', 'collapsed', 'skeleton', 'invalid', 'checked', 'readonly', 'warning', 'warnung'];

export function states(db: DatabaseSync, out: Out, id: string): void {
  const node = requireNode(db, id);
  const scr = one<Screen | undefined>(db, 'SELECT * FROM screens WHERE node_id=?', id);
  out.head(`# States for ${node.id} ${q(node.name, 50)} (${node.type})`);
  const comp = one<{ id: string; set_id: string | null; set_name: string | null } | undefined>(db, 'SELECT id,set_id,set_name FROM components WHERE id=? OR set_id=? LIMIT 1', id, id)
    ?? (node.component_ref ? one<{ id: string; set_id: string | null; set_name: string | null } | undefined>(db, 'SELECT id,set_id,set_name FROM components WHERE id=?', node.component_ref) : undefined);
  if (comp) {
    const variants = (comp.set_id
      ? db.prepare('SELECT id,name,variant,instances FROM components WHERE set_id=?').all(comp.set_id)
      : db.prepare('SELECT id,name,variant,instances FROM components WHERE id=?').all(comp.id)) as { id: string; name: string; variant: string | null; instances: number }[];
    out.add(`Component ${q(comp.set_name ?? variants[0]?.name ?? '', 40)}: ${variants.length} variant(s)`);
    const axes = new Map<string, Set<string>>();
    for (const v of variants) for (const [k, x] of Object.entries(safeJson<Record<string, string>>(v.variant) ?? {})) (axes.get(k) ?? axes.set(k, new Set()).get(k)!).add(x);
    for (const [k, v] of axes) out.add(`  Axis ${k}: ${[...v].join(' | ')}`);
    for (const v of variants.slice(0, 40)) if (!out.add(`  ${v.id} ${v.variant ? Object.entries(safeJson<Record<string, string>>(v.variant) ?? {}).map(([k, x]) => `${k}=${x}`).join(', ') : q(v.name)} · ${v.instances}× used`)) break;
    const stateAxis = [...axes].find(([k]) => /state|status|zustand/i.test(k));
    if (stateAxis) {
      const miss = ['default', 'hover', 'focus', 'disabled'].filter((w) => ![...stateAxis[1]].some((x) => (w === 'default' ? /default|enabled|rest|normal|base/ : new RegExp(w)).test(x.toLowerCase())));
      if (miss.length) out.add(`  Not present (derived, usual UI states): ${miss.join(', ')}`);
    }
  }
  if (scr) {
    const sibs = db.prepare('SELECT node_id,name,state_hint,device,w FROM screens WHERE group_key=? AND node_id<>? ORDER BY ord').all(scr.group_key, id) as { node_id: string; name: string; state_hint: string | null; device: string; w: number }[];
    out.add(`Screen group ${q(scr.group_key, 40)} (derived from names): ${sibs.length + 1} screen(s)`);
    out.add(`  * ${id} ${q(scr.name, 40)} ${scr.state_hint ? '~state: ' + scr.state_hint : '(base)'} ${scr.device}`);
    for (const s of sibs.slice(0, 20)) out.add(`  - ${s.node_id} ${q(s.name, 40)} ${s.state_hint ? '~state: ' + s.state_hint : ''} ${s.device} ${s.w}px`);
  }
  const like = STATE_SQL.map(() => `lower(n.name) LIKE ?`).join(' OR ');
  const rows = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id)
    SELECT n.id,n.name,n.type FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.id<>? AND (${like}) LIMIT 40`).all(id, id, ...STATE_SQL.map((w) => `%${w}%`)) as { id: string; name: string; type: string }[];
  const hiddenN = one<{ c: number }>(db, `WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) SELECT COUNT(*) c FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.visible=0`, id).c;
  if (rows.length) {
    out.add('State hints inside (derived from layer names):');
    for (const r of rows) if (!out.add(`  ${r.id} ${r.type} ${q(r.name, 50)}`)) break;
  }
  if (hiddenN) out.add(`${hiddenN} hidden layers in the subtree (often alternative states): \`audit\` / \`tree ${id} --depth 3\``);
  if (!comp && !scr && !rows.length) out.add('No states detectable: neither variants nor state-like layer names. Ask the user which states (hover, disabled, error, empty, loading) are wanted.');
  out.hint('Missing states are questions for the user, not facts.');
}

export function notes(db: DatabaseSync, out: Out, o: { page?: number; full?: boolean }): void {
  const scrOf = (nid: string | null): string => {
    let cur: string | null = nid;
    for (let i = 0; cur && i < 40; i++) {
      if (one<unknown>(db, 'SELECT 1 FROM screens WHERE node_id=?', cur)) return cur;
      cur = (one<{ parent_id: string | null } | undefined>(db, 'SELECT parent_id FROM nodes WHERE id=?', cur))?.parent_id ?? null;
    }
    return '';
  };
  const rows = db.prepare(`SELECT n.node_id, n.kind, n.text, x.page FROM notes n LEFT JOIN nodes x ON x.id=n.node_id ${o.page != null ? 'WHERE x.page=?' : ''} ORDER BY x.page, n.kind`).all(...(o.page != null ? [o.page] : [])) as { node_id: string | null; kind: string; text: string; page: number }[];
  const comps = db.prepare("SELECT id,name,description FROM components WHERE description IS NOT NULL AND description <> '' LIMIT 100").all() as { id: string; name: string; description: string }[];
  out.head(`# ${rows.length} notes/annotations, ${comps.length} component descriptions`);
  // most important first (dev notes), identical texts are merged with a counter
  const PRIO: Record<string, number> = { 'dev-note': 0, note: 1, sticky: 2, context: 3, description: 4 };
  const merged = new Map<string, { r: (typeof rows)[number]; n: number; ids: string[] }>();
  for (const r of rows) {
    const key = r.kind + '\u0000' + r.text.trim();
    const e = merged.get(key);
    if (e) { e.n++; if (e.ids.length < 3 && r.node_id) e.ids.push(r.node_id); } else merged.set(key, { r, n: 1, ids: r.node_id ? [r.node_id] : [] });
  }
  const ordered = [...merged.values()].sort((a, b) => (PRIO[a.r.kind] ?? 9) - (PRIO[b.r.kind] ?? 9));
  for (const { r, n, ids } of ordered) {
    const s = r.node_id ? scrOf(r.node_id) : '';
    const body = o.full ? r.text.replace(/\s+/g, ' ') : r.text.replace(/\s+/g, ' ').slice(0, 360);
    if (!out.add(`[${r.kind}] ${ids.join(', ') || '-'}${s ? ` (screen ${s})` : ''}${n > 1 ? ` ×${n}` : ''}: ${body}${!o.full && r.text.length > 360 ? ' … (--full)' : ''}`, { nodes: ids, kind: r.kind, screen: s, count: n, text: r.text })) { out.skip(ordered.length); break; }
  }
  for (const c of comps) if (!out.add(`[component] ${c.id} ${q(c.name, 30)}: ${c.description.replace(/\s+/g, ' ').slice(0, 240)}`)) break;
  if (!rows.length && !comps.length) out.add('No notes in the file. Requirements come from the user only.');
  out.hint('Notes are requirements/hints from the design authors: turn contradictory or unclear passages into questions for the user.');
}

export function audit(db: DatabaseSync, out: Out, page?: number): void {
  const rows = (page != null
    ? db.prepare('SELECT kind,severity,node_id,page,msg FROM findings WHERE page=? OR page IS NULL ORDER BY severity DESC, kind, id').all(page)
    : db.prepare('SELECT kind,severity,node_id,page,msg FROM findings ORDER BY severity DESC, kind, id').all()) as { kind: string; severity: number; node_id: string | null; page: number | null; msg: string }[];
  const byKind = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  out.head(`# ${rows.length} findings${page != null ? ` (page ${page})` : ''}: ${[...byKind].map(([k, v]) => `${k} ${v}`).join(', ')} · severity 3 = likely requirement gap, 2 = quality, 1 = hygiene`);
  const perKind = new Map<string, number>();
  let hidden = 0;
  for (const r of rows) {
    const n = (perKind.get(r.kind) ?? 0) + 1;
    perKind.set(r.kind, n);
    if (n > 6) { hidden++; continue; }
    if (!out.add(`S${r.severity} ${r.kind}${r.node_id ? ' ' + r.node_id : ''}: ${r.msg}`, r)) break;
  }
  if (hidden) out.add(`… ${hidden} more findings of the same kinds (raise --max-tokens or use \`audit --page N\`)`);
  if (!rows.length) out.add('No automatic anomalies.');
  out.hint('Every finding is a suspicion: phrase it as a question with the frame ID for the user, do not treat it as fact.');
}
