// Screen detection and purpose estimation. Everything derived here is a heuristic ("derived") and is labelled so.
import type { DatabaseSync } from './sqlite.js';
import type { Layout } from './model.js';
import { safeJson } from './output.js';

interface N { isset?: number; id: string; parent_id: string | null; page: number; type: string; name: string; depth: number; w: number | null; h: number | null; nchild: number; layout: string | null; visible: number }

export const NOTE_PREFIX = ['DEV NOTE', 'DEV-NOTE', 'DEVNOTE', 'NOTE:', 'NOTE –', 'NOTIZ', 'HINWEIS', 'TODO', 'TO DO', 'FIXME', 'ANMERKUNG', 'ANNOTATION', 'OPEN QUESTION', 'OFFENE FRAGE', 'DESIGN NOTE', 'ÜBERGABE', 'HANDOFF', 'HINT:', 'ACHTUNG'];
const MIN_W = 300, MAX_W = 2600, MIN_H = 300;

/** Viewport-like = plausible app/page size. Top-level frames with unknown height (hug) count if wide enough. */
function viewportLike(n: N): boolean {
  if (!['frame', 'component', 'section'].includes(n.type) || n.type === 'component') return false;
  if (n.w == null) return false;
  if (n.w < MIN_W || n.w > MAX_W) return false;
  if (n.h == null) return n.depth === 0;
  return n.h >= MIN_H;
}

const PURPOSES: [RegExp, string][] = [
  [/modal|dialog|popup|overlay|drawer/i, 'Dialog / overlay'],
  [/login|log-in|sign.?in|anmeld|einlogg/i, 'Login / sign-in'],
  [/regist|sign.?up|konto erstellen/i, 'Registration'],
  [/landing/i, 'Landing page / entry'],
  [/dashboard|start(seite)?|home|übersicht(sseite)?|overview/i, 'Home / overview'],
  [/detail/i, 'Detail page'],
  [/warenkorb|cart|basket/i, 'Shopping cart'],
  [/bestell|order|checkout|kasse/i, 'Order / checkout'],
  [/such|search|ergebnis|result/i, 'Search / results'],
  [/formular|form|eingabe|erfassen|einrichten|konfig|wizard|schritt|step/i, 'Input / configuration (multi-step)'],
  [/bestätig|confirm|erfolg|success|eingereicht|danke|thanks/i, 'Confirmation / success'],
  [/fehler|error|404|500|störung/i, 'Error state'],
  [/leer|empty|no results|keine /i, 'Empty state'],
  [/lade|loading|skeleton|spinner/i, 'Loading state'],
  [/einstell|settings|profil|profile|konto|account/i, 'Settings / profile'],
  [/liste|list|tabelle|table|verwalt|manage/i, 'List / management'],
  [/status|verlauf|history|timeline/i, 'Status / history'],
  [/hilfe|help|faq|support|kontakt/i, 'Help / support'],
  [/impressum|datenschutz|privacy|legal/i, 'Legal'],
];

const STATE_WORDS = /(hover|focus|active|pressed|disabled|inaktiv|error|fehler|empty|leer|loading|lade|success|erfolg|selected|ausgewählt|expanded|collapsed|offen|geschlossen|notification|benachrichtigung|mit |ohne |draft|entwurf|filled|ausgefüllt|validation|validierung)/i;

export function deviceOf(w: number, name: string): string {
  if (/mobile|phone|smartphone/i.test(name) || w <= 480) return 'mobile';
  if (/tablet|ipad/i.test(name) || w <= 1000) return 'tablet';
  return 'desktop';
}

export function groupKey(name: string): { group: string; state: string } {
  const cleaned = name.replace(/^\s*\d+\s*[–\-.:]\s*/, '').trim();
  const parts = cleaned.split(/\s+[–\-/|]\s+|\s*\/\s*/);
  const group = (parts[0] || cleaned).replace(/\s+\d+$/, '').trim();
  let state = parts.slice(1).join(' / ');
  if (!state) { const m = STATE_WORDS.exec(cleaned); if (m) state = m[0]; }
  return { group: group || cleaned, state };
}

const stripNum = (s: string) => s.replace(/^\s*\d+\s*[–\-.:]\s*/, '').trim();

function purposeOf(sources: [string, string][], signals: Record<string, number>): { purpose: string; why: string[] } {
  for (const [label, src] of sources) {
    if (!src) continue;
    for (const [re, p] of PURPOSES) if (re.test(src)) return { purpose: p, why: [`${label} „${src.slice(0, 40)}“`] };
  }
  if (signals.inputs >= 3) return { purpose: 'Form / input', why: [`${signals.inputs} input fields`] };
  if (signals.tableLike >= 3) return { purpose: 'List / table', why: ['table-like rows'] };
  return { purpose: 'unclear', why: ['no hint in name/structure'] };
}

export function detectScreens(db: DatabaseSync, format: string): void {
  const get = db.prepare("SELECT id,parent_id,page,type,name,depth,w,h,nchild,layout,visible, (raw LIKE '%isComponentSet%') AS isset FROM nodes WHERE parent_id=? ORDER BY ord");
  const tops = db.prepare('SELECT id,parent_id,page,type,name,depth,w,h,nchild,layout,visible FROM nodes WHERE depth=0 AND page NOT IN (SELECT idx FROM pages WHERE internal=1) ORDER BY page, ord').all() as unknown as N[];
  const insert = db.prepare('INSERT OR REPLACE INTO screens(node_id,page,name,w,h,ord,purpose,group_key,state_hint,device,texts,n_nodes,board_name,n_inputs,n_rows) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const CTE = 'WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM nodes n JOIN t ON n.parent_id=t.id)';
  const INPUT = ['input', 'textfield', 'text field', 'eingabe', 'dropdown', 'checkbox', 'radio', 'combobox', 'datepicker', 'textarea', 'toggle'].map((w) => `lower(n.name) LIKE '%${w}%'`).join(' OR ');
  const ROWS = `lower(n.name) LIKE 'row %' OR lower(n.name) LIKE '% row' OR lower(n.name) = 'row' OR lower(n.name) LIKE '%zeile%' OR lower(n.name) LIKE '%tabelle%' OR lower(n.name) LIKE '%table%' OR lower(n.name) LIKE '%list item%' OR lower(n.name) LIKE '%listitem%'`;
  const counts = db.prepare(`${CTE} SELECT COUNT(*) n, COALESCE(SUM(n.evis = 1 AND n.type IN ('instance','frame','component') AND n.name NOT LIKE '%option%' AND n.name NOT LIKE '%item%' AND (${INPUT})), 0) inputs, COALESCE(SUM(n.evis = 1 AND (${ROWS})), 0) rws FROM t CROSS JOIN nodes n ON n.id=t.id`);
  const topTexts = db.prepare(`${CTE} SELECT n.text t, COALESCE(json_extract(n.styles, '$.font.s'), 0) s FROM t CROSS JOIN nodes n ON n.id=t.id WHERE n.type='text' AND n.evis=1 AND n.text IS NOT NULL ORDER BY s DESC, n.y LIMIT 12`);
  let ord = 0;

  const isBoard = (n: N, kids: N[]): boolean => {
    if (n.w != null && n.w > MAX_W) return true;
    if (n.type === 'section') return true;
    const vp = kids.filter((k) => viewportLike(k) && k.visible);
    if (!vp.length) return false;
    if (vp.length >= 2) return true;
    const c = vp[0];
    if (n.w == null || c.w == null) return false;
    const areaN = n.w * (n.h ?? c.h ?? 0), areaC = c.w * (c.h ?? 0);
    return c.w >= 0.5 * n.w && (c.h ?? 0) >= MIN_H && areaN >= 1.5 * areaC && kids.filter((k) => k.type === 'text').length >= 1;
  };

  const cands: { n: N; board: string }[] = [];
  const register = (n: N, board: string, generic: boolean): boolean => {
    const c = counts.get(n.id) as { n: number; inputs: number; rws: number };
    const withSize = (topTexts.all(n.id) as { t: string; s: number }[]).map((r) => ({ t: r.t, s: Number(r.s) || 0 }));
    const headline = withSize[0]?.t ?? '';
    const sample = [...new Set(withSize.slice(0, 8).map((x) => x.t.replace(/\s+/g, ' ').slice(0, 40)))].slice(0, 6);
    const signals = { inputs: c.inputs, tableLike: c.rws };
    if (NOTE_PREFIX.some((p) => headline.trimStart().toUpperCase().startsWith(p))) return false;
    const gk = groupKey(n.name);
    const group = generic ? stripNum(board) || n.name : gk.group;
    const state = generic ? '' : gk.state;
    const p = purposeOf(generic ? [['board', stripNum(board)], ['heading', headline]] : [['name', n.name], ['board', stripNum(board)], ['heading', headline]], signals);
    insert.run(n.id, n.page, n.name, n.w, n.h, ord++, `${p.purpose} ← ${p.why.join(', ')}`, group, state || null, deviceOf(n.w ?? 1440, n.name), JSON.stringify(sample), c.n, board, signals.inputs, signals.tableLike);
    return true;
  };

  const visit = (n: N, board: string, depth: number) => {
    if (depth > 6 || !n.visible || n.isset) return;
    const kids = n.nchild ? (get.all(n.id) as unknown as N[]) : [];
    if (n.type === 'group' || n.type === 'section' || (n.depth === 0 && !viewportLike(n)) ) {
      for (const k of kids) visit(k, n.name || board, depth + 1);
      return;
    }
    if (!viewportLike(n)) {
      // big containers with unknown geometry still may hold screens
      if ((n.w != null && n.w > MAX_W) || (n.type === 'frame' && n.nchild && n.depth <= 1)) for (const k of kids) visit(k, n.name || board, depth + 1);
      return;
    }
    if (isBoard(n, kids)) { for (const k of kids) visit(k, n.name || board, depth + 1); return; }
    cands.push({ n, board });
  };
  for (const t of tops) visit(t, '', 0);
  // names shared by many screens are template names, not descriptions of the screen
  const freq = new Map<string, number>();
  for (const c of cands) freq.set(c.n.name, (freq.get(c.n.name) ?? 0) + 1);
  for (const c of cands) register(c.n, c.board, (freq.get(c.n.name) ?? 0) >= 5);
  db.exec('UPDATE pages SET screen_count = (SELECT COUNT(*) FROM screens WHERE screens.page = pages.idx)');
  void format; void ({} as Layout);
}
