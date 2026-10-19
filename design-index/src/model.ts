// Shared intermediate model written by both parsers (.pen, .fig).

export type NodeType =
  | 'frame' | 'group' | 'text' | 'rect' | 'ellipse' | 'path' | 'line' | 'polygon'
  | 'icon' | 'instance' | 'component' | 'boolean' | 'section' | 'note' | 'other';

/** A paint in normalized form. `v` is a token name when the paint is bound to a variable. */
/** `bm` = paint blend mode in CSS spelling (multiply, screen, …; absent = normal) */
export type Paint =
  | { k: 'solid'; c?: string; v?: string; o?: number; bm?: string }
  /** `a` = legacy angle; `p` = handles in node-normalized space: linear [x1,y1,x2,y2]; radial/angular/diamond [cx,cy,ax,ay,bx,by] (centre, end of axis 1, end of axis 2) */
  | { k: 'grad'; t: string; stops: [string, number][]; v?: string; a?: number; p?: number[]; bm?: string }
  /** `tf` = crop transform (node unit square -> image unit square, [m00,m01,m02,m10,m11,m12]); `o` = paint opacity */
  | { k: 'img'; asset?: string; mode?: string; url?: string; tf?: number[]; o?: number; bm?: string };

/**
 * A character range of a text with its own style (fig: characterStyleIDs + styleOverrideTable). `i`/`n` = start and length in
 * UTF-16 code units of the text; only fields the range sets are present (absent = the text's own value).
 */
export interface TextRun {
  i: number; n: number;
  font?: Partial<NonNullable<Styles['font']>>;
  fill?: Paint[];
  /** hyperlink: an URL, or `#<node-id>` for a link to a node of the file */
  link?: string;
  /** names of the shared styles the range takes its values from (text, fill) */
  sty?: Record<string, string>;
  /** unresolved style references (removed once the style records are known) */
  tsid?: string; fsid?: string;
  /** the range sets its font fields over its text style (Figma isOverrideOverTextStyle) */
  ovr?: boolean;
  /** the characters are emoji, drawn by Figma as colour emoji images (EMOJI paint), not in a text colour */
  emoji?: boolean;
}

export interface Styles {
  fill?: Paint[];
  stroke?: { paints: Paint[]; w?: number | number[]; align?: string; dash?: number[] };
  r?: number | number[];
  op?: number;
  fx?: { k: 'shadow' | 'blur' | 'bgblur'; x?: number; y?: number; blur?: number; spread?: number; c?: string; inner?: boolean }[];
  font?: {
    f?: string; s?: number | string; w?: number | string; st?: string;
    /** line height as a multiplier of the font size (or a string unit); absent = the font's normal line height */
    lh?: number | string;
    ls?: number | string; al?: string; deco?: string; case?: string;
    /** vertical alignment inside a fixed-height box: center | bottom */
    va?: string;
    /** truncation with an ellipsis: true = at the box end, number = after that many lines */
    trunc?: boolean | number;
    /** the font's natural line height as a multiplier of the font size (fig: derivedTextData), used to draw "normal" */
    nlh?: number;
    /** Figma's saved line pitch in px under an Auto line height (derivedTextData baselines; legacy texts keep it unrounded) */
    lpx?: number;
    /** text box trim (Figma leadingTrim): cap = from cap height to baseline */
    trim?: string;
  };
  /** ranges with their own style (mixed text styles) */
  runs?: TextRun[];
  /** hyperlink of the whole text (URL or `#<node-id>`) */
  link?: string;
  /** layer blend mode in CSS spelling (multiply, screen, …; Figma names linear-burn/linear-dodge kept); absent = normal/pass-through */
  blend?: string;
  /** outline icon (raw.geometryFrom = stroke) whose stroke weight an instance changed: the new weight */
  ow?: number;
  /** fig: the node's own paints where a fill style replaced different ones (shown when an instance detaches the style) */
  ifill?: Paint[];
  clip?: boolean;
  /** rotation in degrees, counter-clockwise, about the node's top-left origin (@x,y) */
  rot?: number;
  /** mirrored in its own coordinates before rotation: x = horizontally (local x -> -x), y = vertically */
  flip?: 'x' | 'y';
  /** Variable names bound to numeric props (gap, padding, radius, size...) */
  vars?: Record<string, string>;
  /** names of shared styles (fig) applied to this node: text, fill, stroke, effect */
  sty?: Record<string, string>;
}

export type SizeRule = 'fill' | 'hug' | number;

export interface Layout {
  /** grid = auto-layout grid: children keep their saved positions */
  dir?: 'row' | 'col' | 'grid';
  gap?: number | string;
  pad?: number[];
  jc?: string;
  ai?: string;
  wrap?: boolean;
  /** this node's own sizing rule inside its parent */
  w?: SizeRule;
  h?: SizeRule;
  abs?: boolean;
}

export interface NodeRow {
  id: string;
  parent_id: string | null;
  page: number;
  type: NodeType;
  name: string;
  depth: number;
  ord: number;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  layout?: Layout | null;
  styles?: Styles | null;
  text?: string | null;
  component_ref?: string | null;
  visible: boolean;
  /** remaining source attributes that aren't mapped (shown by `node`) */
  raw?: Record<string, unknown> | null;
  /** sibling order key (fig: fractional-index string); ord is computed from it in SQL */
  pos?: string | null;
}

export interface ComponentRow {
  id: string;
  name: string;
  page: number;
  description?: string;
  set_id?: string | null;
  set_name?: string | null;
  /** variant property assignments, e.g. {State:'Hover'} */
  variant?: Record<string, string> | null;
  /** property definitions (boolean/text/instance-swap/variant) */
  props?: Record<string, unknown> | null;
}

export interface VariableRow {
  id: string;
  name: string;
  collection: string;
  type: string;
  /** mode/theme name -> value (color hex, number, string, boolean, or alias:name) */
  values: Record<string, unknown>;
  /** alternative id (fig: local guid) that paints may reference */
  guid?: string;
}

export interface PropDefRow { owner: string; id: string; name: string; type: string; initial: unknown; parent: string | null }
export interface DerivedRow { inst: string; p: string; w?: number; h?: number; x?: number; y?: number; geom?: string | null; ns?: boolean; /** saved stroke outline of the occurrence (geometry key) */ sg?: string | null }
export interface VarModeRow { set_id: string; set_key: string | null; set_name: string; mode_id: string; mode_name: string }
export interface AssetRow { hash: string; path: string; mime: string; size: number; w?: number; h?: number }
export interface InteractionRow { node_id: string; trigger: string; action: string; target_id?: string | null; detail?: string | null }
export interface NoteRow { node_id: string | null; kind: string; text: string }

/** Everything a parser needs to report. Implemented by IndexWriter. */
export interface Sink {
  node(r: NodeRow): void;
  geometry(nodeId: string, data: string): void;
  component(r: ComponentRow): void;
  variable(r: VariableRow): void;
  asset(r: AssetRow): void;
  interaction(r: InteractionRow): void;
  note(r: NoteRow): void;
  page(idx: number, id: string, name: string): void;
  meta(key: string, value: string): void;
  warn(msg: string, n?: number): void;
  /** aggregate usage of raw style values (color/fontSize/gap/...) for the audit */
  usage(kind: string, value: string, n?: number): void;
  propdef(r: PropDefRow): void;
  derived(r: DerivedRow): void;
  varmode(r: VarModeRow): void;
  exec(sql: string): void;
  query<T = unknown>(sql: string, ...a: any[]): T[];
  run(sql: string, ...a: any[]): void;
}
