// Second pass, entirely inside the database: child counts, FTS, component usage, screens, audit.
// Nothing here loads the node set into memory.
import type { DatabaseSync } from './sqlite.js';
import { detectScreens } from './screens.js';
import { runAudit } from './audit.js';
import { timed } from './util.js';

export function analyze(db: DatabaseSync, format: string): void {
  db.exec('BEGIN');
  timed('nchild', () => db.exec(`UPDATE nodes SET nchild = (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = nodes.id)
           WHERE id IN (SELECT DISTINCT parent_id FROM nodes WHERE parent_id IS NOT NULL)`));
  timed('instances', () => db.exec(`UPDATE components SET instances = (SELECT COUNT(*) FROM nodes n WHERE n.component_ref = components.id)`));
  timed('fts', () => db.exec(`INSERT INTO nodes_fts(rowid, name, text) SELECT rowid, name, COALESCE(text,'') FROM nodes WHERE name <> '' OR text IS NOT NULL`));
  // effective visibility: a node is only seen if it and all its ancestors are visible
  timed('evis', () => {
    db.exec(`CREATE TEMP TABLE vis(id TEXT PRIMARY KEY) WITHOUT ROWID`);
    db.exec(`INSERT INTO vis WITH RECURSIVE v(id) AS (
        SELECT id FROM nodes WHERE parent_id IS NULL AND visible = 1
        UNION ALL SELECT n.id FROM v CROSS JOIN nodes n ON n.parent_id = v.id WHERE n.visible = 1) SELECT id FROM v`);
    db.exec('UPDATE nodes SET evis = 0 WHERE visible = 1 AND NOT EXISTS (SELECT 1 FROM vis WHERE vis.id = nodes.id)');
    db.exec('UPDATE nodes SET evis = 0 WHERE visible = 0');
    db.exec('DROP TABLE vis');
  });
  db.exec('COMMIT');
  db.exec('BEGIN');
  timed('screens', () => detectScreens(db, format));
  timed('audit', () => runAudit(db, format));
  db.exec('COMMIT');
  timed('analyze', () => db.exec('ANALYZE'));
}
