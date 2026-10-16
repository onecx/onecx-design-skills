// Automatic findings for the understanding mode. Precomputed at ingest (inside SQLite) so `audit` is a plain read.
import type { DatabaseSync } from './sqlite.js';
import { safeJson } from './output.js';
import { timed } from './util.js';
import { loadTokens, modesOf, resolveValue } from './tokens.js';

import { NOTE_PREFIX } from './screens.js';
const PLACEHOLDERS = new Set(['text', 'button', 'label', 'title', 'heading', 'headline', 'subtitle', 'placeholder', 'platzhalter', 'beschriftung', 'überschrift', 'name', 'xxx', 'tbd', 'description', 'body text', 'body', 'link', 'input', 'value', 'item', 'option', 'dropdown', 'tab', 'tag', 'content', 'inhalt', 'text here', 'your text here', 'type here', 'label text', 'button text', 'heading 1', 'heading 2', 'überschrift 1', 'überschrift 2']);

const DEFAULT_NAME = /^(frame|group|rectangle|vector|ellipse|line|text|polygon|star|union|subtract|intersect|path|image|layer|boolean group|component|instance)( \d+)?$/i;

const hex = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function runAudit(db: DatabaseSync, format: string): void {
  let t0 = Date.now(); let last = '';
  const tick = (l: string) => { if (process.env.DESIGN_INDEX_DEBUG) { process.stderr.write(`[time] audit ${last}: ${Date.now() - t0} ms\n`); } t0 = Date.now(); last = l; };
  const ins = db.prepare('INSERT INTO findings(kind,severity,node_id,page,msg) VALUES(?,?,?,?,?)');
  const parentStmt = db.prepare('SELECT parent_id, page FROM nodes WHERE id=?');
  const screens = new Map<string, { page: number; name: string; group: string; state: string | null; device: string; w: number | null; n_inputs: number; n_rows: number }>();
  for (const s of db.prepare('SELECT node_id,page,name,group_key,state_hint,device,w,n_inputs,n_rows FROM screens').all() as any[]) {
    screens.set(s.node_id, { page: s.page, name: s.name, group: s.group_key, state: s.state_hint, device: s.device, w: s.w, n_inputs: s.n_inputs, n_rows: s.n_rows });
  }
  const cache = new Map<string, string | null>();
  const pageOf = new Map<string, number>();
  const screenOf = (id: string): string | null => {
    const path: string[] = [];
    let cur: string | null = id;
    let found: string | null = null;
    while (cur) {
      if (screens.has(cur)) { found = cur; break; }
      if (cache.has(cur)) { found = cache.get(cur)!; break; }
      path.push(cur);
      const r = parentStmt.get(cur) as { parent_id: string | null; page: number } | undefined;
      if (!r) break;
      pageOf.set(cur, r.page);
      cur = r.parent_id;
    }
    for (const p of path) cache.set(p, found);
    return found;
  };
  const add = (kind: string, sev: number, node: string | null, page: number | null, msg: string) => { ins.run(kind, sev, node, page, msg); };
  const pageFor = (id: string): number => (parentStmt.get(id) as { page: number } | undefined)?.page ?? 0;
  const nNodes = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;

  tick('dev notes');
  // ---- dev notes -> notes table (so `notes` is a plain read) ----
  const noteRows = db.prepare(`SELECT id, text FROM nodes WHERE type='text' AND text IS NOT NULL AND length(text) > 8`).all() as { id: string; text: string }[];
  const insNote = db.prepare('INSERT INTO notes(node_id,kind,text) VALUES(?,?,?)');
  let nDev = 0;
  for (const r of noteRows) {
    const up = r.text.trimStart().slice(0, 14).toUpperCase();
    if (NOTE_PREFIX.some((p) => up.startsWith(p))) { insNote.run(r.id, 'dev-note', r.text); nDev++; }
  }
  if (nDev) add('notes', 3, null, null, `${nDev} dev notes/hints in the design: read them before implementing (\`notes\`), they contain requirements`);

  tick('placeholder texts');
  // ---- placeholder texts ----
  const ph = new Map<string, { n: number; first: string; words: Map<string, number> }>();
  for (const r of db.prepare(`SELECT id, text FROM nodes WHERE type='text' AND evis=1 AND text IS NOT NULL AND length(text) < 400`).all() as { id: string; text: string }[]) {
    const t = r.text.trim().toLowerCase();
    if (!(PLACEHOLDERS.has(t) || t.includes('lorem ipsum') || /^lorem\b/.test(t))) continue;
    const sid = screenOf(r.id) ?? `page:${pageFor(r.id)}`;
    const e = ph.get(sid) ?? { n: 0, first: r.id, words: new Map() };
    e.n++; e.words.set(r.text.trim().slice(0, 20), (e.words.get(r.text.trim().slice(0, 20)) ?? 0) + 1);
    ph.set(sid, e);
  }
  for (const [sid, e] of ph) {
    const sc = screens.get(sid);
    add('placeholder', 2, e.first, sc?.page ?? Number(sid.split(':')[1]) ?? 0, `${e.n} placeholder text(s) in ${sc ? `screen ${sid} "${sc.name}"` : `page ${sid.replace('page:', '')}`}: ${[...e.words].slice(0, 4).map(([w, n]) => `"${w}"×${n}`).join(', ')}`);
  }

  tick('hidden / empty / unnamed');
  // ---- hidden / empty / unnamed ----
  const hid = new Map<string, { n: number; first: string }>();
  for (const r of db.prepare(`SELECT n.id FROM nodes n LEFT JOIN nodes p ON p.id=n.parent_id WHERE n.visible=0 AND (p.id IS NULL OR p.visible=1)`).all() as { id: string }[]) {
    const sid = screenOf(r.id) ?? 'none';
    const e = hid.get(sid) ?? { n: 0, first: r.id };
    e.n++; hid.set(sid, e);
  }
  for (const [sid, e] of hid) {
    const sc = screens.get(sid);
    add('hidden', 1, e.first, sc?.page ?? pageFor(e.first), `${e.n} hidden layer(s) in ${sc ? `screen ${sid} "${sc.name}"` : 'area without screen'}: intentional (variant/state) or leftover? Example ${e.first}`);
  }
  const empties = new Map<string, { n: number; first: string }>();
  for (const r of db.prepare(`SELECT id FROM nodes WHERE type='frame' AND nchild=0 AND visible=1 AND styles IS NULL AND depth>0 AND w>0 AND h>0`).all() as { id: string }[]) {
    const sid = screenOf(r.id) ?? 'none';
    const e = empties.get(sid) ?? { n: 0, first: r.id };
    e.n++; empties.set(sid, e);
  }
  for (const [sid, e] of empties) if (e.n >= 3) {
    const sc = screens.get(sid);
    add('empty', 1, e.first, sc?.page ?? pageFor(e.first), `${e.n} empty frames without fill/stroke in ${sc ? `screen ${sid} "${sc.name}"` : 'area without screen'} (example ${e.first})`);
  }
  const unnamed = new Map<string, { n: number; first: string }>();
  for (const r of db.prepare(`SELECT id, name FROM nodes WHERE name <> '' AND length(name) < 24`).all() as { id: string; name: string }[]) {
    if (!DEFAULT_NAME.test(r.name)) continue;
    const sid = screenOf(r.id) ?? 'none';
    const e = unnamed.get(sid) ?? { n: 0, first: r.id };
    e.n++; unnamed.set(sid, e);
  }
  for (const [sid, e] of unnamed) {
    const sc = screens.get(sid);
    const total = sc ? (db.prepare('SELECT n_nodes FROM screens WHERE node_id=?').get(sid) as { n_nodes: number }).n_nodes : nNodes;
    if (e.n >= 30 && e.n / total > 0.25) add('naming', 1, e.first, sc?.page ?? pageFor(e.first), `${e.n} of ${total} layers have default names (Frame 12, Group 3, Vector …) in ${sc ? `screen ${sid} "${sc.name}"` : 'area without screen'}: roles (header, card …) can only be derived from structure`);
  }

  tick('duplicates');
  // ---- duplicates ----
  for (const r of db.prepare(`SELECT name, w, h, nchild, COUNT(*) c, MIN(id) first FROM nodes WHERE type='frame' AND visible=1 AND nchild>=2 AND depth>=2 AND component_ref IS NULL AND name <> '' GROUP BY name, w, h, nchild HAVING c >= 3 ORDER BY c DESC LIMIT 12`).all() as { name: string; w: number | null; h: number | null; nchild: number; c: number; first: string }[]) {
    if (DEFAULT_NAME.test(r.name) && r.c < 6) continue;
    add('duplicate', 2, r.first, pageFor(r.first), `${r.c}× identical frame "${r.name}" (${r.w ?? 'fill/hug'}×${r.h ?? 'fill/hug'}, ${r.nchild} children) without component: component candidate (example ${r.first})`);
  }
  // the same board/screen present on several pages is a real duplicate; equal template names inside different boards are not
  for (const r of db.prepare(`SELECT board_name, COUNT(DISTINCT page) pg, GROUP_CONCAT(DISTINCT page) pages, MIN(node_id) first FROM screens WHERE board_name <> '' GROUP BY board_name HAVING pg > 1 LIMIT 12`).all() as { board_name: string; pg: number; pages: string; first: string }[]) {
    add('duplicate', 3, r.first, pageFor(r.first), `Board "${r.board_name}" occurs on ${r.pg} pages (pages ${r.pages}, e.g. screen ${r.first}): which version applies, is one of them outdated?`);
  }
  for (const r of db.prepare(`SELECT name, w, h, board_name, COUNT(DISTINCT page) pg, GROUP_CONCAT(node_id) ids FROM screens GROUP BY board_name, name, w, h HAVING pg > 1 LIMIT 10`).all() as { name: string; w: number; h: number; board_name: string; pg: number; ids: string }[]) {
    if (r.board_name) continue; // already reported as duplicate board
    add('duplicate', 3, r.ids.split(',')[0], pageFor(r.ids.split(',')[0]), `Screen "${r.name}" (${r.w}×${r.h}) exists on ${r.pg} pages (${r.ids.split(',').slice(0, 4).join(', ')}): which version applies?`);
  }
  if (format === 'fig') {
    db.exec(`CREATE TEMP TABLE cn AS SELECT c.name AS name, n.w AS w, n.h AS h FROM components c JOIN nodes n ON n.id = c.id
             UNION SELECT c.set_name, n.w, n.h FROM components c JOIN nodes n ON n.id = c.id WHERE c.set_name IS NOT NULL`);
    db.exec('CREATE INDEX temp.idx_cn ON cn(name)');
    for (const r of db.prepare(`SELECT DISTINCT n.id, n.name FROM nodes n JOIN cn ON cn.name = n.name AND cn.w = n.w AND cn.h = n.h
             WHERE n.type = 'frame' AND n.component_ref IS NULL AND n.nchild >= 1 AND n.depth >= 2 LIMIT 12`).all() as { id: string; name: string }[]) {
      add('detached', 2, r.id, pageFor(r.id), `Frame "${r.name}" matches a component in name and size but is not an instance (detached?) ${r.id}`);
    }
    db.exec('DROP TABLE cn');
  }

  tick('tokens');
  // ---- tokens ----
  const tokens = loadTokens(db);
  const usage = db.prepare('SELECT kind,value,n FROM usage').all() as { kind: string; value: string; n: number }[];
  const colors = usage.filter((u) => u.kind === 'color').sort((a, b) => b.n - a.n);
  const example = (pattern: string): string | null => (db.prepare('SELECT id FROM nodes WHERE styles LIKE ? LIMIT 1').get(pattern) as { id: string } | undefined)?.id ?? null;
  if (!tokens.length) {
    add('tokens', 2, null, null, `No token system: ${colors.length} distinct colors, ${usage.filter((u) => u.kind === 'fontSize').length} font sizes, ${usage.filter((u) => u.kind === 'gap' || u.kind === 'pad').length} spacing values used directly in the design (derive tokens: \`tokens --derive\`)`);
    let shown = 0;
    for (let i = 0; i < colors.length && shown < 8; i++) {
      const a = hex(colors[i].value); if (!a) continue;
      for (let j = i + 1; j < colors.length; j++) {
        const b = hex(colors[j].value);
        if (!b || colors[i].value === colors[j].value) continue;
        const d = dist(a, b);
        if (d > 0 && d <= 8 && Math.min(colors[i].n, colors[j].n) >= 1 && colors[i].value.length === colors[j].value.length) {
          const ex = example(`%"c":"${colors[j].value}"%`);
          add('tokens', 2, ex, ex ? pageFor(ex) : null, `Near-identical colors ${colors[i].value} (${colors[i].n}×) and ${colors[j].value} (${colors[j].n}×, Δ${d.toFixed(1)}): probably the same color, example ${ex ?? '?'}`);
          shown++; break;
        }
      }
    }
    const grid = usage.filter((u) => (u.kind === 'gap' || u.kind === 'pad') && Number(u.value) % 4 !== 0);
    if (grid.length) add('tokens', 1, null, null, `Spacing off the 4 px grid: ${grid.sort((a, b) => b.n - a.n).slice(0, 8).map((g) => `${g.value}(${g.n}×)`).join(', ')}`);
  } else {
    const modes = modesOf(tokens);
    const mode = modes.includes('default') ? 'default' : modes[0];
    const byId = new Map(tokens.flatMap((t) => (t.guid ? [[t.id, t], [t.guid, t]] : [[t.id, t]])) as [string, (typeof tokens)[number]][]);
    const tcolors: { name: string; rgb: [number, number, number]; hex: string }[] = [];
    for (const t of tokens) {
      if (t.type.toLowerCase() !== 'color') continue;
      const v = resolveValue(byId, t, mode);
      if (typeof v === 'string') { const rgb = hex(v); if (rgb) tcolors.push({ name: t.name, rgb, hex: v.slice(0, 7).toLowerCase() }); }
    }
    let shown = 0;
    for (const c of colors) {
      if (shown >= 10) break;
      const rgb = hex(c.value); if (!rgb) continue;
      let best: (typeof tcolors)[number] | undefined; let bd = Infinity;
      for (const t of tcolors) { const d = dist(rgb, t.rgb); if (d < bd) { bd = d; best = t; } }
      if (!best) continue;
      const ex = example(`%"c":"${c.value}"%`);
      if (bd === 0) { add('tokens', 2, ex, ex ? pageFor(ex) : null, `Color ${c.value} (${c.n}× unbound) equals token $${best.name} but is not bound to it (example ${ex})`); shown++; }
      else if (bd <= 12) { add('tokens', 2, ex, ex ? pageFor(ex) : null, `Color ${c.value} (${c.n}×) is close to token $${best.name} (${best.hex}, Δ${bd.toFixed(1)}) (example ${ex})`); shown++; }
      else if (c.n >= 5 && shown < 6) { add('tokens', 1, ex, ex ? pageFor(ex) : null, `Color ${c.value} (${c.n}×) has no matching token (nearest $${best.name}, Δ${bd.toFixed(0)}) (example ${ex})`); shown++; }
    }
  }

  tick('states');
  // ---- states ----
  const groups = new Map<string, string[]>();
  for (const [id, s] of screens) (groups.get(s.group) ?? groups.set(s.group, []).get(s.group)!).push(id);
  const stateText = (sid: string) => `${screens.get(sid)!.name} ${screens.get(sid)!.state ?? ''}`.toLowerCase();
  const hasState = (ids: string[], re: RegExp) => ids.some((i) => re.test(stateText(i)));
  const ERR = /fehler|error|invalid|ungültig|validier|validation/;
  const EMPTY = /leer|empty|keine |no results|noch keine/;
  const LOAD = /lade|loading|skeleton|spinner/;
  for (const [g, ids] of groups) {
    const probe = ids[0];
    const withInputs = ids.filter((i) => screens.get(i)!.n_inputs >= 2);
    if (withInputs.length && !hasState(ids, ERR) && !textExists(db, ids, /fehler|error|ungültig|pflichtfeld|invalid|required/i)) {
      add('states', 3, withInputs[0], screens.get(withInputs[0])!.page, `Form "${g}" (${screens.get(withInputs[0])!.n_inputs} input fields, ${ids.length} screen(s)) without a recognizable error/validation state (${withInputs[0]})`);
    }
    const lists = ids.filter((i) => screens.get(i)!.n_rows >= 3);
    if (lists.length && !hasState(ids, EMPTY) && !textExists(db, ids, /keine .*(gefunden|vorhanden|einträge|ergebnisse)|no .*(results|items)|noch keine/i)) {
      add('states', 3, lists[0], screens.get(lists[0])!.page, `List/table "${g}" without an empty state (${lists[0]})`);
    }
    if (lists.length && !hasState(ids, LOAD)) add('states', 2, lists[0], screens.get(lists[0])!.page, `List/table "${g}" without a loading state (${lists[0]})`);
    void probe;
  }
  if (format === 'fig') {
    for (const r of db.prepare(`SELECT set_name, set_id, GROUP_CONCAT(variant, '§') vs, COUNT(*) c FROM components WHERE set_name IS NOT NULL GROUP BY set_id HAVING c >= 2`).all() as { set_name: string; set_id: string; vs: string; c: number }[]) {
      const vals = new Map<string, Set<string>>();
      for (const v of r.vs.split('§')) for (const [k, x] of Object.entries(safeJson<Record<string, string>>(v) ?? {})) (vals.get(k) ?? vals.set(k, new Set()).get(k)!).add(String(x).toLowerCase());
      for (const [axis, set] of vals) {
        if (!/state|status|zustand/i.test(axis)) continue;
        const missing = ['hover', 'disabled', 'focus'].filter((w) => ![...set].some((x) => x.includes(w) || (w === 'disabled' && x.includes('inaktiv'))));
        if (set.size >= 2 && missing.length) add('states', 2, r.set_id, null, `Component "${r.set_name}" has ${[...set].join('/')} but not: ${missing.join(', ')} (${r.set_id})`);
      }
    }
  }

  tick('device coverage');
  // ---- device coverage ----
  const devByGroup = new Map<string, Set<string>>();
  for (const [, s] of screens) (devByGroup.get(s.group) ?? devByGroup.set(s.group, new Set()).get(s.group)!).add(s.device);
  const multi = [...devByGroup].filter(([, d]) => d.size >= 2);
  const allDevices = new Set([...screens.values()].map((s) => s.device));
  if (multi.length) {
    for (const [g, d] of devByGroup) if (d.size === 1) { const id = groups.get(g)![0]; add('devices', 3, id, screens.get(id)!.page, `Screen group "${g}" only for ${[...d][0]}, other groups (${multi.length}) have several widths (${id})`); }
  } else if (screens.size) {
    const w = [...new Set([...screens.values()].map((s) => s.w))].slice(0, 4).join('/');
    add('devices', 2, null, null, `All ${screens.size} screens only ${[...allDevices].join('/')} (width ${w}): is responsive behavior/a mobile view wanted? Not visible in the design`);
  }

  tick('prototype coverage');
  // ---- prototype coverage ----
  const nInter = (db.prepare('SELECT COUNT(*) c FROM interactions').get() as { c: number }).c;
  if (nInter) {
    const from = new Set<string>();
    const insEdge = db.prepare('INSERT INTO edges(src,dst,trigger,action,via) VALUES(?,?,?,?,?)');
    const seenEdge = new Set<string>();
    for (const r of db.prepare('SELECT node_id,trigger,action,target_id FROM interactions').all() as { node_id: string; trigger: string; action: string; target_id: string | null }[]) {
      // state swaps happen inside a component (hover, pressed ...): not navigation between screens
      if (r.action === 'SWAP_STATE' || r.action === 'NONE') continue;
      const s = screenOf(r.node_id);
      if (s) from.add(s);
      if (!s || !r.target_id) continue;
      const d = screenOf(r.target_id);
      const key = `${s}>${d}>${r.trigger}`;
      if (d && d !== s && !seenEdge.has(key)) { seenEdge.add(key); insEdge.run(s, d, r.trigger, r.action, r.node_id); }
    }
    const dead = [...screens.keys()].filter((s) => !from.has(s));
    if (dead.length) add('flows', 2, dead[0], screens.get(dead[0])!.page, `${dead.length} of ${screens.size} screens without an outgoing prototype connection (dead ends or states only), e.g. ${dead.slice(0, 4).join(', ')}`);
  } else if (screens.size > 1) {
    add('flows', 2, null, null, 'No prototype connections in the file: flows can only be derived from naming/order (`flows`), please have them confirmed');
  }
  tick('end');
}

function textExists(db: DatabaseSync, screenIds: string[], re: RegExp): boolean {
  const stmt = db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id) SELECT n.text FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.type='text' AND n.text IS NOT NULL`);
  for (const id of screenIds.slice(0, 20)) for (const r of stmt.all(id) as { text: string }[]) if (re.test(r.text)) return true;
  return false;
}
