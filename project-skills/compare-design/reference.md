# compare-design reference

## 1. `spec` notation -> `expect.json`

A node: `{ "sel": "<css selector>", "name": "<design name>", ... , "children": [ ... ] }`. Only `sel` is required.
Write a field only when the rule below says so. A field you leave out is not checked.

| `spec` | `expect.json` | Note |
|---|---|---|
| node name `"Header"`, id `hdr` | `"name": "Header", "id": "hdr"` | `name` appears in the report path; `id` is only for you |
| `row` / `col` | `"dir": "row"` / `"dir": "col"` | needs 2 visible children (or a flex container) |
| `gap=16` / `gap=$space-4(16px)` | `"gap": 16` | distance between the boxes of consecutive children |
| `jc=between\|around\|evenly` (no `gap=`) | no `gap` | the distance depends on the width |
| `grid` on the parent | no `dir`, no `gap`; children: only `w`/`h`/colours/text | the script measures flex-like rows/columns only; grid gaps are not checked |
| child with `@x,y`, `abs`, `pin=…`, `rot=D` or `visual@x,y W×H` (parent `children-abs`, `group`) | parent: no `dir`, no `gap`; child: `w`/`h` (for `rot=`/`visual@`: none), colours, text | positions and rotation are not checked; list them under "could not check" |
| `pad=24` | `"pad": 24` | |
| `--dump` prints `scroll pad(css)=N` | no `pad` for that node | content overflows; N is the CSS padding, not measured |
| `pad=24,32` | `"pad": [24, 32]` | [top and bottom, left and right] |
| `pad=8,16,8,12` | `"pad": [8, 16, 8, 12]` | [top, right, bottom, left] |
| any `pad` | measured from ALL visible content inside the element | icons, text or elements not listed in `children` count as content too |
| size in an axis is a number or `fill`, AND `jc=`/`ai=` is center, end or between on that axis | `null` for both sides of that axis, e.g. `[8, null, 8, null]` | the content is moved away from the edge on purpose |
| `W×H` plain numbers, e.g. `320×48` | `"w": 320, "h": 48` | |
| `fill` (in width or height) | no `w`/`h` for that axis | depends on the parent |
| `hug` / `hug(N)` | no `w`/`h` for that axis | N is the design tool's text width; fonts differ |
| `fill=#ffffff` / `fill=$bg(#1c1b1f)` | `"bg": "#ffffff"` / `"bg": "#1c1b1f"` | you may also paste `"$bg(#1c1b1f)"` as is |
| `fill=$on-surface(#1a1a1a)/op0.12` | `"bg": "#1a1a1a1f"` or `"bg": "$on-surface(#1a1a1a)/op0.12"` | `/opA` = alpha A; never drop it |
| several paints `fill=A+B` (e.g. `fill=#ffffff+$overlay(#000000)/op0.08`) | no `bg` | the visible colour is a mix; list it under "could not check" |
| `color=#49454f` on a text | `"color": "#49454f"` on the node of that text | |
| `stroke=$outline(#cac4d0)/1/inside` | `"borderColor": "#cac4d0", "borderWidth": 1` | border, outline or a 0-blur box-shadow ring all count |
| per-side stroke `stroke=#cac4d0/0,0,1,0` (one width per side) | `"borderColor": "#cac4d0"`, and `"borderWidth": 1` only if all non-zero sides have the same width | `borderWidth` is one number: the script takes the first side with a border and cannot check WHICH sides have one; write that under "could not check". Different widths per side: leave `borderWidth` out |
| `r=12` / `r=8,8,0,0` | `"radius": 12` / `"radius": [8, 8, 0, 0]` | [top-left, top-right, bottom-right, bottom-left]; `r=999` (pill) matches any full rounding |
| no `r=` | `"radius": 0` only if the corners matter | |
| `font=Inter/14/w500/lh1.4` | `"fontSize": 14, "fontWeight": 500, "fontFamily": "Inter"` | no `w` = 400 |
| `text="Save"` | `"text": "Save"` | exact text, spaces collapsed; `case=upper` does not change it |
| `fill=linear-gradient(…)`, `img(…)`, `fx=shadow(…)`, `blur` | nothing | list under "could not check" |

When NOT to write a field (leave it out and list it under "could not check"):
- The value is marked `~` or "derived", or comes from a `# hidden` line.
- The value is a token without `(value)`, e.g. `gap=$space-4`: run `design-query tokens` and use that value (`--space-4: 16px` -> 16).
  If it is not there, leave the field out.
- The node is inside a scaled instance and the value has no `×F=` result.
- The node has an explicit variable mode (`modes{…}`) that the app does not use.

Matching design nodes to app elements:
- A frame with one text child (button, badge, chip, link): if the app has no own element for the text, put `text`, `color`,
  `fontSize`, `fontWeight` on the frame's node and write no child for the text.
- Several app elements with the same selector (list items): repeat the node (as a child or at the top level); each takes the next unused match in DOM order.
  To pick one directly use `"nth": 2` (0 = first match).
- A design node the app does not have: still write it (with the selector the app should have). The report shows NOT FOUND.
- `"strict": true` on a parent: extra visible children in the app become FAIL instead of WARN.

## 2. Worked example

`design-query spec card` (real output of the CLI for a small test design):
```
"Card" frame fill×hug col gap=8 pad=16 fill=#ffffff stroke=$outline(#cac4d0)/1/inside r=8
  "Line 1" text text="First line" color=#49454f font=Inter/14
  "Button" frame hug×hug row pad=10,24 fill=$primary(#6750a4) r=20
    "Label" text text="Save" color=#ffffff font=Inter/14/w500
```
`C <url> --dump ".card"` on the app:
```
section.card 536×96 col gap=12 pad=16 fill=#ffffff stroke=#cac4d0/1/outline r=8
  p.line1 "First line" 504×20 color=#000000 font=Arial/14/w400/lh20px
  button.btn "Save" 79.9×32 pad=6,24 fill=#6750a4 color=#ffffff r=20 font=Arial/14/w500/lh20px
```
`expect.json` (Card is `fill` wide and `hug` high: no `w`/`h`; the button has no own label element, so the label values go on it):
```json
{ "sel": ".card", "name": "Card", "id": "card", "dir": "col", "gap": 8, "pad": 16, "bg": "#ffffff",
  "borderColor": "#cac4d0", "borderWidth": 1, "radius": 8, "children": [
  { "sel": ".line1", "name": "Line 1", "text": "First line", "color": "#49454f", "fontSize": 14 },
  { "sel": ".btn", "name": "Button", "pad": [10, 24], "bg": "#6750a4", "radius": 20,
    "text": "Save", "color": "#ffffff", "fontSize": 14, "fontWeight": 500 } ] }
```
`C <url> expect.json --max-lines 5` (exit code 1):
```
SUMMARY  hierarchy: 5 PASS 0 FAIL 0 WARN 0 SKIP | spacing: 1 PASS 2 FAIL 0 WARN 0 SKIP | color: 7 PASS 1 FAIL 0 WARN 0 SKIP | text: 5 PASS 0 FAIL 0 WARN 0 SKIP
FAIL  spacing    Card  gap: expected 8  measured 12  hint: distance between the boxes of consecutive children (gap, margins and child padding all add up here)
FAIL  color      Card > Line 1  color: expected #49454f  measured #000000
FAIL  spacing    Card > Button  pad (t,r,b,l): expected 10,24,10,24  measured 6,24,6,24  hint: top too small by 4; bottom too small by 4
PASS  hierarchy  Card  exists: expected present  measured section.card
PASS  color      Card  bg: expected #ffffff  measured #ffffff
… 16 more line(s) not shown (0 FAIL, 0 WARN, 0 SKIP, 16 PASS): add --max-lines 21, or --json > compare-report.json
RESULT: 18 PASS, 3 FAIL, 0 WARN, 0 SKIP
```
Causes (section 3): gap 12 = `gap: 8px` plus a 4px margin on `p`; colour = token `var(--...)` not used (black is the browser default);
button padding is 6px instead of 10px. The font family differs too (Arial vs Inter); it is visible in `--dump`, and a `fontFamily` field would report it.

## 3. Typical FAIL patterns and likely causes

| Report shows | Likely cause in the code | Fix |
|---|---|---|
| `gap` too big, `pad` correct | margin on the children in addition to `gap`, or children with their own padding/border | remove the margin; use `gap` on the parent |
| `gap` uneven (`8,8,20`) | one child has a margin, or an invisible wrapper/hidden element between them | find the child after the large value with `--dump` |
| `gap` correct but `w`/`h` too big | `border` used for a design stroke, `box-sizing: content-box` | `box-sizing: border-box`; draw strokes with `outline` + negative `outline-offset` |
| `pad` too small by the border width | the border is inside the padding in the code, but outside in the design | adjust padding, or use outline |
| `pad` right/bottom WARN (more space) | fixed or `fill` size, `justify-content`/`align-items` center, or `hug` children in a wider box | usually fine: check `w`/`h` instead |
| `dir` measured `col`, design `row` | missing `display:flex`, `flex-direction: column`, or the children are block elements | `display:flex; flex-direction:row` on the right element |
| `dir` measured `mixed` | absolute positioning, negative margins, or wrapping in a grid | rebuild with flex as in `spec` |
| `order` differs | DOM order, CSS `order`, `row-reverse`/`column-reverse` | reorder the template/JSX |
| `nesting`: inside a sibling | a wrapper or a component puts one element inside the other | move the element up one level |
| `parent`: element not inside its design parent | the element is rendered in another component or a portal/overlay | move it, or note it if it is an overlay by design |
| `extra child` WARN | element in the app that the design does not show (icon, debug text, extra wrapper with paint) | add it to `expect.json` if the design has it, else ask |
| `bg` transparent, hint names an ancestor colour | the colour is painted by a wrapper or the parent, not by this element | put the background on the element that has it in the design |
| colour WARN "same visible colour, different alpha" | design uses `/opA` transparency, the code a pre-mixed opaque colour (or the other way round) | use `color-mix(in srgb, var(--x) A%, transparent)`; WARN is acceptable if the background never changes |
| colour off by a few steps (`#49454f` vs `#4a4550`) | hard-coded hex instead of the token, or another theme/mode | use `var(--token)` from `design-query tokens`; check the theme |
| colour completely different | wrong token, or a hover/focus/disabled/selected state is active | check the state on the page (focus after load, selected route) |
| text colour `#000000` | no colour set at all (browser default) | set the token colour |
| `text` differs only in case | design text is stored in source case, the code wrote it upper case | write the source text, use `text-transform` |
| `fontWeight` 400 vs 500/600 | font file for that weight not loaded or weight not set | import the weight; set `font-weight` |
| `NOT FOUND` | wrong selector, element not rendered (missing mock data, `*ngIf`/condition false), inside a shadow root or iframe, or truly missing | `--dump` the parent and find it; check mock data. Shadow roots and iframes are invisible to `--dump` too: stop and tell the user |
| `visible: size 0×0` / `display:none` | empty container, collapsed by a condition, or lazy content not loaded | load the data; `--wait 2000` |
