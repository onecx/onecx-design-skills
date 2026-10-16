# design-skills

Skill system that lets an AI agent with a small context window (250k tokens) **read, question and implement large design files**
(`.pen` from Pencil, `.fig` from Figma, tested up to 400 MB) without ever reading the raw file.

```
design-index/             global, framework-neutral skill: CLI `design-query` + SKILL.md + references/
project-skills/react/     copy into <react-repo>/.claude/skills/implement-design/
project-skills/angular/   copy into <angular-repo>/.claude/skills/implement-design/
```

All skill text is English. The project skills only use the `design-query` command, never a path into `design-index`.

## Install (the only requirement is Node.js ≥ 22.13)
```
# from a release: unpack design-index-<version>.tar.gz, then
cd design-index && npm link        # or: npm i -g . ; or call: node design-index/dist/cli.js <command>
design-query doctor                # checks Node, SQLite, renderer, cache folder and prints a fix for every problem
```
`dist/` is not committed; the release artifact contains it prebuilt and self-contained (all dependencies are bundled, fonts and the WASM renderer are inside). To rebuild: `npm install && npm run build`;
tests: `npm test` (builds, then runs vitest). Copy `design-index/` as a whole (without `node_modules`) into the global skills folder.

The index is a throw-away cache in `<repo>/.design-index/<hash>/` (Git-ignored automatically, `DESIGN_INDEX_DIR` overrides the location).

## Commands
`ingest overview summary screens flows states notes audit tree search node spec components tokens assets export screenshot doctor`
(details: `design-index/SKILL.md`). Every output is limited to ~2,000 tokens (`spec` ~4,000), uses a compact notation, names the next
command when truncated, and marks every guess as `~`/derived.

## Technology decisions (and deviations from the brief)
| Topic | Decision | Reason |
|---|---|---|
| SQLite | `node:sqlite` (built in) instead of `better-sqlite3` | No native build or download is needed; the skill must work in an environment that only has Node. Verified: FTS5, JSON functions, prepared statements, batches of 1,000 per transaction. It prints an ExperimentalWarning on Node 22, which the CLI suppresses. |
| Images | no `sharp`; rendering/scaling with `@resvg/resvg-wasm`, raster images are copied in their original format | `sharp` is a native module. Without any MCP server/Figma API the skill still has to produce screenshots offline; resvg-wasm rasterizes SVG (with embedded PNG/JPEG) in pure WASM. WebP images are copied but cannot be drawn in screenshots. |
| Kiwi | `kiwi-schema` 0.5.0, not `fig-kiwi` 0.0.1 | `fig-kiwi` is unmaintained since 2022; `kiwi-schema` is the reference implementation. The worker uses its per-type decoders to **stream node by node** instead of building one huge object. |
| JSON | `stream-json` 3.x with the JSONC parser | `.pen` allows comments. A token-level state machine keeps only one node in memory. |
| ZIP / compression | `yauzl` (streamed), `node:zlib` (zstd and deflate-raw built in) | `fzstd` not needed on Node 22. |
| Packaging | `tsup` bundles all dependencies into `dist/cli.js` and `dist/fig-worker.js` | The skill needs nothing but Node at runtime. |
| Cache | `<repo>/.design-index/` with its own `.gitignore` and an entry in the repo `.gitignore` | As requested: temporary folder inside the repo, ignored by Git. |
| Screenshot | own offline renderer (approximation) | As requested: independent of Pencil/Figma MCP servers and APIs; no network access anywhere. |

## Measurements
Machine: WSL2, 12 cores, 16 GB RAM, Node 22.21. Ingest = hash + parse + index + analysis. "Peak RSS" = `process.resourceUsage().maxRSS`
including the worker thread. Query columns are the median of three complete runs including Node start-up. Synthetic files were generated from the real ones
with `scripts/gen-pen.mjs` (repeats frames, 25 % base64 images) and `scripts/gen-fig.mjs` (duplicates nodes and images).

| File | Size | Format | Nodes | Ingest | Peak RSS | summary | tree | search | spec | audit |
|---|---|---|---|---|---|---|---|---|---|---|
| real-slides-D.pen | 0.2 MB | pen | 415 | 0.3 s | 87 MB | 122 ms | 130 ms | 128 ms | 153 ms | 181 ms |
| real-design-A.pen | 159 MB | pen | 159212 | 40.2 s | 296 MB | 127 ms | 133 ms | 148 ms | 138 ms | 119 ms |
| syn100.pen | 100 MB | pen | 78720 | 23.2 s | 234 MB | 155 ms | 139 ms | 137 ms | 123 ms | 96 ms |
| syn200.pen | 201 MB | pen | 157709 | 44.0 s | 279 MB | 238 ms | 191 ms | 121 ms | 128 ms | 110 ms |
| syn400.pen | 401 MB | pen | 306503 | 99.3 s | 345 MB | 360 ms | 301 ms | 212 ms | 253 ms | 226 ms |
| real-design-B.fig | 49 MB | fig | 27593 | 14.1 s | 280 MB | 372 ms | 249 ms | 202 ms | 394 ms | 320 ms |
| real-library-C.fig | 37 MB | fig | 186383 | 77.5 s | 608 MB | 325 ms | 343 ms | 283 ms | 595 ms | 221 ms |
| synfig100.fig | 90 MB | fig | 110372 | 35.3 s | 472 MB | 289 ms | 215 ms | 217 ms | 338 ms | 199 ms |
| synfig200.fig | 178 MB | fig | 220744 | 51.6 s | 719 MB | 252 ms | 181 ms | 118 ms | 181 ms | 120 ms |
| synfigcanvas.fig | 78 MB | fig | 827790 | 128.3 s | 1812 MB | 350 ms | 124 ms | 104 ms | 168 ms | 154 ms |

Notes
- **.pen memory does not grow with file size**: 100 MB → 234 MB, 201 MB → 279 MB, 401 MB → 350 MB peak (limit was < 1 GB, no `--max-old-space-size`).
  Only 43 MB of the 159 MB real file is content (the rest is indentation); the file contains no components and no variables.
- **.fig**: `canvas.fig` cannot be streamed byte-wise, the decompressed Kiwi message sits in a worker (zstd output: 24 MB for the 49 MB file, 116 MB for the library file,
  535 MB for the synthetic canvas stress test). The decoded objects do **not** stay in memory: decoding every `NodeChange` and discarding it
  keeps the worker heap at 42 MB (49 MB file) and 103 MB (library, 186k nodes). A full `decodeMessage` needed 1.27 GB heap for the same library file (measured).
  The worker heap limit is therefore only a safety net (`max(2 GB, 40 MB per compressed canvas MB)`, `DESIGN_INDEX_WORKER_HEAP_MB` overrides it); no increase was needed.
  Peak RSS is dominated by the decompressed buffer (about 3.4× its size in the stress test: 1.8 GB for a 535 MB canvas / 830k nodes).
- Images (`images/` in the ZIP, base64 and files next to the `.pen`) go straight to `assets/` with a streaming hash; they never enter the database.
- Ingest time scales linearly (about 0.1-0.2 s per MB for .pen). Timings in this table were taken while other work was running on the machine; the same files
  ingested in 11-22 s (100/200 MB .pen) and 9-24 s (90/178 MB .fig) on an idle machine.
- Every query stays far below 1 s because screens, audit findings, token usage and child counts are precomputed inside SQLite at ingest time.
  Exception to be aware of: `screenshot` needs about 1 s (WASM start, fonts).

## Tests
`npm test`: 18 vitest tests on small generated fixtures (no client data): comments/unknown fields/unknown node types in .pen, streamed data-URI images, hashing/cache skip,
sibling order, budget truncation, token binding and themes, instance expansion, a synthetic raw `fig-kiwi` file and ZIP, corrupt and untested versions, path blobs.
Manual runs against real client files (not part of this repository) and the synthetic 100/200/400 MB files: see the table above.
An end-to-end check implemented four real frames in React and Angular (pixel-identical results, 2.8-11.6 % pixel difference to the offline design render); that material contains client assets and is kept out of this repository.

## Known limits
- `screenshot` is an approximation (auto-layout re-solved for .pen, text measured heuristically, icon libraries and WebP are placeholders, hidden items do not reflow in .fig instances).
- .fig instances from libraries that are not inside the file are drawn as boxes; variant overrides and instance resizing are only partly applied.
- `.pen` schema 2.21 is the documented reference; other versions are read with warnings (2.18 was tested).
- Heuristics (screen detection, purpose, flows, audit) are guesses and are always marked; they exist to produce questions, not facts.
- Client designs stay local, but AI output about them (questions, specs, generated code) has to be reviewed by a person before it is shared with a client.

## Changelog
- **0.1.2**
  - `.fig` corner radius: per-corner values without `cornerRadius` and without the "independent" flag are not drawn (Figma shows them square; 369 nodes in the test export, all 100). Fixes pill-shaped buttons that are rectangular in Figma.
  - `.fig` strokes: per-side widths are read from `borderTopWeight…` / `borderStrokeWeightsIndependent` (was read from wrong field names, which drew a box on all sides). An occurrence whose saved stroke outline is empty has no stroke.
  - `assets export` writes the real shapes of icons inside instances (arrows, digits); `spec` `svg=` names match. Before, these were black rectangles.
  - Explicit variable modes are inherited from frames above the queried frame (as in open-pencil); `spec` prints `$token{#hex}` where a mode changes a token value.
  - `SKILL.md`: reading rules (trust the `→` component over the node name, no `r=` means square corners, `hug` text means no wrapping, `{#hex}` and `svg=` notation).
  - Index schema version 22: re-run `ingest --force` on existing caches.
  - Measured with a small model (same task, 44-point checklist): 0.1.2 runs scored 91/91/91; the earlier 0.1.1 build scored 89 on the same checklist for its best run. Small sample, indicative only.
- **0.1.1**
  - `.fig`: instance overrides now include style changes (text color, size, weight, shared text styles, radius, opacity), "make visible" overrides and boolean visibility properties; swapped-in components are resolved.
  - `spec` shows the content of instances (from the component, with overrides applied) and lists hidden layers and text values it could not place, so a model asks instead of guessing.
  - `search` finds texts that only exist as instance values; `audit` reports hidden layers that contain text and slot-placeholder styling left over from a conversion.
  - `screenshot` reports renderer failures clearly and keeps the SVG.
  - Instance semantics ported from the MIT-licensed open-pencil `packages/fig` reference (https://github.com/open-pencil/open-pencil): overrides addressed by key paths across nested instances, structural overrides (swap) before property overrides, component properties (text, visibility, instance swap, including `symbolIdValue` assignments) with defaults and inheritance, saved derived sizes, explicit variable modes per frame. Re-implemented in `design-index/src/instances.ts`; no runtime dependency.
  - Token resolution honours explicit variable modes (`modes{Collection=Mode}` line in `spec`).
  - Index schema version 21: re-run `ingest --force` on existing caches.
  - Lower peak memory for `.fig` ingest (derived geometry de-duplicated): 49 MB file 366 MB, 37 MB/186k-node file 682 MB, 830k-node stress file 1.9 GB.
  - Project skills: bundle fonts locally, report every deliberate omission.
  - Measured with a small model (3 runs each, same task and 41-point checklist): 0.1.0 scored 61/66/78, 0.1.1 scored 95/85/85. Small sample, indicative only.
  - Known limits: slot-content frames and resize constraints are not implemented; "explicit swap implies visible" is a heuristic.
- **0.1.0** initial release.
