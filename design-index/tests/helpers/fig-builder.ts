// Builds tiny synthetic .fig files (raw fig-kiwi and ZIP) with a reduced Kiwi schema. No customer data involved.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';

const SCHEMA = `
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }
struct Number { float value; NumberUnits units; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; TEXT = 3; SYMBOL = 4; INSTANCE = 5; VECTOR = 6; VARIABLE_SET = 7; VARIABLE = 8; ROUNDED_RECTANGLE = 9;
  ELLIPSE = 10; REGULAR_POLYGON = 11; SLICE = 12; BOOLEAN_OPERATION = 13; TEXT_PATH = 14; STAR = 15; LINE = 16; BRUSH = 17; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; GRADIENT_RADIAL = 2; GRADIENT_ANGULAR = 3; GRADIENT_DIAMOND = 4; IMAGE = 5; EMOJI = 6; }
enum VarType { COLOR = 0; FLOAT = 1; STRING = 2; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT = 1; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 2; }
enum StackJustify { MIN = 0; CENTER = 1; MAX = 2; SPACE_EVENLY = 3; SPACE_BETWEEN = 4; SPACE_AROUND = 5; SPACE_EVENLY_CSS = 6; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; BASELINE = 3; }
enum StackCounterAlign { MIN = 0; CENTER = 1; MAX = 2; STRETCH = 3; AUTO = 4; }
enum StackPositioning { AUTO = 0; ABSOLUTE = 1; }
enum TextCase { ORIGINAL = 0; UPPER = 1; LOWER = 2; TITLE = 3; }
enum TextDecoration { NONE = 0; UNDERLINE = 1; STRIKETHROUGH = 2; }
enum TextAlignVertical { TOP = 0; CENTER = 1; BOTTOM = 2; }
enum TextTruncation { DISABLED = 0; ENDING = 1; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum LineType { PLAIN = 0; ORDERED_LIST = 1; UNORDERED_LIST = 2; }
enum ConstraintType { MIN = 0; CENTER = 1; MAX = 2; STRETCH = 3; SCALE = 4; }
enum StyleType { NONE = 0; FILL = 1; STROKE = 2; TEXT = 3; EFFECT = 4; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; NOISE = 4; }
enum ImageScaleMode { STRETCH = 0; FIT = 1; FILL = 2; TILE = 3; }
enum WindingRule { NONZERO = 0; ODD = 1; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum VariableField { MISSING = 0; CORNER_RADIUS = 1; STACK_SPACING = 5; STACK_PADDING_LEFT = 6; STACK_PADDING_TOP = 7; STACK_PADDING_RIGHT = 8; STACK_PADDING_BOTTOM = 9;
  VISIBLE = 10; TEXT_DATA = 11; WIDTH = 12; HEIGHT = 13; RECTANGLE_TOP_LEFT_CORNER_RADIUS = 14; RECTANGLE_TOP_RIGHT_CORNER_RADIUS = 15; RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS = 16;
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS = 17; FONT_FAMILY = 28; OPACITY = 31; FONT_SIZE = 32; LINE_HEIGHT = 36; OVERRIDDEN_SYMBOL_ID = 37; SLOT_CONTENT_ID = 40; }
enum VariableDataType { BOOLEAN = 0; FLOAT = 1; STRING = 2; ALIAS = 3; COLOR = 4; PROP_REF = 5; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; DARKEN = 2; MULTIPLY = 3; LINEAR_BURN = 4; COLOR_BURN = 5; LIGHTEN = 6; SCREEN = 7; LINEAR_DODGE = 8;
  COLOR_DODGE = 9; OVERLAY = 10; SOFT_LIGHT = 11; HARD_LIGHT = 12; DIFFERENCE = 13; EXCLUSION = 14; HUE = 15; SATURATION = 16; COLOR = 17; LUMINOSITY = 18; }
enum LeadingTrim { NONE = 0; CAP_HEIGHT = 1; }
enum MaskType { ALPHA = 0; OUTLINE = 1; LUMINANCE = 2; }
enum ColorProfile { SRGB = 0; DISPLAY_P3 = 1; }
message Hyperlink { string url = 1; GUID guid = 2; }
message AssetRef { string key = 1; }
message SetRef { AssetRef assetRef = 1; GUID guid = 2; }
message VarModeEntry { SetRef variableSetID = 1; GUID variableModeID = 2; }
message VarModeMap { VarModeEntry[] entries = 1; }
message StyleId { GUID guid = 1; AssetRef assetRef = 2; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; GRID = 3; }
message ParentIndex { GUID guid = 1; string position = 2; }
message ColorStop { Color color = 1; float position = 2; }
message Image { byte[] hash = 1; }
message VarAlias { GUID guid = 1; AssetRef assetRef = 2; }
message PropRefValue { GUID defId = 1; }
message VarAnyValue { VarAlias alias = 1; PropRefValue propRefValue = 2; string textValue = 3; float floatValue = 4; }
message VarDataMsg { VarAnyValue value = 1; VariableDataType dataType = 2; }
message VarMapEntry { VariableField variableField = 1; VarDataMsg variableData = 2; }
message VarMap { VarMapEntry[] entries = 1; }
message ColorVar { VarDataMsg value = 1; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; Matrix transform = 5; ColorStop[] stops = 6; ImageScaleMode imageScaleMode = 7; Image image = 8; VarDataMsg colorVar = 9; BlendMode blendMode = 10; uint[] emojiCodePoints = 11; }
message Effect { EffectType type = 1; Vector offset = 2; float radius = 3; Color color = 4; bool visible = 5; float spread = 6; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message TextLine { LineType lineType = 1; uint indentationLevel = 2; }
message TextData { string characters = 1; TextLine[] lines = 2; uint[] characterStyleIDs = 3; NodeChange[] styleOverrideTable = 4; }
message FontMeta { FontName key = 1; float fontLineHeight = 2; float fontWeight = 3; }
message Baseline { float lineHeight = 1; }
message DerivedText { FontMeta[] fontMetaData = 1; Baseline[] baselines = 2; }
message ArcData { float startingAngle = 1; float endingAngle = 2; float innerRadius = 3; }
enum PropField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; }
message PropRef { GUID defID = 1; PropField componentPropNodeField = 2; }
message SymbolIdValue { GUID guid = 1; }
message PropValue { bool boolValue = 1; TextData textDataValue = 2; SymbolIdValue symbolIdValue = 3; }
message PropAssign { GUID defID = 1; PropValue value = 2; }
message PropDefMsg { GUID id = 1; string name = 2; PropValue initialValue = 3; GUID parentPropDefId = 4; VarDataMsg varValue = 5; PropType type = 6; }
enum PropType { BOOL = 0; TEXT = 1; INSTANCE_SWAP = 3; VARIANT = 4; }
message Geom { uint commandsBlob = 1; WindingRule windingRule = 2; uint styleID = 3; }
message Derived { GUIDPath guidPath = 1; Vector size = 2; Matrix transform = 3; Geom[] strokeGeometry = 4; Geom[] fillGeometry = 5; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; float uniformScaleFactor = 3; }
message ModeRef { GUID id = 1; string name = 2; }
message VarValue { Color colorValue = 1; float floatValue = 2; string textValue = 3; VarAlias alias = 4; }
message VarData { VarValue value = 1; }
message VarEntry { GUID modeID = 1; VarData variableData = 2; }
message VarValues { VarEntry[] entries = 1; }
message VectorData { NodeChange[] styleOverrideTable = 1; }
message NodeChange {
  GUID guid = 1; NodeType type = 2; string name = 3; ParentIndex parentIndex = 4; Vector size = 5; Matrix transform = 6;
  TextData textData = 7; float fontSize = 8; StackMode stackMode = 9; float stackSpacing = 10; bool visible = 11;
  Paint[] fillPaints = 12; SymbolData symbolData = 13; ModeRef[] variableSetModes = 14; VarValues variableDataValues = 15; string key = 16;
  string symbolDescription = 17; uint[] fillGeometryBlobs = 18; SetRef variableSetID = 19; VarType variableResolvedType = 20;
  GUID overrideKey = 21; PropDefMsg[] componentPropDefs = 22; PropRef[] componentPropRefs = 23; PropAssign[] componentPropAssignments = 24; Derived[] derivedSymbolData = 25;
  float cornerRadius = 26; float rectangleTopLeftCornerRadius = 27; bool rectangleCornerRadiiIndependent = 28; float strokeWeight = 29; float borderTopWeight = 30; bool borderStrokeWeightsIndependent = 31; Paint[] strokePaints = 32;
  GUIDPath guidPath = 33; StackSize stackPrimarySizing = 34; StackSize stackCounterSizing = 35; StackJustify stackPrimaryAlignItems = 36; StackAlign stackCounterAlignItems = 37;
  float stackHorizontalPadding = 38; float stackVerticalPadding = 39; float stackPaddingRight = 40; float stackPaddingBottom = 41; bool resizeToFit = 42; bool frameMaskDisabled = 43;
  Number lineHeight = 44; Number letterSpacing = 45; FontName fontName = 46; DerivedText derivedTextData = 47; TextCase textCase = 48; TextDecoration textDecoration = 49;
  TextAlignVertical textAlignVertical = 50; TextTruncation textTruncation = 51; uint maxLines = 52; TextAutoResize textAutoResize = 53;
  StyleId styleIdForText = 54; StyleId styleIdForFill = 55; StyleId styleIdForStrokeFill = 56; StyleId styleIdForEffect = 57; StyleType styleType = 58;
  Effect[] effects = 59; VarMap variableConsumptionMap = 60; VarMap parameterConsumptionMap = 61; bool mask = 62;
  ConstraintType horizontalConstraint = 63; ConstraintType verticalConstraint = 64; StackPositioning stackPositioning = 65; float stackChildPrimaryGrow = 66; StackCounterAlign stackChildAlignSelf = 67;
  Geom[] fillGeometry = 68; Geom[] strokeGeometry = 69; VectorData vectorData = 70; ArcData arcData = 71; uint count = 72; float rectangleTopRightCornerRadius = 73;
  float rectangleBottomRightCornerRadius = 74; float rectangleBottomLeftCornerRadius = 75; float opacity = 76; StrokeAlign strokeAlign = 77; float[] dashPattern = 78; uint styleID = 79;
  float borderRightWeight = 80; float borderBottomWeight = 81; float borderLeftWeight = 82;
  Hyperlink hyperlink = 83; LeadingTrim leadingTrim = 84; BlendMode blendMode = 85; bool isOverrideOverTextStyle = 86; MaskType maskType = 87;
  bool stackReverseZIndex = 88; ColorProfile documentColorProfile = 89; VarModeMap variableModeBySetMap = 90; bool isStateGroup = 91; bool maskIsOutline = 92;
}
message Blob { byte[] bytes = 1; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
`;
/** Kiwi writes fields in declaration order: this variant puts the blobs before the nodes */
const BLOBS_FIRST = SCHEMA.replace('message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }', 'message Message { Blob[] blobs = 2; NodeChange[] nodeChanges = 1; }');

export type PV = { b: boolean } | { t: string } | { sym: [number, number] };
export interface Assign { def: [number, number]; v: PV }
const pv = (v: PV) => ('b' in v ? { boolValue: v.b } : 't' in v ? { textDataValue: { characters: v.t } } : { symbolIdValue: { guid: { sessionID: v.sym[0], localID: v.sym[1] } } });

export interface FigNode {
  id: [number, number]; type: string; name?: string; parent?: [number, number]; pos?: string; w?: number; h?: number; x?: number; y?: number;
  text?: string; stack?: 'HORIZONTAL' | 'VERTICAL'; gap?: number; fill?: [number, number, number]; symbol?: [number, number]; desc?: string;
  overrides?: { path: [number, number][]; fontSize?: number; fill?: [number, number, number]; text?: string; visible?: boolean; swap?: [number, number]; assign?: Assign[]; extra?: Record<string, unknown> }[];
  /** any further NodeChange fields, in Figma's own names and shapes (see the schema above); they win over the shorthands */
  extra?: Record<string, unknown>;
  ok?: [number, number]; defs?: { id: [number, number]; init?: PV; name?: string; parent?: [number, number]; type?: string }[]; refs?: { def: [number, number]; field: 'VISIBLE' | 'TEXT_DATA' | 'OVERRIDDEN_SYMBOL_ID' }[]; assign?: Assign[]; derived?: { path: [number, number][]; w: number; h: number; x: number; y: number; noStroke?: boolean; extra?: Record<string, unknown> }[];
  radius?: { cornerRadius?: number; tl?: number; indep?: boolean }; stroke?: { w: number; top?: number; indep?: boolean }; visibleFlag?: boolean;
  modes?: { id: [number, number]; name: string }[]; key?: string; setKey?: string; varType?: 'COLOR' | 'FLOAT' | 'STRING'; values?: { mode: [number, number]; color?: [number, number, number, number]; num?: number; str?: string; alias?: string }[];
}

export const g = (a: [number, number]) => ({ sessionID: a[0], localID: a[1] });
/** solid paint in the Kiwi shape */
export const solid = (r: number, gg: number, b: number, extra: Record<string, unknown> = {}) => ({ type: 'SOLID', color: { r, g: gg, b, a: 1 }, opacity: 1, visible: true, ...extra });
/** variable alias binding entry for variableConsumptionMap / parameterConsumptionMap */
export const bindVar = (field: string, key?: string) => ({ variableField: field, variableData: key ? { value: { alias: { assetRef: { key } } }, dataType: 'ALIAS' } : undefined });
/** a Figma path blob: commands as [cmd, ...coords] (1 M, 2 L, 0 Z) */
export function pathBlob(cmds: number[][]): Uint8Array {
  const parts: Buffer[] = [];
  for (const [c, ...xy] of cmds) { const b = Buffer.alloc(1 + xy.length * 4); b[0] = c; xy.forEach((v, i) => b.writeFloatLE(v, 1 + i * 4)); parts.push(b); }
  return new Uint8Array(Buffer.concat(parts));
}

export function buildFig(nodes: FigNode[], opts: { version?: number; blobs?: Uint8Array[]; magic?: string; blobsFirst?: boolean } = {}): Buffer {
  const schemaObj = parseSchema(opts.blobsFirst ? BLOBS_FIRST : SCHEMA);
  const schema: any = compileSchema(schemaObj);
  const msg = {
    nodeChanges: nodes.map((n) => ({
      guid: g(n.id), type: n.type, name: n.name,
      parentIndex: n.parent ? { guid: g(n.parent), position: n.pos ?? '!' } : undefined,
      size: n.w != null ? { x: n.w, y: n.h ?? 0 } : undefined,
      transform: { m00: 1, m01: 0, m02: n.x ?? 0, m10: 0, m11: 1, m12: n.y ?? 0 },
      textData: n.text != null ? { characters: n.text } : undefined, fontSize: n.text != null ? 16 : undefined,
      stackMode: n.stack, stackSpacing: n.gap, visible: n.visibleFlag ?? true,
      overrideKey: n.ok ? g(n.ok) : undefined,
      componentPropDefs: n.defs?.map((d) => ({ id: g(d.id), name: d.parent && !d.name ? undefined : d.name ?? 'p', initialValue: d.init ? pv(d.init) : undefined, parentPropDefId: d.parent ? g(d.parent) : undefined, type: d.type })),
      componentPropRefs: n.refs?.map((r) => ({ defID: g(r.def), componentPropNodeField: r.field })),
      componentPropAssignments: n.assign?.map((a) => ({ defID: g(a.def), value: pv(a.v) })),
      derivedSymbolData: n.derived?.map((d) => ({ guidPath: { guids: d.path.map(g) }, size: { x: d.w, y: d.h }, transform: { m00: 1, m01: 0, m02: d.x, m10: 0, m11: 1, m12: d.y }, strokeGeometry: d.noStroke ? [] : undefined, ...d.extra })),
      cornerRadius: n.radius?.cornerRadius, rectangleTopLeftCornerRadius: n.radius?.tl, rectangleCornerRadiiIndependent: n.radius?.indep,
      strokeWeight: n.stroke?.w, borderTopWeight: n.stroke?.top, borderStrokeWeightsIndependent: n.stroke?.indep,
      strokePaints: n.stroke ? [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, opacity: 1, visible: true }] : undefined,
      fillPaints: n.fill ? [{ type: 'SOLID', color: { r: n.fill[0], g: n.fill[1], b: n.fill[2], a: 1 }, opacity: 1, visible: true }] : undefined,
      symbolData: n.symbol ? {
        symbolID: g(n.symbol),
        symbolOverrides: n.overrides?.map((o) => ({
          guidPath: { guids: o.path.map(g) }, fontSize: o.fontSize, visible: o.visible,
          overriddenSymbolID: o.swap ? g(o.swap) : undefined,
          componentPropAssignments: o.assign?.map((a) => ({ defID: g(a.def), value: pv(a.v) })),
          fillPaints: o.fill ? [{ type: 'SOLID', color: { r: o.fill[0], g: o.fill[1], b: o.fill[2], a: 1 }, opacity: 1, visible: true }] : undefined,
          textData: o.text !== undefined ? { characters: o.text } : undefined,
          ...o.extra,
        })),
      } : undefined,
      symbolDescription: n.desc, key: n.key,
      variableSetID: n.setKey ? { assetRef: { key: n.setKey } } : undefined, variableResolvedType: n.varType,
      variableSetModes: n.modes?.map((m) => ({ id: g(m.id), name: m.name })),
      variableDataValues: n.values ? { entries: n.values.map((v) => ({ modeID: g(v.mode), variableData: { value: v.alias ? { alias: { assetRef: { key: v.alias } } } : v.color ? { colorValue: { r: v.color[0], g: v.color[1], b: v.color[2], a: v.color[3] } } : v.str !== undefined ? { textValue: v.str } : { floatValue: v.num } } })) } : undefined,
      ...n.extra,
    })),
    blobs: (opts.blobs ?? []).map((bytes) => ({ bytes })),
  };
  const schemaChunk = zlib.deflateRawSync(Buffer.from(encodeBinarySchema(schemaObj)));
  const dataChunk = zlib.zstdCompressSync(Buffer.from(schema.encodeMessage(msg)));
  const head = Buffer.alloc(12);
  head.write(opts.magic ?? 'fig-kiwi', 0, 'latin1');
  head.writeUInt32LE(opts.version ?? 106, 8);
  const len = (b: Buffer) => { const x = Buffer.alloc(4); x.writeUInt32LE(b.length); return x; };
  return Buffer.concat([head, len(schemaChunk), schemaChunk, len(dataChunk), dataChunk]);
}

/** Stored (uncompressed) ZIP writer: enough to exercise the streaming ZIP reader. */
export function buildZip(files: Record<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameB = Buffer.from(name);
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26);
    parts.push(lh, nameB, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export const sampleNodes = (): FigNode[] => [
  { id: [0, 0], type: 'DOCUMENT', name: 'Document' },
  { id: [0, 1], type: 'CANVAS', name: 'Page 1', parent: [0, 0], pos: '!' },
  { id: [1, 1], type: 'FRAME', name: 'Login', parent: [0, 1], pos: '!', w: 1440, h: 900, stack: 'VERTICAL', gap: 16, fill: [1, 1, 1] },
  { id: [1, 2], type: 'TEXT', name: 'Title', parent: [1, 1], pos: '!', w: 200, h: 24, text: 'Anmelden' },
  { id: [1, 3], type: 'TEXT', name: 'Hint', parent: [1, 1], pos: '"', w: 200, h: 24, text: 'Lorem ipsum' },
  { id: [2, 1], type: 'SYMBOL', name: 'State=Hover, Size=L', parent: [0, 1], pos: '"', w: 100, h: 40, desc: 'Primary button' },
  { id: [2, 3], type: 'TEXT', name: 'Label', parent: [2, 1], pos: '!', w: 60, h: 20, text: 'Button' },
  { id: [2, 2], type: 'INSTANCE', name: 'Button', parent: [1, 1], pos: '#', w: 100, h: 40, symbol: [2, 1], overrides: [{ path: [[2, 3]], fontSize: 20, fill: [0, 0.2, 0.4], text: 'Weiter' }] },
  { id: [3, 1], type: 'VARIABLE_SET', name: 'Colors', key: 'setkey', modes: [{ id: [9, 0], name: 'Light' }, { id: [9, 1], name: 'Dark' }] },
  { id: [3, 2], type: 'VARIABLE', name: 'brand/primary', key: 'varkey', setKey: 'setkey', varType: 'COLOR', values: [{ mode: [9, 0], color: [0, 0.2, 0.4, 1] }, { mode: [9, 1], color: [0.4, 0.6, 1, 1] }] },
];

export const writeFile = (file: string, data: Buffer) => fs.writeFileSync(file, data);
