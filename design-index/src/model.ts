// Shared intermediate model written by both parsers (.pen, .fig).

export type NodeType =
  | 'frame' | 'group' | 'text' | 'rect' | 'ellipse' | 'path' | 'line' | 'polygon'
  | 'icon' | 'instance' | 'component' | 'boolean' | 'section' | 'note' | 'other';

/** A paint in normalized form. `v` is a token name when the paint is bound to a variable. */
export type Paint =
  | { k: 'solid'; c?: string; v?: string; o?: number }
  | { k: 'grad'; t: string; stops: [string, number][]; v?: string; a?: number }
  | { k: 'img'; asset?: string; mode?: string; url?: string };

export interface Styles {
  fill?: Paint[];
  stroke?: { paints: Paint[]; w?: number | number[]; align?: string; dash?: number[] };
  r?: number | number[];
  op?: number;
  fx?: { k: 'shadow' | 'blur' | 'bgblur'; x?: number; y?: number; blur?: number; spread?: number; c?: string; inner?: boolean }[];
  font?: { f?: string; s?: number | string; w?: number | string; st?: string; lh?: number | string; ls?: number | string; al?: string; deco?: string; case?: string };
  clip?: boolean;
  rot?: number;
  /** Variable names bound to numeric props (gap, padding, radius, size...) */
  vars?: Record<string, string>;
}

export type SizeRule = 'fill' | 'hug' | number;

export interface Layout {
  dir?: 'row' | 'col';
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
  exec(sql: string): void;
  query<T = unknown>(sql: string, ...a: any[]): T[];
  run(sql: string, ...a: any[]): void;
}
