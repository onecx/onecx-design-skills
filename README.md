# design-skills

Skill system that lets an AI agent with a small context window (250k tokens) **read, question and implement large design files**
(`.pen` from Pencil, `.fig` from Figma, tested up to 400 MB) without ever reading the raw file.

```
design-index/             global, framework-neutral skill: CLI `design-query` + SKILL.md + references/
project-skills/react/     copy into <react-repo>/.claude/skills/implement-design/
project-skills/angular/   copy into <angular-repo>/.claude/skills/implement-design/
project-skills/compare-design/  copy into <app-repo>/.claude/skills/compare-design/ (checks a running app against a design, no pictures needed)
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
`npm test`: vitest tests on small generated fixtures (no client data); with `DESIGN_INDEX_FIXTURES=<folder>` also oracle checks against public real Figma exports
(`design-index/tests/fixtures/README.md` lists the downloads and licences). Generated-fixture coverage: comments/unknown fields/unknown node types in .pen, streamed data-URI images, hashing/cache skip,
sibling order, budget truncation, token binding and themes, instance expansion, a synthetic raw `fig-kiwi` file and ZIP, corrupt and untested versions, path blobs,
and the `.fig` field semantics of 0.1.3 (auto-layout defaults, line-height units, shared styles, override breadth, variable bindings, groups, masks, transforms)
and 0.1.4 (mixed text styles and links, uniform instance scale, blend modes, angular/diamond gradients, mask types, Display-P3, explicit modes for numbers/text,
non-unique property definition ids, blobs before nodes), and 0.1.5 (`tests/fig-limits.test.ts`: gradient/image/emoji text ranges, stroke paint blend modes,
auto layout under an explicit variable mode; PR review: full radii, stroke-only overrides, scaled instances under modes and their tokens, paint opacity of
bound colours, differential re-layout, image strokes on lines), `tests/cli.test.ts` (common options before/after the command, `--max-tokens` validation,
`node` budget).
Manual runs against real client files (not part of this repository) and the synthetic 100/200/400 MB files: see the table above.
An end-to-end check implemented four real frames in React and Angular (pixel-identical results, 2.8-11.6 % pixel difference to the offline design render); that material contains client assets and is kept out of this repository.

## Known limits
- `screenshot` is an approximation (auto-layout re-solved for .pen, text measured heuristically, icon libraries and WebP are placeholders, hidden items do not reflow in .fig instances).
- .fig instances from libraries that are not inside the file are drawn as boxes; instance resizing without Figma's saved layout is not re-laid out.
- .fig `screenshot` approximations: angular gradients (a fan of wedges), Figma-only blend modes `linear-burn`/`linear-dodge` (drawn as multiply/screen),
  cap-height trim (cap height taken as 0.7 × font size), a thinner stroke-weight override on an outline icon without a saved outline (drawn at the component weight),
  emoji (yellow placeholder discs: no colour emoji font offline), vector strokes are centred on the outline (Figma's inside/outside alignment is not applied to paths).
  Auto layout under an explicit variable mode is re-solved only where the mode changes a bound gap, padding or size, differentially: children move by what
  the simplified solver predicts from the size/spacing changes, so Figma's saved offsets stay where nothing changed (children keep their saved sizes unless
  they fill; text is not re-measured; wrapping and grid layouts keep their saved positions; baseline alignment of a child whose own size changes is
  treated as start; constraints `pin=` are applied to children outside the flow of a resized frame, rotated children by their unrotated box).
  Display-P3 files: images stay P3.
- `.pen` schema 2.21 is the documented reference; other versions are read with warnings (2.18 was tested).
- Heuristics (screen detection, purpose, flows, audit) are guesses and are always marked; they exist to produce questions, not facts.
- Client designs stay local, but AI output about them (questions, specs, generated code) has to be reviewed by a person before it is shared with a client.

## Changelog
- **0.1.5** — the last three `.fig` limits of 0.1.4.
  - Text ranges with non-solid paints: gradient and image range fills are drawn on the range's `<tspan>` (paint server over the text box) and printed in
    `runs[…color=linear-gradient(…)]` / `color=img(…)`. Emoji: Figma stores one style entry per emoji with an EMOJI paint and the code points, referred to
    only by its saved glyphs; the characters are found by their code points (variation selector included) and marked `emoji` in `runs[…]` (`spec`),
    drawn as a yellow disc instead of a glyph in the text colour (octopus Complex `375:15`, tds-components `1363:4397`). Skin tones, keycaps, tags and
    ZWJ sequences stay one emoji; a character without emoji presentation (⚠, ©, a digit) counts only with an emoji selector or keycap after it.
  - Fix: `characterStyleIDs` hold one id per **code point**, not per UTF-16 unit (Complex `375:16`: 11 ids for "👍 Emojito 🤣", 13 units). 0.1.4 read
    them per UTF-16 unit, which shifted every range after an emoji or other astral character. Ranges are still printed in UTF-16 units of `text=`.
  - Strokes: every stroke paint is drawn (bottom to top: solid, gradient, image), each with its own blend mode, on rectangles, ellipses, per-side borders, lines
    and vectors (fig2sketch google_material_design `0:1020`: two gradient strokes, the second soft-light). Before, only the first solid stroke paint was drawn.
  - Explicit variable modes on layout: a bound `gap`, padding, width/height or min/max size whose mode value differs from the saved one re-lays out that
    auto-layout container (the pen solver's rules on Figma's saved child sizes; hug sizes recomputed, fill children resized) and its auto-layout ancestors;
    everything else keeps Figma's saved geometry. `spec` is unchanged (`gap=$token{24}`).
  - `spec`/`tree`/`node` print Figma's "Auto" line height explicitly as `lh-normal(33px)` (CSS `line-height: normal`; the px value is Figma's computed line pitch: the pitch saved with the text's layout
    (unrounded on older texts, e.g. 65.63px), else the natural line height × font size as Figma rounds it; plain `lh-normal` when the font's metrics are
    unknown, e.g. after an override changed the family; .pen texts without a line height print none), also for ranges with their own size or font, under a variable mode's font size and in scaled instances.
    Before, Auto printed no `lh` at all and a small model guessed `line-height: 1.2` (medium-complex `1:91`: Avenir Next 24, 33 px pitch).
  - Letter spacing carries its unit everywhere (`spec`, runs, classes, `tree`, `node`): `ls0.1px` (was `ls0.1`, which a small model read as em,
    about 15× too wide). Line-height and letter-spacing tokens show their px value like every token (`lh$line-height-sm(20px)`). Font size stays a plain px number, `lh1.429` a unitless multiplier (documented in SKILL.md).
  - Token references carry their value: `fill=$theme-destructive(#ef4444)`, `r=$border-radius-lg(8px)`, `gap=$spacing-2-5(10px)` in `spec`, `tree` and
    `node` (alias chains resolved; in `spec` under the explicit mode in context, which replaces the `$token{value}` notation of 0.1.2-0.1.4). A small model
    had guessed hex values for token names whose value sat behind an alias chain in `tokens`. material3 `49823:12508` spec: 12,982 → 13,303 characters
    (~3,330 tokens); gold-preview `1:1697`: 3,974 characters (~1,000 tokens). `.pen` `$name` references in font fields resolve the same way;
    an alias into another collection resolves in that collection's default mode unless the context sets one; cycles and missing targets print `$name`.
  - Auto line height: the px value prefers the pitch Figma saved with the text (legacy texts keep it unrounded: material3 `53379:35518` 65.63px for a
    197 px three-line box); an override with another font family drops the component font's metrics; a font size under a variable mode and instance
    scale are taken into account.
  - Index schema 26 (re-ingest happens automatically).
  - PR review fixes:
    - Corner radii: the clamp factors come from the original radii (each corner takes the smaller factor of its two sides, CSS-like). 0.1.5 clamped
      the radii in place side by side, so a full radius (`999`) on a square drew four different corners instead of a circle (gold-preview `1:3356`:
      9.5/0.39/0.75/18.5 instead of 14). Affects avatars, pills, badges, toggles in `screenshot`; `spec` prints the token/number as before.
    - Stroke-only vectors (outline icons) ignore fill overrides (paints, `fill: []`, a fill style), like shared fill styles already did: an outer
      instance's `fill: []` no longer wipes the colour an inner owner's stroke override gave the check icon (gold-preview `1:3382`, 30 such overrides;
      nuxtui 13 with non-empty fills).
    - Scaled instances (`uniformScaleFactor`): the accumulated scale is carried down the evaluated tree. Mode values are multiplied by it before they
      are compared with the (scaled) saved numbers and before they are drawn, so a scaled instance under a mode is no longer re-laid out with unscaled
      gaps/paddings/sizes. `spec` prints tokens inside a scaled instance as `$token(8px×0.5=4px)` (token value, scale, drawn value; also font
      sizes, whose `lh-normal(Npx)` is the scaled Figma pitch), documented in the spec header and SKILL.md. nuxtui/gold-preview specs change accordingly.
    - Colour-bound paints with their own paint opacity print `$token(#1a1a1a)/op0.12` (CSS `color-mix(…)`) in `spec`, `tree` and `node` and are drawn at
      that opacity. Figma copies a colour variable's alpha into the paint opacity when it binds it (material3 state layers: token `#1d1b201a`, paint
      opacity 0.1), so the extra factor is the saved colour's alpha over the token's alpha; a plain bound paint prints no `/op` (gold-preview: 126
      spec lines with an own paint opacity, e.g. `$theme-accent-red-4(#fecaca)/op0.2`; 35 at `/op0` = invisible paints that 0.1.5 printed as opaque).
    - Re-layout under an explicit mode is differential: the solver runs on the saved and on the new values and every child moves by the difference,
      so Figma's saved offsets (baseline alignment, anything the solver does not model) stay where nothing changed and following siblings shift only by
      size deltas. Overflowing content of a `center`/`end` container gets a negative offset as in Figma; children outside the flow of a resized frame
      follow their constraints (`MAX`, `CENTER`, `STRETCH`, `SCALE`).
    - Image and gradient strokes on lines paint over a box at least as thick as the stroke (a horizontal line had `<pattern height="0">`: not drawn).
    - `.pen` `lineHeight` tokens are multipliers: `lh$lh-body(1.5)` (was `1.5px`) in `spec`, `tree` and `node`.
    - CLI: `--file`, `--json`, `--max-tokens` work before and after the command (`design-query --max-tokens 6000 node <id>`, also `--max-tokens=N`);
      `--max-tokens` must be a positive integer (digits only, else a usage error naming the option, exit code 1; `abc`, `0`, `-5` were accepted as
      NaN/0 budgets); `--file`/`--max-tokens` with `ingest` are rejected in either position. Nested scaled instances print `scale=0.5(total=0.25)`
      (tokens use the total); full radius tokens (≥ half the short side, e.g. 999) print without `×F`. The differential re-layout computes every
      shift from the saved position, so a child placed twice (fill width settled after its hug parent grew) is not shifted twice.
    - `node` honours `--max-tokens`: its field limits (text 600, component props 300, description 160, raw JSON 700 chars, 8 interactions, 5 notes at
      the default 2,000 tokens) grow with the budget, `raw` takes most of it; a cut field ends in `…` and a hint names the budget that shows it in full
      (`→ raw truncated (700 of 1391 chars): node 1:1871 --max-tokens 3000`). Before, `--max-tokens 50000` printed the same cut raw JSON, cut mid-object
      without a hint. `components` and `notes` mark their cut props/descriptions with `…` too.
- **0.1.4** — the `.fig` findings 0.1.3 left open (same research report).
  - Mixed text styles: `characterStyleIDs` + `styleOverrideTable` become ranges (`runs[6-9 "big" w700 underline color=… link=…]` in `spec`, one
    `<tspan>` per range in `screenshot`), including each range's own text/fill style (material3 link ranges are purple via "M3/sys/light/primary",
    open-peeps headings bold). Hyperlinks per text and per range (`link=<url>` / `link=#<node-id>`); `leadingTrim: CAP_HEIGHT` → `trim=cap`.
  - Instances: `uniformScaleFactor` scales the instance content (sizes, positions, strokes, radii, effects, font sizes, gaps, paddings) before Figma's
    saved derived data; property-definition ids, which are not unique in a document, are resolved within the component's own ancestry (defaults and
    property names); bound texts and numbers resolve under the nearest explicit variable mode (`r=$radius{12}`, also inside instances).
  - Paints: layer and paint blend modes (`blend=multiply`, `paint|multiply`, drawn with `mix-blend-mode`); `stackReverseZIndex` paint order (`z-reverse`);
    angular gradients drawn as a sweep from the first handle (clockwise) and diamond gradients as L1 bands (`conic-gradient(…)` / `diamond-gradient(…)` in `spec`).
  - Masks: OUTLINE (shape only) and LUMINANCE (luminance × alpha) besides ALPHA; frame clips inside a mask are drawn as pattern fills (resvg dropped clipped
    layers whose content reaches far outside the canvas).
  - Display-P3 documents: colours are converted to sRGB everywhere (hex, tokens, rendering; embedded images stay P3); `spec`, `summary` and `tokens` say so.
  - Scaled instances print `scale=F` (values below are already scaled). Explicit variable modes match by collection and mode name.
  - Kiwi: geometry blobs that come before the nodes in the message are read in a second pass. An instance that detaches a fill style without paints of
    its own shows the layer's own paints; a heavier stroke-weight override on an outline icon without a saved outline widens the outline.
  - Index schema 24 (re-ingest happens automatically). nuxtui (82 MB) ingest unchanged: 37-39 s, peak 1.25-1.26 GB (0.1.3: 38 s, 1.44 GB).
- **0.1.3** — `.fig` field semantics checked against what Figma itself saved in 31 real files (laid-out sizes, saved glyph fonts, outlines); see the research report referenced in the PR.
  - Auto layout: a missing `stackPrimarySizing` means **hug** (hug buttons/chips were reported fixed); missing right/bottom padding is 0 (was mirrored);
    `SPACE_EVENLY` is Figma's space-between (`jc=between`, gap ignored, a single child is centred); `SPACE_AROUND`/`SPACE_EVENLY_CSS` → `around`/`evenly`;
    `GRID` frames are `grid` (children keep their saved positions) instead of a column.
  - Text: line height `{100, PERCENT}` is the font's normal line height (no `lh`, was `lh1`), `RAW` is a multiplier (was dropped), other percentages are
    relative to the font's natural height. Text case, vertical alignment, truncation (`truncate lines=N`), list markers (`list=`) are printed; "Italic" is weight 400;
    Figma's saved font weight wins.
  - Shared styles: `styleIdForText/Fill/StrokeFill/Effect` are resolved on every node and override (the style wins over stale inline values; style names are
    printed as `styles{…}`). Example: material3 texts drawn in Roboto were reported as "Google Sans Text".
  - Instance overrides: every override with a rendering field is kept (size-only, fill/stroke style swaps, stroke weight/align/dash, border sides, per-corner radii,
    opacity, effects, text fields, auto-layout fields, variable bindings); absent fields inherit. A stroke colour override on an outline icon recolours the outline
    (was drawn in the component colour); saved instance outlines are used unscaled, including stroke outlines.
  - Variable bindings on numbers and text (`variableConsumptionMap` + `parameterConsumptionMap`): `gap=$token`, `pad=$token`, `r=$token`, font tokens, `width=$…`;
    text bound to a variable shows the variable's value (binding beats stale literal overrides, a bare entry clears it). Component-property refs and defaults of newer
    files (`PROP_REF`, `varValue`) are read; slot content is expanded.
  - Corners: the independent flag decides (absent corner = 0); no `r=` on vectors. Groups (`FRAME` + `resizeToFit`) are `group` and never clip.
    Masks are marked (`mask`) and clip the following siblings in `screenshot`. Mirrored nodes keep their matrix (`flip=x|y`, `visual@…`); `rot` is documented
    (counter-clockwise about the top-left origin); rotated vectors export inside their bounds. Constraints of absolutely positioned layers are printed (`pin=…`).
  - Renderer/spec: per-region vector fills and winding rules, ellipse arcs and polygon counts from Figma's outlines, gradient direction and stops as CSS,
    image crop (Kiwi `STRETCH`) and image opacity, dash patterns; unknown effect types (noise, grain, …) are ignored instead of becoming a blur; slices are
    not listed; text on a path is extracted; `fig-deck` files are accepted (with a warning) and the header versions decoded in the real-file checks (1, 2, 3, 4, 10, 15, 20, 25, 48, 63, 80, 87, 101, 106) no longer warn; other versions still do.
  - Tests: synthetic fixtures now use Figma's own field names and omissions (`tests/fig-semantics.test.ts`); optional oracle checks against real exports
    (`tests/real-files.test.ts`, download list in `design-index/tests/fixtures/README.md`; no `.fig` file is committed).
  - nuxtui (82 MB, 313k nodes): ingest 29–34 s → 34–38 s, peak RSS 1.21 GB → 1.25–1.48 GB (run-to-run spread; worker heap at end of stream 290–470 MB). The extra work is the
    style/variable resolution after the stream; second-pass statements are now prepared once.
  - Index schema version 23: re-run `ingest --force` on existing caches.
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
