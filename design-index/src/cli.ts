#!/usr/bin/env node
import { Command } from 'commander';
import type { DatabaseSync } from './sqlite.js';
import { openIndex, type Opened } from './cache.js';
import { ingest } from './ingest.js';
import { Out } from './output.js';
import { doctor } from './commands/doctor.js';
import { audit, flows, notes, screensCmd, states, summary } from './commands/understand.js';
import { assetsExport, screenshot } from './commands/assets.js';
import { components, tokensCommand } from './commands/library.js';
import { specCommand } from './commands/spec.js';
import { nodeDetail, overview, search, tree } from './commands/structure.js';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });

const program = new Command('design-query')
  .description('Queries against an index of .pen/.fig design files (small, token-limited output)')
  .version('0.1.5')
  .showHelpAfterError();

interface Common { file?: string; json?: boolean; maxTokens?: string }

function common(c: Command, defaultTokens = 2000): Command {
  return c
    .option('--file <path>', 'design file (default: most recently indexed)')
    .option('--json', 'machine-readable output')
    .option('--max-tokens <n>', `token limit of the output (default ${defaultTokens})`);
}

function action<T extends Common>(defaultTokens: number, fn: (ix: Opened, out: Out, opts: T, ...args: any[]) => void | Promise<void>) {
  return async (...a: any[]) => {
    const cmd = a[a.length - 1] as Command;
    const opts = cmd.opts<T>();
    try {
      const ix = openIndex(opts.file);
      const out = new Out({ maxTokens: opts.maxTokens ? Number(opts.maxTokens) : defaultTokens, json: !!opts.json });
      await fn(ix, out, opts, ...a.slice(0, -2));
      out.print();
      ix.db.close();
    } catch (e) {
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  };
}

program.command('doctor').description('Checks the environment (Node, SQLite, renderer, cache folder)').action(async () => { process.exitCode = (await doctor()) ? 0 : 1; });

program.command('ingest <file>')
  .description('Index a file (format is detected, result is cached; already indexed files are skipped)')
  .option('--force', 're-index even if cached')
  .option('--json', 'machine-readable output')
  .action(async (datei: string, opts: { force?: boolean; json?: boolean }) => {
    try {
      const r = await ingest(datei, { force: opts.force });
      if (opts.json) process.stdout.write(JSON.stringify(r) + '\n');
      else process.stdout.write(`OK ${r.format} ${r.cached ? '(Cache)' : `${r.nodes} nodes in ${(r.ms / 1000).toFixed(1)} s, peak ${r.peakRssMB} MB`} · ${r.hash.slice(0, 12)} · ${r.warnings} warning types\nNext: design-query summary`.replace(/\n/, '\n') + '\n');
    } catch (e) {
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  });

common(program.command('overview').description('Pages, top-level frames, component and token overview').option('--page <n>', 'only this page'))
  .action(action<Common & { page?: string }>(2000, (ix, out, o) => overview(ix.db, out, o.page ? Number(o.page) : undefined)));

common(program.command('tree <id>').description('Subtree in compact notation').option('--depth <n>', 'depth', '2').option('--max-children <n>', 'max children per node', '40'))
  .action(action<Common & { depth: string; maxChildren: string }>(2000, (ix, out, o, id: string) => tree(ix.db, out, id, Number(o.depth), Number(o.maxChildren))));

common(program.command('search <text>').description('Full-text search in names and texts').option('--type <t>', 'frame|text|component|instance|icon|rect|path|note').option('--limit <n>', 'max results', '25'))
  .action(action<Common & { type?: string; limit: string }>(2000, (ix, out, o, text: string) => search(ix.db, out, text, o.type, Number(o.limit))));

common(program.command('node <id>').description('Raw attributes of a node (formatted)'))
  .action(action<Common>(2000, (ix, out, _o, id: string) => nodeDetail(ix.db, out, id)));

common(program.command('spec <id>').description('Implementation-ready, framework-neutral specification (layout, token names, texts, components, assets)')
  .option('--out <file>', 'write the spec to a file (prints only a summary)').option('--depth <n>', 'maximum depth').option('--include-hidden', 'include hidden nodes'), 4000)
  .action(action<Common & { out?: string; depth?: string; includeHidden?: boolean }>(4000, (ix, out, o, id: string) => specCommand(ix.db, out, id, { ...o, maxTokensGiven: !!o.maxTokens })));

common(program.command('components [filter]').description('Components with variants, properties, descriptions'))
  .action(action<Common>(2000, (ix, out, _o, filter?: string) => components(ix.db, out, filter)));

common(program.command('tokens').description('Design tokens as CSS custom properties / JSON / TS (themes as [data-theme])')
  .option('--format <f>', 'css|json|ts', 'css').option('--out <file>', 'write to a file (prints only a summary)').option('--derive', 'if the file defines no tokens: derive them from the values in use'))
  .action(action<Common & { format: string; out?: string; derive?: boolean }>(2000, (ix, out, o) => tokensCommand(ix.db, out, o)));

const assetsCmd = program.command('assets').description('Export assets');
common(assetsCmd.command('export <id>').description('SVG for vectors, original files for raster images → directory').requiredOption('--out <dir>', 'target directory'))
  .action(action<Common & { out: string }>(2000, (ix, out, o, id: string) => assetsExport(ix, out, id, o)));

common(program.command('screenshot <id>').description('PNG of a frame/section, rendered offline from the index (approximation), max 1024 px long edge')
  .option('--max-edge <px>', 'long edge', '1024').option('--out <file>', 'target file').option('--svg', 'SVG instead of PNG').option('--no-text', 'without texts'))
  .action(action<Common & { maxEdge: string; out?: string; svg?: boolean; text?: boolean }>(2000, (ix, out, o, id: string) => screenshot(ix, out, id, { ...o, noText: o.text === false })));

common(program.command('summary').description('Overall picture in a few paragraphs (understanding mode)'))
  .action(action<Common>(2000, (ix, out) => summary(ix.db, out)));
common(program.command('screens').description('Screens with purpose estimate, grouped by page/board').option('--page <n>', 'only this page'))
  .action(action<Common & { page?: string }>(2000, (ix, out, o) => screensCmd(ix.db, out, o.page ? Number(o.page) : undefined)));
common(program.command('flows').description('Flows: prototype connections, otherwise derived from naming'))
  .action(action<Common>(2000, (ix, out) => flows(ix.db, out)));
common(program.command('states <id>').description('States of a screen or component'))
  .action(action<Common>(2000, (ix, out, _o, id: string) => states(ix.db, out, id)));
common(program.command('notes').description('Annotations, dev notes, component descriptions').option('--page <n>', 'only this page').option('--full', 'do not truncate texts'))
  .action(action<Common & { page?: string; full?: boolean }>(2000, (ix, out, o) => notes(ix.db, out, { page: o.page ? Number(o.page) : undefined, full: o.full })));
common(program.command('audit').description('Automatically detected anomalies with frame IDs').option('--page <n>', 'only this page'))
  .action(action<Common & { page?: string }>(2000, (ix, out, o) => audit(ix.db, out, o.page ? Number(o.page) : undefined)));

export type { DatabaseSync };
program.parseAsync(process.argv);
