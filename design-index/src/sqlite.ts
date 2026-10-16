import type * as Sqlite from 'node:sqlite';

// esbuild strips the "node:" prefix of builtins that only exist with a prefix, so load at runtime.
const mod = process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined;
if (!mod) throw new Error('node:sqlite fehlt: Node.js >= 22.13 erforderlich (aktuell ' + process.version + ').');
export const DatabaseSync = mod.DatabaseSync;
export type DatabaseSync = Sqlite.DatabaseSync;
export type StatementSync = Sqlite.StatementSync;
