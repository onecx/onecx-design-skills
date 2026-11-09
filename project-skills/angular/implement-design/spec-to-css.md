# spec-to-css (Angular): turn `design-query spec` output into code

Read this BEFORE you translate the first spec. Rules are mechanical: apply them literally. Component styles (`styleUrl`, emulated
ViewEncapsulation; SCSS or CSS as recorded in `conventions.md`) hold the CSS; the values below are the same in every
styling approach (Tailwind: use the matching utilities or arbitrary values `p-[32px]`).

## 1. Notation -> CSS (verified against the CLI)
Size term order is **WIDTH x HEIGHT**: `fill×hug(542)` = width fill, height hug (542 is the height, NOT the width).

| spec | CSS |
|---|---|
| `W×H` plain number | `width:Wpx; height:Hpx` on that element only (fixed). `×` is never "times" |
| `fill` in main axis, row parent (width) | `flex:1; min-width:0` (without `min-width:0` nowrap/truncated text overflows) |
| `fill` in main axis, col parent (height) | `flex:1; min-height:0` |
| `fill` in cross axis of parent (`row`: height, `col`: width) | `align-self:stretch` |
| fixed-size root (`W×H`) | exactly the spec W×H; `hug`/fixed children `flex-shrink:0`; if their sum exceeds the root, record the overflow in `design-progress.md` |
| `hug` element | never `height`/`min-height`/`max-width`; no `margin:auto`/`max-width` unless in the spec |
| `fill` in a parent without `row/col` | `width:100%` / `height:100%` |
| `hug` / `hug(N)` | set NO size in that axis; N is only the value to verify. Frame `hug(W)` width in a block parent: `width:fit-content` (WRONG: `width:Wpx` / `max-width:Wpx`) |
| text with `hug(N)` width | `white-space:nowrap` |
| `row` / `col` | `display:flex; flex-direction:row\|column`. Missing `ai=` means **flex-start**: always write `align-items:flex-start` (a hug child must not be stretched, not even the clickable area) |
| `gap=G` | `gap:Gpx` (never margins) |
| `pad=a` | `padding:apx` |
| `pad=a,b` | `padding-block:apx; padding-inline:bpx` (a = top and bottom, b = left and right) |
| `pad=t,r,b,l` | `padding:t r b l` (px) |
| `jc=between\|around\|evenly\|center\|end` | `justify-content:space-between\|space-around\|space-evenly\|center\|flex-end` (absent = flex-start) |
| `ai=center\|end\|baseline\|stretch` | `align-items:center\|flex-end\|baseline\|stretch` |
| `wrap` | `flex-wrap:wrap` |
| `grid` | `display:grid`, children placed from `@x,y` |
| `valign=center` | flex column + `justify-content:center` in a fixed-height box |
| no `row`/`col` but `children-abs` | `position:relative`; each child `position:absolute; left:x; top:y` (pins below) |
| `abs` on a child of a `row/col` | `position:absolute` inside the `position:relative` parent |
| `@x,y` (only inside `children-abs`, `grid`, `group`, or on an `abs` child) | `left:xpx; top:ypx`. Elsewhere ignore it |
| `pin=right\|center-x\|left+right\|scale-x` / `bottom\|center-y\|top+bottom\|scale-y` | right/bottom: `right:(parentW-x-w)px`; `left+right`: set left and right; `center-*`: `left:50%; translate`; `scale-*`: the layer grows with the parent, but an `svg=` glyph keeps its own W×H (see icons) |
| `r=R` / `r=tl,tr,br,bl` | `border-radius:Rpx` / `border-radius:tl tr br bl`; no `r=` = square. Same value on many boxes: ONE class or token |
| `clip` | `overflow:hidden` |
| `stroke=C/W/inner` | **keep the box size**: `outline:Wpx solid C; outline-offset:-Wpx` (draws above children, follows `border-radius`). NEVER `border` for `stroke=` (adds 2W) |
| `stroke=C/W/center` (also `stroke=C/W` with no align) | `outline:Wpx solid C; outline-offset:-(W/2)px` (half inside, half outside; no size change) |
| `stroke=C/W/outer` | `outline:Wpx solid C` (offset 0) |
| `stroke=…/W/…/dashN,M` | `outline-style:dashed` |
| `fx=shadow(x,y,blur[,spread],C)` | `box-shadow:xpx ypx blurpx [spreadpx] C` (colour is last); `inset-shadow(…)` = `box-shadow:inset …` |
| `fx=blur(r)` / `bgblur(r)` | `filter:blur(r/2 px)` / `backdrop-filter:blur(r/2 px)` |
| `fill=$a-b(#hex)` | `background:var(--a-b)` (text: `color=` -> `color:var(--a-b)`); the hex only if the token does not exist |
| `$a-b(#hex)/op0.12` | `color-mix(in srgb, var(--a-b) 12%, transparent)` (never drop `/op`) |
| `fill=$t+img(a.png[,contain\|crop\|tile][,opN])\|mode` | on THAT element: `background-color:var(--t); background-image:url(<imported asset>); background-size:contain; background-repeat:no-repeat; background-position:center; background-blend-mode:mode` (no mode = `cover`; `crop` = `background-size:100% 100%`; `tile` = `repeat`). Angular: file under `public/` (or `assets` per `angular.json`), referenced by its built URL. `<img>` must have naturalWidth>0 (check.mjs) |
| `fill=linear-gradient(…)` | copy verbatim into `background:` |
| `op=0.5` / `blend=multiply` | `opacity:.5` / `mix-blend-mode:multiply` |
| `font=…/center` or `/right` (or `/justify`) | `text-align:center` / `right` / `justify`; absent = `start` |
| `font=F/S/wW/lhL/lsX` | `font-size:Spx; font-weight:W; line-height; letter-spacing`; set `font-family` and `color` ONCE on the component root, children inherit. If `styles{text:"<style name>"}` is shown and grepping the token file for that style name finds text tokens, use those, else the literal numbers |
| `font` family | `font-family: var(--<family token from spec>), system-ui, sans-serif` (WRONG: `var(--<token>, Roboto, sans-serif)`: the fallback is ignored once the token exists); install the family named in `font=` (e.g. `@fontsource/roboto` listed in the `angular.json` `styles` array, or a local file) and import only the weights used |
| font weight | numeric from `wW` (no `w` = 400). Token values like `SemiBold` are invalid CSS: 400 Regular, 500 Medium, 600 SemiBold, 700 Bold |
| `lh-normal(29px)` / `lh-normal` | `line-height:normal` (use `29px` only if your font differs and the height must match); `lh1.4` = `line-height:1.4`; `lh$x(20px)` = `var(--x)` |
| `ls0.1px` | `letter-spacing:.1px` |
| `underline` / `line-through` (in `font=`) | `text-decoration:underline\|line-through` |
| `case=upper\|lower\|title` | `text-transform:uppercase\|lowercase\|capitalize` |
| `truncate` / `truncate lines=N` | `overflow:hidden; text-overflow:ellipsis; white-space:nowrap` / `-webkit-line-clamp:N` with `display:-webkit-box; -webkit-box-orient:vertical` |
| `rot=D` | `transform-origin:0 0; transform:rotate(-Ddeg)` |
| `text="a\nb"` | `\n` = hard line break, keep it: `white-space:pre` (hug width) or `pre-line` (fill width, wraps too); never combine with `nowrap`; with the string holding real newlines (Angular: `{{ 'Build\nBeautiful\nProducts' }}` or a `title = 'Build\nBeautiful\nProducts'` field) or one `<br>` per line. WRONG: joining the lines into one |
| `runs[i-j "x" …]` | `<span>`/`<a>` around chars i to j with only the listed differences |
| `link=#55595:3789` | node id of the design, NOT a URL. Map it to the app route; unknown: pick a route, write it into `design-progress.md`, never put `#id` in `href`. `link=https://…` is a real `href` |
| `svg=assets/x.svg` | icon: copy the exported file's `d=` VERBATIM (see "Icons") |
| `.sN` | style repeated in the file: ONE shared CSS class (`.sN` text is printed once in the header lines) |
| `→Comp[Variant]` | the code component from `component-map.json`, variant axes -> props |
| `$x` bound token | `var(--x)` through the short component-level property (phase C) |

### Icons
- Frame `Arrow 24×24` with child `Vector 16×16 @4,4 svg=…`: component box = **24×24**, glyph stays **16×16**. Use
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">` with `padding:4px;
  box-sizing:content-box; flex:none` (= `@4,4`). Never scale the SVG to the frame, never `pin=scale-*` it.
- Take the `d=` of every `svg=` verbatim from `design-query assets export`. A glyph at `@x,y` inside a W×H icon frame = `viewBox="0 0 W H"` with the glyph placed there, or padding. NEVER draw/retype/simplify an icon.
- Single-colour icons: inline SVG with `currentColor` (colour follows the text token). Decorative: `aria-hidden="true"`
  (or `alt=""` for `<img>`). Several `svg=` files with identical path data = ONE icon component.
- A frame with SEVERAL `svg=` children (logo) = ONE asset: `design-query assets export <id of the frame that contains the svg= lines> --out <dir>` writes `logo-<id>.svg` (all shapes combined) plus the single vectors. Use the combined file as `<img src alt="">` or inline it VERBATIM. WRONG: retyping/guessing `d=` data, using only the first path. Check: rendered shape count = number of `svg=` lines.

## 2. Procedure
### 0. Coverage and loop (BEFORE coding)
1. `design-query tree <id> --depth 2`: list EVERY visible node as `node-id | name | selector | status (done / skipped + reason)` in `design-progress.md` (PROJECT ROOT). Row count = number of node lines `tree` printed, excluding lines ending `(hidden)`. `pending` is not done; "IMPLEMENTED"/"Complete" only when all rows are `done`.
2. For each depth-1 child, in order: `design-query spec <child-id>`, implement it, run its check rows (section 4), then the next. Where a spec shows "… N children", run `tree`/`spec` on that node. Never stop after the first child.
3. No placeholders: images only from `assets export`, texts only from `text=`; no external URLs, no added copy. Layer/frame names (quoted, e.g. "Image", ".Lib/Comp") are NEVER rendered as text.
4. Every term belongs to the element of its OWN spec line: never move a fill/stroke/radius to a parent or fake it with `inherit`; a modifier goes on the element whose line holds the differing ai/jc/gap/fill. Per `→Comp` instance diff `font=`, `gap`, `pad` term by term. Write only values the spec shows (no `w` = 400, no `gap` = none); never flatten a frame with `pad`. Text with `hug` width: no size, `nowrap`, never `flex:1`.

### A. Inventory first (before any CSS)
1. `grep -rn "selector:" src/app` and list the component files: existing components (`app-card` ...) with their `input()`s and `ng-content` slots.
2. Open the global stylesheet(s) (`styles.scss`, `styles/_base.scss` ...): list its utility classes (layout/surface helpers) and record them.
3. Open the token file and the custom properties the component styles read (`var(--card-…, fallback)`).
4. Write 5 lines into `conventions.md` section "Existing CSS" (utilities, components + their properties, naming scheme, where new CSS goes).

### B. Map frames (one table in your reply before coding)
| design frame | decision |
|---|---|
| matches an existing component (`→Comp`, or same structure) | reuse its selector; set differences through ITS custom properties (`--card-header-pad` …) on the new component's `:host` (custom properties cross the encapsulation), never `::ng-deep` / overriding its selectors |
| has an existing utility (`row`/`col` + gap -> the layout class in conventions.md -> Existing CSS) | use the class, add only the delta (gap, ai, pad) |
| component lacks a property you need | in the component's OWN scss file replace the hard value by `var(--x, <old value>)` (default unchanged); design variant axes/properties -> `input()`s (`input.required<string>()`), slots -> `<ng-content />` |
| frame repeats (same name or identical children, 2x or more) | ONE component with inputs, rendered over a data array with `@for`; no copy-pasted blocks in the page; a screen with repeated parts gets its own child component, not everything in `app.html` |
| single child and no fill/stroke/r/fx/pad of its own | **flatten**: no element for it |
| new | new standalone component (`styleUrl`, `imports`, `input()`/`output()`) with BEM classes `block__element--modifier` (what conventions.md records); modifiers via `[class.block--x]="x()"`; host gets `:host{display:block}` |

**Variant table (when the target shows several instances of one component, write it BEFORE coding).** One row per instance: its `→Comp[axis=value…]` and the root line (W×H, row/col, pad, gap, ai, jc) plus its child frames.
| rule | do |
|---|---|
| axis | each axis = one prop of the component (named in `component-map.json`; every prop named there must exist in the component's API; update the map when you add a component) |
| value | each axis value = ONE modifier class (`alert--info`, `alert--wide`, set via `[class.alert--x]="…"`) that sets only what differs, through custom properties (`--alert-pad`, `--alert-dir`). One modifier per axis value; no combined selector chains (`.a.b .c`) |
| source | never derive a variant from content (text with `\n`, presence of an action) |
| per-variant DOM | child frames can differ per variant: render the frames each variant has; never flatten a frame with pad/gap/jc/ai; do not copy pad from one variant to the others, diff every instance |
| check | every instance's root line equals the CSS of its modifier combination (self-check, section 4) |
Example row: `→Alert[type=info,size=wide]` \| `fill×hug(72) row pad=16,24 gap=8` \| `alert--info alert--wide`

New CSS goes into the component's own `.scss` only (never `styles.scss`/base partials). One new class per distinct style; do not repeat `display:flex` /
`border-radius`: use the utility or one custom property. Semantic HTML: list = `ul/li`, menu = `nav`, action = `button`,
navigation = `a`, titles `h1-h3`, `section`/`header`.

### C. Write CSS (modern, small), in this order
1. Containers: use the utility classes recorded in conventions.md -> Existing CSS for `row`/`col`; if none exist, one small flex class per block (WRONG: rewriting `display:flex; flex-direction`). Add `align-items:flex-start` whenever the spec has no `ai=` (else headings/links stretch); `ai=` present: use it.
2. Sizes per the table; spacing `gap`/`padding-block`/`padding-inline` (logical properties, never margins for spacing).
3. Colours/typography from tokens, declared ONCE (not per element): `font-family`+`color` on the component root; `color-mix()` for `/opA`; custom properties for everything a variant changes.
4. Keep `<main>`/semantic elements of the base project; semantic HTML for the rest. `<button>`: `type="button"` + `font:inherit; color:inherit; border:0; background:none`; status messages `role="status"`; icon-only buttons `aria-label`.
5. Write only properties a spec term maps to. No `hyphens`, `word-break`, `text-wrap`, `@media`, `max-width`, `transition` etc. unless the spec or `design-decisions.md` asks. `clamp()`/container queries only for implied responsiveness; nesting only if the project uses it.
6. Tokens: the generated file contains all modes (large); the CLI has no mode option. Generate once (`design-query tokens --format css --out src/styles/tokens.generated.css`), keep that name and path, never edit/rename it, register it once at the location recorded in conventions.md; NEVER `@use` it in `styles.scss`, never edit global `styles.scss`. Components read only the tokens the spec names, via short properties (`--card-header-bg: var(--<token from spec>)`). Extra-mode `[data-…]` blocks are inert until the attribute is set.
7. Roles, scope, hooks: pick a token by ROLE (page title, section heading, group heading ...) from the spec's style name, never by looks, and record the role -> token map in conventions.md. A theme/mode declares only real overrides of its base (never paste a full token block twice). Scope product-specific selectors to the owning root class; an unscoped override of a component-library class leaks into neighbouring UI (shell, micro-frontends, other design systems): check each selector's reach. Style third-party/other-module components only through documented hooks; if none exist, record the dependency on its private markup in conventions.md and verify it. Presentation lives in named style rules, never in `[style]`/`style=` for static values; inline only for genuinely dynamic values.

## 3. Worked example: frame 53379:35528 (`spec` abridged)
```
"System Overview Card" frame fill×hug(542) col stroke=$schemes-outline-variant(#cac4d0)/1/inner r=24 clip
  "Header Container" frame fill×hug(106) col gap=4 pad=32,36 fill=$schemes-surface-container-highest(#e6e0e9)
    "Styles" text fill×hug(42) text="Styles" color=$schemes-on-surface font=Roboto/36/w700/lh-normal(42.19px) case=title
  "Body Container" frame fill×hug(436) col gap=20 pad=36 fill=$schemes-surface-container(#f3edf7)
    "Link to Component(s)" frame hug(110.95)×hug(28) row gap=4.95 ai=center      (x8, different labels)
      "Avatars" text hug(82)×hug(28) link=#55595:3789 .s1   (.s1 = font=Roboto/24/lh-normal(28.13px)/underline, colour on-surface)
      "Arrow" frame 24×24 children-abs clip
        "Vector" path 16×16 @4,4 pin=scale-x,scale-y svg=…   (8 identical svgs -> 1 icon)
```
Decisions: card = existing `app-card` (BEM, `--card-*` properties); header = `card__header` + `h2` (single child, no wrapper); link row = `.cluster` + new `app-arrow-link` (8 identical svg = 1 icon, 24px frame = padding of the 16px glyph); body `col` without `ai=` -> `align-items:flex-start` via `--card-body-align`; inner stroke -> `outline` with negative offset.

`card.scss` (only the hard values became properties, defaults unchanged; `:host{display:block}` added):
```scss
:host { display: block; }
.card { outline: 1px solid var(--card-border, #ccc); outline-offset: -1px; }
.card__header { padding: var(--card-header-pad, 16px 20px); background: var(--card-header-bg, #eee); }
.card__header h2 { margin: 0; font-size: var(--card-title-size, 20px); font-weight: var(--card-title-weight, 700); text-transform: var(--card-title-case, none); }
.card__body { padding: var(--card-body-pad, 20px); gap: var(--card-body-gap, 12px); align-items: var(--card-body-align, stretch); background: var(--card-body-bg, #f7f7f7); }
```
`system-overview-card.scss` (the whole delta; variation = custom properties on `:host` only):
```scss
:host {
  display: block;
  --radius-card: 24px;                      // r=24 on .surface
  --card-border: var(--schemes-outline-variant);
  --card-header-bg: var(--schemes-surface-container-highest);
  --card-body-bg: var(--schemes-surface-container);
  --card-header-pad: 32px 36px;             // pad=32,36
  --card-body-pad: 36px;  --card-body-gap: 20px;  --card-body-align: flex-start;
  --card-title-size: 36px;  --card-title-weight: 700;  --card-title-case: capitalize;
  --arrow-link-color: var(--schemes-on-surface);
  color: var(--schemes-on-surface);
  font-family: var(--static-font-brand), system-ui, sans-serif;
  line-height: normal;
}
```
`system-overview-card.ts` (standalone; `links` = labels + routes, `link=#node-id` mapped to routes and recorded in `design-progress.md`):
```ts
@Component({ selector: 'app-system-overview-card', imports: [Card, ArrowLink], styleUrl: './system-overview-card.scss',
  template: `<app-card title="Styles">@for (l of links; track l.to) { <app-arrow-link [href]="l.to">{{ l.label }}</app-arrow-link> }</app-card>` })
export class SystemOverviewCard { readonly links = [{ label: 'Avatars', to: '/styles/avatars' } /* … 8 */]; }
```
`arrow-link.ts` (`href = input.required<string>()`) and `arrow-link.scss`:
```ts
template: `<a class="arrow-link cluster" [href]="href()"><ng-content />
  <svg class="arrow-link__icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 16L6.575 14.6L12.175 9L0 9L0 7L12.175 7L6.575 1.4L8 0L16 8L8 16Z" /></svg></a>`
```
```scss
:host { display: block; }
.arrow-link { gap: 4.95px; color: var(--arrow-link-color, inherit); font-size: 24px; line-height: normal; white-space: nowrap; text-decoration: underline; }
.arrow-link__icon { flex: none; box-sizing: content-box; padding: 4px; }  // 16px glyph in 24px box
```
Font: `npm i @fontsource/roboto`, add `@fontsource/roboto/400.css` and `700.css` plus `src/styles/tokens.generated.css` to the `styles` array in `angular.json`.

## 4. Self-check (REQUIRED, do not finish without it)
Serve the app (`npx ng serve --port 4175`). `check.mjs` ships in this skill folder: NEVER retype or copy-edit it. Needs `playwright` in the project (`npm i -D playwright && npx playwright install chromium`; a dev dependency, so ask the user first; it resolves from the project's `node_modules`).
1. Write `expect.json` into the PROJECT ROOT (keep it, with `check-output.txt`; delete only other scratch files). One entry per coverage row with status `done` that has a selector (flattened/skipped rows need none); the coverage count excludes `tree` lines ending `(hidden)`; fewer entries = check NOT passed. ROOT included. Every `w`/`h` is copied from the spec, never from a measurement; omit `w`/`h` for `fill` and `hug`. Example: `[{"sel":".card","w":662,"h":542}, {"sel":"h2","fontWeight":"700","textAlign":"center","bg":"rgb(230, 224, 233)","bgImage":true,"texts":["Styles"]}]` (`bg` = computed `rgb(r, g, b)` text, hex converted, alpha -> `rgba(r, g, b, a)`). `texts` = every `text=` value: compared per element (`<br>`/runs fine); other on-screen text (layer name) fails, a `texts` entry not on screen fails (placeholder/value do not count).
2. `node <skill folder>/check.mjs <url> expect.json > check-output.txt`. It prints PASS/FAIL per row (2px tolerance), `loaded fonts:`, `RESULT: N/M PASS`, exit 1 on any FAIL, NOT FOUND, stray text, `texts` entry missing, `<img>` with naturalWidth 0, or an empty expect array.
3. Attach the WHOLE `check-output.txt` untrimmed in `design-progress.md` (project root). Never retype, shorten or add measured values, no `~`; a hand-written table is a failure. Fix every FAIL until `RESULT` is M/M.

| check | expected |
|---|---|
| `hug(N)` height | N ±2px; `hug` width = text width (not `parentW`) |
| `fill` width | = `parentW` |
| `RESULT` | M/M PASS (root within 2px of spec W×H; NOT FOUND = not done) |
| first text x-offset / padding | `pad` inline value; `pad=a,b`: top = a, left = b |
| glyph / icon box | glyph = vector W×H; icon box = frame W×H |
| text `lines` | = number of `\n` + 1; height ≈ `hug(N)` |
| `loaded fonts` | contains the design family and the weights used (not only system fonts) |
| instances | every instance's root line (W×H, pad, gap) equals its row in the variant table |
| shapes of a logo | rendered shape count = number of `svg=` lines |
| `grep -rn 'http\|href="#\|src="data:\|url(data:' src` | no external URLs, no `#<node-id>`, no inlined `data:` images; no strings absent from `text=` |
| role tokens | headings/controls of the same kind use the token recorded for their role in conventions.md |
| selector reach | every new selector starts at the component/product root class; no bare library class selectors |
| static inline style | `grep -rn '\[style\|style="' src/app`: only dynamic values |
| document language | `<html lang>` = language of the default-rendered content |
| semantics | navigation = `a`/router link (real `href`), actions = `button`; no inert buttons; Tab reaches them and Enter (link, button) / Space (button) activates them |
| new CSS | `grep -n 'display: *flex' <new css>`: every hit justified (containers = recorded utility + delta, or one small flex class per block); no `border` for strokes (size = spec W×H); every element has a design frame or semantic reason; no repeated `border-radius`; typography declared once; no scratch scripts (`measure.mjs` ...) in the project; `git diff --stat` shows no global/token file edited; no `::ng-deep` |
