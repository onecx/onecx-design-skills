# Intermediate model (SQLite, `<repo>/.design-index/<hash>/index.db`)

Both formats are mapped onto the same model. Read this only when `--json` output is processed further; the index itself is never
queried directly (always go through `design-query`).

## Tables
| Table | Content |
|---|---|
| `nodes` | `id, parent_id, page, type, name, depth, ord, x, y, w, h, layout JSON, styles JSON, text, component_ref, visible, evis, raw JSON, nchild` |
| `geometry` | `node_id, data` (SVG path for vectors; only used by `assets export`/`screenshot`) |
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
`dir` row|col · `gap` · `pad` [top, right, bottom, left] · `jc` center|end|between|around · `ai` center|end|stretch|baseline ·
`wrap` · `abs` (absolutely positioned) · `w`/`h` = `"fill"` | `"hug"` | number (sizing rule of the node inside its parent).

## `styles` (JSON)
- `fill`: `[{k:"solid", c:"#rrggbb[aa]", v:"<token>"}, {k:"grad", t, stops, a}, {k:"img", asset:"<hash>", mode}]`
- `stroke`: `{paints, w (number or [t,r,b,l]), align}` · `r` radius (number or 4 values) · `op` · `clip` · `rot`
- `fx`: shadows/blur · `font`: `{f, s, w, lh (factor), ls, al, st, deco, case}` · `vars`: bound numeric variables
- `v` refers to `variables.id`/`guid`; the name is in `variables.name`, the CSS variable is `--<name-in-kebab-case>`.

## Format specifics
- **.pen** (JSON, schema "2.21", comments allowed): auto-layout without computed positions; the default layout of a frame is horizontal.
  Components = `reusable`, instances = `type: ref` + `descendants` (overrides). Images: `url` relative to the file, or base64.
- **.fig** (ZIP with `canvas.fig`, `meta.json`, `images/`): Kiwi schema + zstd/deflate. Positions are computed (transform relative to the
  parent). Instances have no children, their content comes from `component_ref` plus `raw.overrides`/`raw.props`.
  Pages = canvases; "Internal Only Canvas" (`pages.internal=1`) holds variables/library parts.
