import { DatabaseSync, type StatementSync } from './sqlite.js';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetRow, ComponentRow, DerivedRow, InteractionRow, NodeRow, NoteRow, PropDefRow, Sink, VarModeRow, VariableRow } from './model.js';

export const SCHEMA_VERSION = 24;

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE pages(idx INTEGER PRIMARY KEY, id TEXT, name TEXT, node_count INTEGER DEFAULT 0, screen_count INTEGER DEFAULT 0, internal INTEGER DEFAULT 0);
CREATE TABLE nodes(
  id TEXT PRIMARY KEY, parent_id TEXT, page INTEGER, type TEXT, name TEXT, depth INTEGER, ord INTEGER,
  x REAL, y REAL, w REAL, h REAL, layout TEXT, styles TEXT, text TEXT, component_ref TEXT,
  visible INTEGER, raw TEXT, nchild INTEGER DEFAULT 0, pos TEXT, evis INTEGER DEFAULT 1, stext TEXT
);
CREATE TABLE geometry(node_id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE components(
  id TEXT PRIMARY KEY, name TEXT, page INTEGER, description TEXT, set_id TEXT, set_name TEXT,
  variant TEXT, props TEXT, instances INTEGER DEFAULT 0
);
CREATE TABLE variables(id TEXT PRIMARY KEY, name TEXT, collection TEXT, type TEXT, vals TEXT, guid TEXT);
CREATE TABLE assets(hash TEXT PRIMARY KEY, path TEXT, mime TEXT, size INTEGER, w INTEGER, h INTEGER);
CREATE TABLE interactions(node_id TEXT, trigger TEXT, action TEXT, target_id TEXT, detail TEXT);
CREATE TABLE notes(node_id TEXT, kind TEXT, text TEXT);
CREATE TABLE usage(kind TEXT, value TEXT, n INTEGER, PRIMARY KEY(kind, value));
CREATE TABLE warnings(msg TEXT, n INTEGER DEFAULT 1);
CREATE TABLE screens(
  node_id TEXT PRIMARY KEY, page INTEGER, name TEXT, w REAL, h REAL, ord INTEGER, purpose TEXT,
  group_key TEXT, state_hint TEXT, device TEXT, texts TEXT, n_nodes INTEGER, board_name TEXT, n_inputs INTEGER, n_rows INTEGER
);
CREATE TABLE propdefs(owner TEXT, id TEXT, name TEXT, type TEXT, initial TEXT, parent TEXT);
CREATE TABLE derived(inst TEXT, p TEXT, w REAL, h REAL, x REAL, y REAL, geom TEXT, ns INTEGER, sg TEXT);
CREATE TABLE varmodes(set_id TEXT, set_key TEXT, set_name TEXT, mode_id TEXT, mode_name TEXT);
CREATE TABLE edges(src TEXT, dst TEXT, trigger TEXT, action TEXT, via TEXT);
CREATE TABLE findings(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, severity INTEGER, node_id TEXT, page INTEGER, msg TEXT);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id, ord);
CREATE INDEX IF NOT EXISTS idx_nodes_page ON nodes(page);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_comp ON nodes(component_ref);
CREATE INDEX IF NOT EXISTS idx_inter_node ON interactions(node_id);
CREATE INDEX IF NOT EXISTS idx_notes_node ON notes(node_id);
CREATE INDEX IF NOT EXISTS idx_find_page ON findings(page, severity);
CREATE INDEX IF NOT EXISTS idx_screens_page ON screens(page, ord);
CREATE INDEX IF NOT EXISTS idx_comp_set ON components(set_id);
CREATE INDEX IF NOT EXISTS idx_propdefs_owner ON propdefs(owner);
CREATE INDEX IF NOT EXISTS idx_propdefs_id ON propdefs(id);
CREATE INDEX IF NOT EXISTS idx_derived_inst ON derived(inst);
CREATE VIRTUAL TABLE nodes_fts USING fts5(name, text, content='nodes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
`;

export function openDb(file: string, opts: { create?: boolean; readonly?: boolean } = {}): DatabaseSync {
  if (opts.create) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: !!opts.readonly });
  if (opts.create) {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-65536;');
    db.exec(SCHEMA);
  }
  return db;
}

export function createIndexes(db: DatabaseSync): void {
  db.exec(INDEXES);
}

const j = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
const BATCH = 1000;

/** Buffers rows and writes them in transactions of ~1000 via prepared statements. */
export class IndexWriter implements Sink {
  private nodes: NodeRow[] = [];
  private geoms: [string, string][] = [];
  private pdefs: PropDefRow[] = [];
  private derivs: DerivedRow[] = [];
  private stmtNode: StatementSync;
  private stmtGeom: StatementSync;
  private stmts: Record<string, StatementSync>;
  private usageMap = new Map<string, number>();
  private warnMap = new Map<string, number>();
  private pageStats = new Map<number, number>();
  nodeCount = 0;

  constructor(private db: DatabaseSync) {
    this.stmtNode = db.prepare(
      'INSERT OR REPLACE INTO nodes(id,parent_id,page,type,name,depth,ord,x,y,w,h,layout,styles,text,component_ref,visible,raw,pos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.stmtGeom = db.prepare('INSERT OR REPLACE INTO geometry(node_id,data) VALUES(?,?)');
    this.stmts = {
      comp: db.prepare('INSERT OR REPLACE INTO components(id,name,page,description,set_id,set_name,variant,props) VALUES(?,?,?,?,?,?,?,?)'),
      vari: db.prepare('INSERT OR REPLACE INTO variables(id,name,collection,type,vals,guid) VALUES(?,?,?,?,?,?)'),
      asset: db.prepare('INSERT OR REPLACE INTO assets(hash,path,mime,size,w,h) VALUES(?,?,?,?,?,?)'),
      inter: db.prepare('INSERT INTO interactions(node_id,trigger,action,target_id,detail) VALUES(?,?,?,?,?)'),
      note: db.prepare('INSERT INTO notes(node_id,kind,text) VALUES(?,?,?)'),
      page: db.prepare('INSERT OR REPLACE INTO pages(idx,id,name) VALUES(?,?,?)'),
      meta: db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)'),
    };
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  node(r: NodeRow): void {
    this.nodes.push(r);
    this.nodeCount++;
    this.pageStats.set(r.page, (this.pageStats.get(r.page) ?? 0) + 1);
    if (this.nodes.length >= BATCH) this.flush();
  }

  /** Path geometry lives in its own table so `node`/`tree` queries never touch it. */
  geometry(nodeId: string, data: string): void {
    this.geoms.push([nodeId, data]);
  }

  flush(): void {
    if (!this.nodes.length && !this.geoms.length && !this.pdefs.length && !this.derivs.length) return;
    const rows = this.nodes;
    const geoms = this.geoms;
    const pdefs = this.pdefs;
    const derivs = this.derivs;
    this.nodes = [];
    this.geoms = [];
    this.pdefs = [];
    this.derivs = [];
    this.tx(() => {
      for (const [id, data] of geoms) this.stmtGeom.run(id, data);
      if (pdefs.length) { const st = this.db.prepare('INSERT INTO propdefs(owner,id,name,type,initial,parent) VALUES(?,?,?,?,?,?)'); for (const r of pdefs) st.run(r.owner, r.id, r.name, r.type, JSON.stringify(r.initial ?? null), r.parent); }
      if (derivs.length) { const st = this.db.prepare('INSERT INTO derived(inst,p,w,h,x,y,geom,ns,sg) VALUES(?,?,?,?,?,?,?,?,?)'); for (const r of derivs) st.run(r.inst, r.p, r.w ?? null, r.h ?? null, r.x ?? null, r.y ?? null, r.geom ?? null, r.ns ? 1 : 0, r.sg ?? null); }
      for (const r of rows) {
        this.stmtNode.run(
          r.id, r.parent_id, r.page, r.type, r.name, r.depth, r.ord, r.x, r.y, r.w, r.h,
          j(r.layout), j(r.styles), r.text ?? null, r.component_ref ?? null, r.visible ? 1 : 0, j(r.raw), r.pos ?? null,
        );
      }
    });
  }

  component(r: ComponentRow): void {
    this.tx(() => this.stmts.comp.run(r.id, r.name, r.page, r.description ?? '', r.set_id ?? null, r.set_name ?? null, j(r.variant), j(r.props)));
  }
  variable(r: VariableRow): void {
    this.tx(() => this.stmts.vari.run(r.id, r.name, r.collection, r.type, JSON.stringify(r.values), r.guid ?? null));
  }
  propdef(r: PropDefRow): void {
    this.pdefs.push(r);
  }
  derived(r: DerivedRow): void {
    this.derivs.push(r);
    if (this.derivs.length >= BATCH * 5) this.flush();
  }
  varmode(r: VarModeRow): void {
    this.tx(() => this.db.prepare('INSERT INTO varmodes(set_id,set_key,set_name,mode_id,mode_name) VALUES(?,?,?,?,?)').run(r.set_id, r.set_key, r.set_name, r.mode_id, r.mode_name));
  }
  asset(r: AssetRow): void {
    this.tx(() => this.stmts.asset.run(r.hash, r.path, r.mime, r.size, r.w ?? null, r.h ?? null));
  }
  interaction(r: InteractionRow): void {
    this.tx(() => this.stmts.inter.run(r.node_id, r.trigger, r.action, r.target_id ?? null, r.detail ?? null));
  }
  note(r: NoteRow): void {
    this.tx(() => this.stmts.note.run(r.node_id, r.kind, r.text));
  }
  page(idx: number, id: string, name: string): void {
    this.tx(() => this.stmts.page.run(idx, id, name));
  }
  /** Flushes buffered rows, then runs SQL (second-pass fix-ups inside the database). */
  exec(sql: string): void {
    this.flush();
    this.db.exec(sql);
  }
  // statements are cached by their SQL text: second-pass loops run the same statement many thousand times, and every
  // un-finalized prepared statement holds native memory until it is garbage-collected
  private cached = new Map<string, StatementSync>();
  private stmt(sql: string): StatementSync {
    let st = this.cached.get(sql);
    if (!st) { st = this.db.prepare(sql); if (this.cached.size < 200) this.cached.set(sql, st); }
    return st;
  }
  query<T = unknown>(sql: string, ...a: any[]): T[] {
    this.flush();
    return this.stmt(sql).all(...a) as T[];
  }
  run(sql: string, ...a: any[]): void {
    this.flush();
    this.stmt(sql).run(...a);
  }
  meta(key: string, value: string): void {
    this.stmts.meta.run(key, value);
  }
  warn(msg: string, n = 1): void {
    this.warnMap.set(msg, (this.warnMap.get(msg) ?? 0) + n);
  }
  usage(kind: string, value: string, n = 1): void {
    const k = kind + '\u0000' + value;
    this.usageMap.set(k, (this.usageMap.get(k) ?? 0) + n);
  }

  /** Writes aggregated counters; call once after parsing. */
  finish(): void {
    this.flush();
    this.tx(() => {
      for (const [k, n] of this.usageMap) {
        const [kind, value] = k.split('\u0000');
        this.db.prepare('INSERT OR REPLACE INTO usage(kind,value,n) VALUES(?,?,?)').run(kind, value, n);
      }
      for (const [msg, n] of this.warnMap) this.db.prepare('INSERT INTO warnings(msg,n) VALUES(?,?)').run(msg, n);
      for (const [p, n] of this.pageStats) this.db.prepare('UPDATE pages SET node_count=? WHERE idx=?').run(n, p);
    });
  }
}

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value;
}
