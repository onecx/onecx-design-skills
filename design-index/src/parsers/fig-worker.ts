// Worker thread: decodes canvas.fig (Kiwi) node by node and streams rows to the main thread.
// The Kiwi container cannot be streamed byte-wise (zstd/deflate frame + schema first), so the decompressed message
// buffer lives in this worker. The decoded NodeChange objects do NOT: each is converted and dropped immediately,
// which keeps the heap flat instead of growing with the node count (see README measurements).
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ByteBuffer, compileSchema, decodeBinarySchema } from 'kiwi-schema';
import type { ComponentRow, InteractionRow, NodeRow, NoteRow, VariableRow } from '../model.js';
import { blobToPath, colorHex, convertNode, geometryData, guidStr, propDefault, SKIP_TYPES, variantFromName, type Ctx, type GeomRef, type StyleDef, type StyleUse } from './fig-convert.js';

type Any = Record<string, any>;
export interface FigInit { canvasFile: string; imageMap: Record<string, string>; ack: SharedArrayBuffer }

// header versions decoded and checked against real files; the header does not identify the schema (it is embedded in the file)
const TESTED_VERSIONS = new Set([1, 2, 3, 4, 10, 15, 20, 25, 48, 63, 80, 87, 101, 106]);
const init = workerData as FigInit;
const port = parentPort!;
const ack = new Int32Array(init.ack);
let sent = 0;

function send(msg: unknown): void {
  port.postMessage(msg);
  sent++;
  // backpressure: never run more than 6 batches ahead of the writer
  while (sent - Atomics.load(ack, 0) > 6) Atomics.wait(ack, 0, Atomics.load(ack, 0), 500);
}

const dec = (c: Buffer, what = 'Chunk'): Buffer => {
  try { return c.length >= 4 && c.readUInt32LE(0) === 0xfd2fb528 ? zlib.zstdDecompressSync(c) : zlib.inflateRawSync(c); }
  catch (e) { throw new Error(`canvas.fig is corrupt or uses an unknown compression format (${what}: ${(e as Error).message}; expected zstd or deflate-raw)`); }
};

function main(): void {
  let file: Buffer | null = fs.readFileSync(init.canvasFile);
  const magic = file.subarray(0, 8).toString('latin1');
  if (magic !== 'fig-kiwi' && magic !== 'fig-jam.' && magic !== 'fig-deck') throw new Error(`canvas.fig has unknown header "${magic.replace(/[^\x20-\x7e]/g, '?')}" (expected "fig-kiwi")`);
  const version = file.readUInt32LE(8);
  const warns = new Map<string, number>();
  const warn = (m: string) => warns.set(m, (warns.get(m) ?? 0) + 1);
  if (magic === 'fig-jam.') warn('FigJam file (fig-jam): only partially tested');
  if (magic === 'fig-deck') warn('Figma Slides file (fig-deck): only partially tested');
  if (!TESTED_VERSIONS.has(version)) warn(`fig-kiwi version ${version} is untested (tested: ${[...TESTED_VERSIONS].join(', ')}); structure is validated`);
  let chunks: Buffer[] = [];
  for (let o = 12; o + 4 <= file.length; ) {
    const n = file.readUInt32LE(o); o += 4;
    if (n > file.length - o) throw new Error('canvas.fig is truncated or corrupt (chunk length exceeds the file)');
    chunks.push(file.subarray(o, o + n)); o += n;
  }
  if (chunks.length < 2) throw new Error(`canvas.fig contains ${chunks.length} chunk(s), expected: schema + data`);
  if (chunks.length > 2) warn(`${chunks.length} chunks instead of 2 (extra chunks are ignored)`);
  const sb = decodeBinarySchema(dec(chunks[0], 'Schema-Chunk'));
  const defs = new Map<string, any>(sb.definitions.map((d: any) => [d.name, d]));
  const msgDef = defs.get('Message');
  const ncDef = defs.get('NodeChange');
  if (!msgDef || !ncDef || !msgDef.fields.some((f: any) => f.name === 'nodeChanges') || !['guid', 'type', 'parentIndex'].every((k) => ncDef.fields.some((f: any) => f.name === k))) {
    throw new Error(`Unknown .fig structure (fig-kiwi version ${version}): schema has no Message.nodeChanges/NodeChange{guid,type,parentIndex}. The parser needs to be adapted for this version.`);
  }
  const schema: any = compileSchema(sb);
  const data = dec(chunks[1], 'Daten-Chunk');
  // the compressed copies are no longer needed: release them before the long decode loop
  chunks = []; file = null;
  const dataLen = data.length;
  const bb: any = new ByteBuffer(data);
  const fieldById = new Map<number, any>(msgDef.fields.map((f: any) => [f.value, f]));

  // ---- state kept for the whole stream (small: ids, names, buffered component/variable records) ----
  const usageMap = new Map<string, number>();
  const ctx: Ctx = { imageMap: init.imageMap, usage: (k, v) => usageMap.set(k + '\u0000' + v, (usageMap.get(k + '\u0000' + v) ?? 0) + 1), warn };
  let nodes: NodeRow[] = [];
  let geomsOut: [string, string][] = [];
  let pdefsOut: Any[] = [];
  let derivedOut: Any[] = [];
  let inters: InteractionRow[] = [];
  let notes: NoteRow[] = [];
  const canvases: { id: string; name: string; pos: string; internal: boolean }[] = [];
  const sets = new Map<string, { name: string; modes: Map<string, string> }>();
  const setByKey = new Map<string, string>();
  const vars: { guid: string; key?: string; name: string; setKey?: string; setGuid?: string; type: string; entries: Any[] }[] = [];
  const stackModes = new Map<string, string>();
  const flagged: { id: string; parent: string; grow: boolean; stretch: boolean; abs: boolean }[] = [];
  const propNames = new Map<string, string>();
  // shared styles: definitions by guid and key, and the nodes that use them (resolved after the stream)
  const styleDefs: Record<string, StyleDef> = {};
  const styleUses: [string, StyleUse][] = [];
  const textVars: [string, string][] = [];
  const stateGroups = new Map<string, { name: string; defs: Map<string, string> }>();
  const symbols: { id: string; name: string; desc: string; parent: string | null; specs: Any[]; ownDefs: Any[] }[] = [];
  const geomPending: { id: string; refs: GeomRef[] }[] = [];
  const neededBlobs = new Set<number>();
  const seenGeom = new Set<string>();
  let nNodes = 0;
  let maxHeap = 0;
  let colorProfile: string | undefined;

  const flush = (force = false) => {
    if (!force && nodes.length < 1000 && derivedOut.length < 5000) return;
    if (!nodes.length && !geomsOut.length && !inters.length && !notes.length && !pdefsOut.length && !derivedOut.length) return;
    send({ t: 'rows', nodes, geoms: geomsOut, inters, notes, pdefs: pdefsOut, derived: derivedOut });
    nodes = []; geomsOut = []; inters = []; notes = []; pdefsOut = []; derivedOut = [];
  };

  const handle = (n: Any): void => {
    if (n.phase === 'REMOVED') return;
    const t: string = n.type;
    const id = guidStr(n.guid)!;
    if (t === 'DOCUMENT') {
      // colours of a Display-P3 document are P3 values: converted to sRGB from here on (the document record comes first)
      if (n.documentColorProfile) { colorProfile = String(n.documentColorProfile); ctx.p3 = colorProfile === 'DISPLAY_P3'; if (ctx.p3 && nNodes) warn('Display-P3 document record after other nodes: earlier colours were not converted'); }
      return;
    }
    if (SKIP_TYPES.has(t)) return;
    if (t === 'CANVAS') {
      const name = n.name ?? '';
      canvases.push({ id, name, pos: n.parentIndex?.position ?? '', internal: !!n.internalOnly || /^internal only canvas$/i.test(name) });
      return;
    }
    if (t === 'VARIABLE_SET') {
      sets.set(id, { name: n.name ?? '', modes: new Map((n.variableSetModes ?? []).map((m: Any) => [guidStr(m.id)!, m.name])) });
      if (n.key) setByKey.set(n.key, id);
      return;
    }
    if (t === 'VARIABLE') {
      const ref = n.variableSetID;
      vars.push({ guid: id, key: n.key, name: n.name ?? id, setKey: ref?.assetRef?.key, setGuid: guidStr(ref?.guid) ?? undefined, type: n.variableResolvedType, entries: n.variableDataValues?.entries ?? [] });
      return;
    }
    const c = convertNode(n, ctx);
    nNodes++;
    if (n.componentPropDefs?.length) for (const d of n.componentPropDefs) if (d.name) propNames.set(guidStr(d.id)!, d.name);
    if (n.isStateGroup) {
      const m = new Map<string, string>();
      for (const d of n.componentPropDefs ?? []) if (d.name) m.set(guidStr(d.id)!, d.name);
      stateGroups.set(id, { name: n.name ?? '', defs: m });
    }
    if (c.styleDef) { styleDefs[id] = c.styleDef; if (n.key) styleDefs[n.key] = c.styleDef; }
    if (c.styleUse) styleUses.push([id, c.styleUse]);
    if (c.textVar) textVars.push([id, c.textVar]);
    if (c.stackMode) stackModes.set(id, c.stackMode);
    if (c.childFlags && c.parent) flagged.push({ id, parent: c.parent, grow: c.childFlags.grow, stretch: c.childFlags.stretch, abs: !!c.row.layout?.abs });
    if (t === 'SYMBOL') {
      symbols.push({
        id, name: n.name ?? '', desc: n.symbolDescription ?? '', parent: c.parent, specs: n.variantPropSpecs ?? [],
        ownDefs: (n.componentPropDefs ?? []).filter((d: Any) => d.type && d.type !== 'VARIANT'),
      });
    }
    if (c.propdefs) pdefsOut.push(...c.propdefs);
    if (c.derived) for (const d of c.derived) {
      const { g, sg, ...rest } = d;
      // identical shapes share their blobs: store each geometry once, keyed by its blob indexes (and region styles)
      const keyOf = (refs: GeomRef[] | undefined, prefix: string): string | null => {
        if (!refs) return null;
        const key = `${prefix}:${refs.map((r) => (r.sid ? `${r.blob}.${r.sid}` : r.blob) + (r.rule === 'ODD' ? 'o' : '')).join(',')}`;
        if (!seenGeom.has(key)) { seenGeom.add(key); geomPending.push({ id: key, refs }); for (const r of refs) neededBlobs.add(r.blob); }
        return key;
      };
      derivedOut.push({ inst: id, ...rest, geom: keyOf(g, 'g'), sg: keyOf(sg, 's') });
    }
    if (c.geomRefs) { geomPending.push({ id, refs: c.geomRefs }); for (const r of c.geomRefs) neededBlobs.add(r.blob); }
    for (const pi of n.prototypeInteractions ?? []) {
      if (pi.isDeleted) continue;
      const trigger = pi.event?.interactionType ?? 'UNKNOWN';
      const actions: Any[] = pi.actions?.length ? pi.actions : [{}];
      for (const a of actions) {
        inters.push({ node_id: id, trigger, action: a.navigationType ?? a.connectionType ?? 'NONE', target_id: guidStr(a.transitionNodeID), detail: a.connectionURL ?? (a.transitionType ? `${a.transitionType}${a.transitionDuration ? ' ' + a.transitionDuration + 's' : ''}` : undefined) });
      }
    }
    if (n.description && t !== 'SYMBOL' && String(n.description).trim()) notes.push({ node_id: id, kind: 'description', text: String(n.description) });
    if ((t === 'STICKY' || t === 'SHAPE_WITH_TEXT' || t === 'CODE_BLOCK') && c.row.text) notes.push({ node_id: id, kind: t.toLowerCase(), text: c.row.text });
    nodes.push(c.row);
    if (nodes.length >= 1000 || derivedOut.length >= 5000 || pdefsOut.length >= 5000) flush(true);
    if (nNodes % 5000 === 0) {
      maxHeap = Math.max(maxHeap, process.memoryUsage().heapUsed);
      port.postMessage({ t: 'progress', frac: bb._index / dataLen, heapMB: Math.round(maxHeap / 1e6) });
    }
  };

  // ---- generic message reader: stream nodeChanges/blobs, read-and-ignore every other field ----
  const blobData = new Map<number, Uint8Array>();
  const readScalar = (f: any): unknown => {
    switch (f.type) {
      case 'bool': return !!bb.readByte();
      case 'byte': return bb.readByte();
      case 'int': return bb.readVarInt();
      case 'uint': return bb.readVarUint();
      case 'float': return bb.readVarFloat();
      case 'string': return bb.readString();
      case 'int64': return bb.readVarInt64();
      case 'uint64': return bb.readVarUint64();
      default: {
        const d = defs.get(f.type);
        if (!d) throw new Error(`Unknown type ${f.type} in the Kiwi schema`);
        return d.kind === 'ENUM' ? schema[d.name][bb.readVarUint()] : schema['decode' + d.name](bb);
      }
    }
  };
  let blobBase = 0;
  const readBlobs = (base: number): void => {
    const len = bb.readVarUint();
    for (let i = 0; i < len; i++) {
      const b = schema.decodeBlob(bb);
      if (neededBlobs.has(i + base)) blobData.set(i + base, new Uint8Array(b.bytes));
    }
  };
  // Kiwi does not fix the field order: blobs that come before the nodes are read again once the nodes have said which ones they need
  const earlyBlobs: { at: number; base: number }[] = [];
  let nodesDone = false;
  for (;;) {
    const fid = bb.readVarUint();
    if (fid === 0) break;
    const f = fieldById.get(fid);
    if (!f) throw new Error(`Unexpected field ${fid} in the Kiwi message (version ${version})`);
    if (f.name === 'nodeChanges' && f.isArray) {
      const len = bb.readVarUint();
      for (let i = 0; i < len; i++) handle(schema.decodeNodeChange(bb));
      nodesDone = true;
    } else if (f.name === 'blobs' && f.isArray) {
      if (!nodesDone) earlyBlobs.push({ at: bb._index, base: blobBase });
      readBlobs(blobBase);
    } else if (f.name === 'blobBaseIndex') blobBase = Number(readScalar(f));
    else if (f.isArray) {
      if (f.type === 'byte') bb.readByteArray();
      else { const len = bb.readVarUint(); for (let i = 0; i < len; i++) readScalar(f); }
    } else readScalar(f);
  }
  for (const e of earlyBlobs) { bb._index = e.at; readBlobs(e.base); }
  flush(true);
  if (process.env.DESIGN_INDEX_DEBUG) {
    let bytes = 0; for (const b of blobData.values()) bytes += b.length;
    console.error(JSON.stringify({ heapMB: Math.round(process.memoryUsage().heapUsed / 1e6), blobs: blobData.size, blobMB: Math.round(bytes / 1e6), geomPending: geomPending.length, styleUses: styleUses.length, styleDefs: Object.keys(styleDefs).length, textVars: textVars.length, seenGeom: seenGeom.size, flagged: flagged.length }));
  }

  // ---- geometry (blobs arrive after the nodes) ----
  for (const g of geomPending) {
    const d = geometryData(g.refs.map((r) => { const b = blobData.get(r.blob); return { d: b ? blobToPath(b) : '', rule: r.rule, sid: r.sid }; }));
    if (d) geomsOut.push([g.id, d]);
    if (geomsOut.length >= 500) flush(true);
  }
  flush(true);

  // ---- children that fill their auto-layout parent ----
  const fixups: [string, string, string][] = [];
  for (const f of flagged) {
    const mode = stackModes.get(f.parent);
    if (!mode || mode === 'GRID' || f.abs) continue;
    const row = mode === 'HORIZONTAL';
    if (f.grow) fixups.push([f.id, row ? 'w' : 'h', 'fill']);
    if (f.stretch) fixups.push([f.id, row ? 'h' : 'w', 'fill']);
  }

  // ---- variables ----
  const idOfGuid = new Map<string, string>();
  for (const v of vars) idOfGuid.set(v.guid, v.key ?? v.guid);
  const kind: Record<string, string> = { COLOR: 'color', FLOAT: 'number', STRING: 'string', BOOLEAN: 'boolean' };
  const variables: VariableRow[] = vars.map((v) => {
    const set = sets.get(v.setKey ? setByKey.get(v.setKey) ?? '' : v.setGuid ?? '');
    const values: Record<string, unknown> = {};
    for (const e of v.entries) {
      const mode = set?.modes.get(guidStr(e.modeID)!) ?? guidStr(e.modeID)!;
      const val = e.variableData?.value ?? {};
      let out: unknown;
      if (val.alias) out = 'alias:' + (val.alias.assetRef?.key ?? idOfGuid.get(guidStr(val.alias.guid)!) ?? guidStr(val.alias.guid));
      else if (val.colorValue) out = colorHex(val.colorValue, 1, ctx.p3); else if (val.floatValue !== undefined) out = Math.round(val.floatValue * 1000) / 1000;
      else if (val.boolValue !== undefined) out = val.boolValue;
      else if (val.textValue !== undefined) out = typeof val.textValue === 'string' ? val.textValue : val.textValue?.characters ?? '';
      else out = null;
      values[mode] = out;
    }
    return { id: v.key ?? v.guid, guid: v.guid, name: v.name, collection: set?.name ?? '', type: kind[v.type] ?? String(v.type ?? '').toLowerCase(), values };
  });

  // ---- components with variant sets ----
  const components: ComponentRow[] = symbols.map((s) => {
    const sg = s.parent ? stateGroups.get(s.parent) : undefined;
    let variant: Record<string, string> | null = null;
    if (s.specs.length) {
      variant = {};
      for (const sp of s.specs) variant[sg?.defs.get(guidStr(sp.propDefId)!) ?? propNames.get(guidStr(sp.propDefId)!) ?? 'Property'] = String(sp.value);
    } else variant = variantFromName(s.name);
    const props: Record<string, unknown> = {};
    for (const d of s.ownDefs) {
      // v106 keeps the default only in varValue (initialValue empty)
      const v = propDefault(d);
      const val = typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number' ? v : undefined;
      props[d.name] = `${d.type}${val !== undefined ? '=' + JSON.stringify(val) : ''}`;
    }
    return {
      id: s.id, name: s.name, page: 0, description: s.desc,
      set_id: sg ? s.parent : null, set_name: sg?.name ?? null, variant, props: Object.keys(props).length ? props : null,
    };
  });

  const usage: [string, string, number][] = [...usageMap].map(([k, n]) => { const [a, b] = k.split('\u0000'); return [a, b, n]; });
  canvases.sort((a, b) => Number(a.internal) - Number(b.internal) || (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
  send({
    t: 'done', canvases, variables, components, fixups, usage, warns: [...warns], propNames: Object.fromEntries(propNames), styleDefs, styleUses, textVars,
    varmodes: [...sets].flatMap(([sid, st]) => [...st.modes].map(([mid, mname]) => ({ set_id: sid, set_key: [...setByKey].find(([, v]) => v === sid)?.[0] ?? null, set_name: st.name, mode_id: mid, mode_name: mname }))),
    colorProfile,
    stats: { nodes: nNodes, version, uncompressedMB: Math.round(dataLen / 1e5) / 10, maxHeapMB: Math.round(Math.max(maxHeap, process.memoryUsage().heapUsed) / 1e6) },
  });
}

try { main(); } catch (e) { port.postMessage({ t: 'error', message: (e as Error).message }); }
