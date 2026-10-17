# Intermediate model (SQLite, `<repo>/.design-index/<hash>/index.db`)

Both formats are mapped onto the same model. Read this only when `--json` output is processed further; the index itself is never
queried directly (always go through `design-query`).

## Tables
| Table | Content |
|---|---|
| `nodes` | `id, parent_id, page, type, name, depth, ord, x, y, w, h, layout JSON, styles JSON, text, component_ref, visible, evis, raw JSON, nchild` |
| `geometry` | `node_id, data`: SVG path data, or JSON `[[d, rule, styleID], …]` when regions have their own paint or winding rule (fig). Only used by `assets export`/`screenshot` |
| `derived` | fig: Figma's saved layout of instance content per override path: `inst, p, w, h, x, y, geom` (fill outline key), `sg` (stroke outline key), `ns` (empty stroke outline) |
| `pages` | `idx, id, name, node_count, screen_count, internal` (pen: top-level frames; fig: canvas pages) |
| `components` | `id, name, page, description, set_id, set_name, variant JSON, props JSON, instances` |
| `variables` | `id, name, collection, type, vals JSON {mode: value\|"alias:<id>"}, guid` |
| `assets` | `hash, path, mime, size, w, h` (files below `assets/`, never inside the DB) |
| `interactions` / `edges` | prototype interactions / screen→screen connections derived from them |
| `notes` | `node_id, kind (dev-note, note, sticky, description, context), text` |
| `screens` | detected screens incl. purpose estimate (derived), group, state hint, device |
| `findings` | audit findings (`kind, severity, node_id, page, msg`) |
| `usage` | counters of raw values in use (color, font size, spacing, radius) |
| `nodes_fts` | FTS5 over `name` and `text` |

`evis` = effectively visible (the node and all its ancestors are visible).

## Node types
`frame group text rect ellipse path line polygon icon instance component boolean section note other`.
`instance.component_ref` points to `components.id`; a component set (fig) is a frame with `raw.isComponentSet`.

## `layout` (JSON, defaults are omitted)
`dir` row|col|grid (grid: children keep saved positions) · `gap` · `pad` [top, right, bottom, left] · `jc` center|end|between|around|evenly · `ai` center|end|stretch|baseline ·
`wrap` · `abs` (absolutely positioned) · `w`/`h` = `"fill"` | `"hug"` | number (sizing rule of the node inside its parent).

## `styles` (JSON)
- `fill`: `[{k:"solid", c:"#rrggbb[aa]", v:"<token>"}, {k:"grad", t (linear|radial|angular|diamond), stops, a, p (handles, node-normalized: linear [x1,y1,x2,y2], others [cx,cy,ax,ay,bx,by])}, {k:"img", asset:"<hash>", mode (cover|contain|crop|tile|stretch), tf (crop transform), o (opacity)}]`; every paint may carry `bm` (blend mode in CSS spelling, e.g. `multiply`; Figma-only `linear-burn`/`linear-dodge`)
- `blend`: layer blend mode (absent = normal / pass-through) · `link`: hyperlink of the whole text (URL or `#<node-id>`)
- `runs`: text ranges with their own style `[{i, n (UTF-16 start/length), font (only the fields the range sets; null = default), fill, link, sty, emoji}]` (fig `characterStyleIDs`, one id per code point, + `styleOverrideTable`, range style references resolved; `emoji: true` = colour emoji characters, Figma EMOJI paint, found by the entry's code points)
- `ow`: effective stroke weight of an outline icon (`raw.geometryFrom = "stroke"`) after an instance override or scale · `ifill`: the layer's own paints where a fill style replaced different ones, stored only on layers that some instance detaches from the style
- `stroke`: `{paints, w (number or [t,r,b,l]), align, dash}` · `r` radius (number or [tl,tr,br,bl]; never on vectors) · `op` · `clip`
- `rot` (degrees, counter-clockwise about the top-left origin) · `flip` x|y (mirrored before rotating; the full matrix is in `raw.m`)
- `fx`: shadows/blur (`blur` = Figma radius) · `font`: `{f, s, w, lh (factor; absent = normal), ls, al, st, deco, case, va (center|bottom), trunc (true or max lines), nlh (font's natural line height factor), trim ("cap" = leading trim to cap height)}`
- `vars`: bound variables by field (`gap`, `pad-top|right|bottom|left`, `radius`, `r-tl|tr|br|bl`, `width`, `height`, `min-/max-width|height`, `font-family`, `font-size`, `font-style`, `line-height`, `letter-spacing`, `opacity`, `stroke-weight`, `border-*`, `text`, …) → variable id
- `sty`: names of the shared styles the values come from (`text`, `fill`, `stroke`, `effect`)
- `v` refers to `variables.id`/`guid`; the name is in `variables.name`, the CSS variable is `--<name-in-kebab-case>`.

## Format specifics
- **.pen** (JSON, schema "2.21", comments allowed): auto-layout without computed positions; the default layout of a frame is horizontal.
  Components = `reusable`, instances = `type: ref` + `descendants` (overrides). Images: `url` relative to the file, or base64.
- **.fig** (ZIP with `canvas.fig`, `meta.json`, `images/`): Kiwi schema + zstd/deflate. Positions are computed (transform relative to the
  parent). Instances have no children, their content comes from `component_ref` plus `raw.overrides`/`raw.props`.
  Pages = canvases; "Internal Only Canvas" (`pages.internal=1`) holds variables/library parts and shared styles.
  Groups are FRAME + `resizeToFit` (type `group`). `raw`: `mask`, `maskType` (OUTLINE | LUMINANCE; absent = ALPHA), `usf` (instance uniform scale factor),
  `revZ` (stackReverseZIndex: first child painted on top), `hConstraint`/`vConstraint` (non-MIN constraints incl. SCALE),
  `m` (2×2 matrix of mirrored/skewed nodes), `list` (list marker per line), `regions` (paints per vector region), `arc`, `polygonCount`,
  `geometryFrom: "stroke"` + `outlineW` (stroke-only vector drawn as its filled outline). Override records (`raw.overrides[]`) carry `p` (path),
  `t`, `hidden`/`show`, `swap`, `pa`, `st` (styles), `sp` (stroke width/align/dash/border sides), `rc` (corner fields), `lo` (auto-layout
  and text-resize fields in Figma's names), `sz`, `vm`, `vb` (variable bindings, null = cleared); `st.runs` = the ranges of new characters (`[]` = none).
  Display-P3 documents (`meta.color_profile = DISPLAY_P3`) store all colours converted to sRGB.
