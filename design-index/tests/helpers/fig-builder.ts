// Builds tiny synthetic .fig files (raw fig-kiwi and ZIP) with a reduced Kiwi schema. No customer data involved.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';

const SCHEMA = `
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; TEXT = 3; SYMBOL = 4; INSTANCE = 5; VECTOR = 6; VARIABLE_SET = 7; VARIABLE = 8; ROUNDED_RECTANGLE = 9; }
enum PaintType { SOLID = 0; }
enum VarType { COLOR = 0; FLOAT = 1; }
message AssetRef { string key = 1; }
message SetRef { AssetRef assetRef = 1; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; }
message TextData { string characters = 1; }
enum PropField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; }
message PropRef { GUID defID = 1; PropField componentPropNodeField = 2; }
message SymbolIdValue { GUID guid = 1; }
message PropValue { bool boolValue = 1; TextData textDataValue = 2; SymbolIdValue symbolIdValue = 3; }
message PropAssign { GUID defID = 1; PropValue value = 2; }
message PropDefMsg { GUID id = 1; string name = 2; PropValue initialValue = 3; GUID parentPropDefId = 4; }
message Geom { uint commandsBlob = 1; }
message Derived { GUIDPath guidPath = 1; Vector size = 2; Matrix transform = 3; Geom[] strokeGeometry = 4; }
message GUIDPath { GUID[] guids = 1; }
message OverrideEntry { GUIDPath guidPath = 1; float fontSize = 2; Paint[] fillPaints = 3; TextData textData = 4; bool visible = 5; GUID overriddenSymbolID = 6; PropAssign[] componentPropAssignments = 7; }
message SymbolData { GUID symbolID = 1; OverrideEntry[] symbolOverrides = 2; }
message ModeRef { GUID id = 1; string name = 2; }
message VarValue { Color colorValue = 1; float floatValue = 2; }
message VarData { VarValue value = 1; }
message VarEntry { GUID modeID = 1; VarData variableData = 2; }
message VarValues { VarEntry[] entries = 1; }
message NodeChange {
  GUID guid = 1; NodeType type = 2; string name = 3; ParentIndex parentIndex = 4; Vector size = 5; Matrix transform = 6;
  TextData textData = 7; float fontSize = 8; StackMode stackMode = 9; float stackSpacing = 10; bool visible = 11;
  Paint[] fillPaints = 12; SymbolData symbolData = 13; ModeRef[] variableSetModes = 14; VarValues variableDataValues = 15; string key = 16;
  string symbolDescription = 17; uint[] fillGeometryBlobs = 18; SetRef variableSetID = 19; VarType variableResolvedType = 20;
  GUID overrideKey = 21; PropDefMsg[] componentPropDefs = 22; PropRef[] componentPropRefs = 23; PropAssign[] componentPropAssignments = 24; Derived[] derivedSymbolData = 25;
  float cornerRadius = 26; float rectangleTopLeftCornerRadius = 27; bool rectangleCornerRadiiIndependent = 28; float strokeWeight = 29; float borderTopWeight = 30; bool borderStrokeWeightsIndependent = 31; Paint[] strokePaints = 32;
}
message Blob { byte[] bytes = 1; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
`;

export type PV = { b: boolean } | { t: string } | { sym: [number, number] };
export interface Assign { def: [number, number]; v: PV }
const pv = (v: PV) => ('b' in v ? { boolValue: v.b } : 't' in v ? { textDataValue: { characters: v.t } } : { symbolIdValue: { guid: { sessionID: v.sym[0], localID: v.sym[1] } } });

export interface FigNode {
  id: [number, number]; type: string; name?: string; parent?: [number, number]; pos?: string; w?: number; h?: number; x?: number; y?: number;
  text?: string; stack?: 'HORIZONTAL' | 'VERTICAL'; gap?: number; fill?: [number, number, number]; symbol?: [number, number]; desc?: string;
  overrides?: { path: [number, number][]; fontSize?: number; fill?: [number, number, number]; text?: string; visible?: boolean; swap?: [number, number]; assign?: Assign[] }[];
  ok?: [number, number]; defs?: { id: [number, number]; init?: PV }[]; refs?: { def: [number, number]; field: 'VISIBLE' | 'TEXT_DATA' | 'OVERRIDDEN_SYMBOL_ID' }[]; assign?: Assign[]; derived?: { path: [number, number][]; w: number; h: number; x: number; y: number; noStroke?: boolean }[];
  radius?: { cornerRadius?: number; tl?: number; indep?: boolean }; stroke?: { w: number; top?: number; indep?: boolean }; visibleFlag?: boolean;
  modes?: { id: [number, number]; name: string }[]; key?: string; setKey?: string; varType?: 'COLOR' | 'FLOAT'; values?: { mode: [number, number]; color?: [number, number, number, number]; num?: number }[];
}

const g = (a: [number, number]) => ({ sessionID: a[0], localID: a[1] });

export function buildFig(nodes: FigNode[], opts: { version?: number } = {}): Buffer {
  const schemaObj = parseSchema(SCHEMA);
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
      componentPropDefs: n.defs?.map((d) => ({ id: g(d.id), name: 'p', initialValue: d.init ? pv(d.init) : undefined })),
      componentPropRefs: n.refs?.map((r) => ({ defID: g(r.def), componentPropNodeField: r.field })),
      componentPropAssignments: n.assign?.map((a) => ({ defID: g(a.def), value: pv(a.v) })),
      derivedSymbolData: n.derived?.map((d) => ({ guidPath: { guids: d.path.map(g) }, size: { x: d.w, y: d.h }, transform: { m00: 1, m01: 0, m02: d.x, m10: 0, m11: 1, m12: d.y }, strokeGeometry: d.noStroke ? [] : undefined })),
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
        })),
      } : undefined,
      symbolDescription: n.desc, key: n.key,
      variableSetID: n.setKey ? { assetRef: { key: n.setKey } } : undefined, variableResolvedType: n.varType,
      variableSetModes: n.modes?.map((m) => ({ id: g(m.id), name: m.name })),
      variableDataValues: n.values ? { entries: n.values.map((v) => ({ modeID: g(v.mode), variableData: { value: v.color ? { colorValue: { r: v.color[0], g: v.color[1], b: v.color[2], a: v.color[3] } } : { floatValue: v.num } } })) } : undefined,
    })),
    blobs: [],
  };
  const schemaChunk = zlib.deflateRawSync(Buffer.from(encodeBinarySchema(schemaObj)));
  const dataChunk = zlib.zstdCompressSync(Buffer.from(schema.encodeMessage(msg)));
  const head = Buffer.alloc(12);
  head.write('fig-kiwi', 0, 'latin1');
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
