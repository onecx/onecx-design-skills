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
| `stroke=C/W/inner` | **keep the box size**: `outline:Wpx solid C; outline-offset:-Wpx` (draws above children, follows `border-radius`) or `box-shadow:inset 0 0 0 Wpx C` (frame without opaque children). Never `border` (adds 2W to the size) |
| `stroke=C/W/center` | `outline:Wpx solid C; outline-offset:-(W/2)px` (half inside, half outside; no size change) |
| `stroke=C/W/outer` | `outline:Wpx solid C` (offset 0) |
| `stroke=…/W/…/dashN,M` | `outline-style:dashed` (or `border-style:dashed` if the box may grow) |
| `fx=shadow(x,y,blur[,spread],C)` | `box-shadow:xpx ypx blurpx [spreadpx] C` (colour is last); `inset-shadow(…)` = `box-shadow:inset …` |
| `fx=blur(r)` / `bgblur(r)` | `filter:blur(r/2 px)` / `backdrop-filter:blur(r/2 px)` |
| `fill=$a-b(#hex)` | `background:var(--a-b)` (text: `color=` -> `color:var(--a-b)`); the hex only if the token does not exist |
| `$a-b(#hex)/op0.12` | `color-mix(in srgb, var(--a-b) 12%, transparent)` (never drop `/op`) |
| `fill=linear-gradient(…)` | copy verbatim into `background:` |
| `op=0.5` / `blend=multiply` | `opacity:.5` / `mix-blend-mode:multiply` |
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
6. Tokens: the generated file contains all modes (large); the CLI has no mode option. Generate once (`design-query tokens --format css --out src/styles/tokens.generated.css`), keep that name and path, never edit/rename it, register it once as recorded in conventions.md (Vite: `src/main.tsx`; Angular CLI: `angular.json` `styles`; Nx: `project.json`); NEVER `@use` it in `styles.scss`, never edit global `styles.scss`. Components read only the tokens the spec names, via short properties (`--card-header-bg: var(--<token from spec>)`). Extra-mode `[data-…]` blocks are inert until the attribute is set.
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
Measured in Chromium (662px wide): card 662×542, header 106, body 436, link rows 28px, title x 36px, font Roboto; matches the reference.

## 4. Self-check (REQUIRED, do not finish without it)
Serve the app (`ng build`, then serve `dist/<app>/browser` (`npx http-server dist/<app>/browser -p 4175`)), save as `check.mjs` in a scratch dir (not in the project; delete it after pasting the table), fill `EXPECT` (selector: size term of the spec), run `node check.mjs <url>` where `playwright` resolves. Paste the printed table into `design-progress.md`; fix every row that deviates.
```js
import { chromium } from 'playwright';
// one entry per spec node/instance: [selector, size term from spec, expected [x,y] of the first text/child inside it (= its pad)]
const EXPECT = [['.card', 'fill×hug(542)'], ['.card__header', 'fill×hug(106)', [36, 32]], ['h2', 'fill×hug(42)'], ['a', 'hug(110.95)×hug(28)']];
const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1000, height: 800 } });
await p.goto(process.argv[2]); await p.waitForTimeout(500);
const { rows, fonts } = await p.evaluate((E) => ({ fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight),
  rows: E.flatMap(([sel, exp, off]) => [...document.querySelectorAll(sel)].length === 0 ? [{ el: sel, size: 'NOT FOUND', expect: exp }] : [...document.querySelectorAll(sel)].map((e, i) => {
    const r = e.getBoundingClientRect(), q = document.createRange(); q.selectNodeContents(e);
    const lines = new Set([...q.getClientRects()].map((x) => Math.round(x.top))).size;
    const c = [...e.children][0] ?? e, cr = (c === e ? q : c).getBoundingClientRect();
    return { el: `${sel}[${i}]`, size: `${r.width.toFixed(1)}×${r.height.toFixed(1)}`, expect: exp, parentW: e.parentElement.getBoundingClientRect().width.toFixed(1),
      lines, firstXY: `${(cr.x - r.x).toFixed(1)},${(cr.y - r.y).toFixed(1)}`, wantXY: off ? off.join(',') : '' };
  })) }), EXPECT);
console.table(rows); console.log('loaded fonts:', fonts.join(', ')); await b.close();
```
EXPECT holds ONE entry per instance (every variant) and per button/child whose offset the spec fixes; `firstXY` = x,y of the first child (else first text) inside the element, compare it to `pad`; `lines` is meaningful for text only. Fonts: bundle the family named in the design (npm font package or local file) and import it; the declared `font-family` is no proof, `loaded fonts` is. **Finishing without the pasted table, or writing "matches exactly" over a failing row, is a failure.** Pass criteria:
| check | expected |
|---|---|
| `hug(N)` height | N ±1px; `hug` width = text width (not `parentW`) |
| `fill` width | = `parentW` |
| first text x-offset / padding | `pad` inline value; `pad=a,b`: top = a, left = b |
| glyph / icon box | glyph = vector W×H; icon box = frame W×H |
| text `lines` | = number of `\n` + 1; height ≈ `hug(N)` |
| `loaded fonts` | contains the design family and the weights used (not only system fonts) |
| instances | every instance's root line (W×H, pad, gap) equals its row in the variant table |
| shapes of a logo | rendered shape count = number of `svg=` lines |
| box with stroke | size = spec `W×H` (no +2px) |
| `grep -n 'href="#' src` | no `#<node-id>` |
| role tokens | headings/controls of the same kind use the token recorded for their role in conventions.md |
| selector reach | every new selector starts at the component/product root class; no bare library class selectors |
| static inline style | `grep -rn '\[style\|style="' src/app`: only dynamic values |
| document language | `<html lang>` = language of the default-rendered content |
| semantics | navigation = `a`/router link (real `href`), actions = `button`; no inert buttons; Tab reaches them and Enter (link, button) / Space (button) activates them |
| wrappers | every element has a design frame or a semantic reason |
| new CSS | `grep -n 'display: *flex' <new css>`: every hit justified (containers = recorded utility + delta, or one small flex class per block); no repeated `border-radius`; typography declared once; no scratch files (`check.mjs`, `measure.mjs` ...) left in the project; `git diff --stat` shows no global/token file edited; no `::ng-deep` |
