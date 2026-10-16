#!/usr/bin/env node
// Synthetic large .fig: duplicates nodes of an existing .fig (new guid space per copy) and its images (perturbed content).
// usage: node scripts/gen-fig.mjs <src.fig> <out.fig> --canvas-copies N --image-copies M
// Works node-by-node (no full object graph), the generator itself stays at a few hundred MB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ByteBuffer, compileSchema, decodeBinarySchema } from 'kiwi-schema';

const args = process.argv.slice(2);
const [src, out] = args;
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : Number(args[i + 1]); };
const canvasCopies = opt('--canvas-copies', 1), imageCopies = opt('--image-copies', 1);
if (!src || !out) { console.error('usage: gen-fig.mjs <src.fig> <out.fig> --canvas-copies N --image-copies M'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genfig-'));
execFileSync('unzip', ['-q', '-o', src, '-d', tmp]);
const canvas = fs.readFileSync(path.join(tmp, 'canvas.fig'));
const dec = (c) => (c.readUInt32LE(0) === 0xfd2fb528 ? zlib.zstdDecompressSync(c) : zlib.inflateRawSync(c));
let o = 12; const chunks = [];
while (o + 4 <= canvas.length) { const n = canvas.readUInt32LE(o); o += 4; chunks.push(canvas.subarray(o, o + n)); o += n; }
const sb = decodeBinarySchema(dec(chunks[0]));
const schema = compileSchema(sb);
const data = dec(chunks[1]);
const msgDef = sb.definitions.find((d) => d.name === 'Message');
const fields = new Map(msgDef.fields.map((f) => [f.value, f]));
const ncField = msgDef.fields.find((f) => f.name === 'nodeChanges');

// pass 1: decode node by node, keep the first copy's raw bytes ranges; re-encode copies with shifted guids
const bb = new ByteBuffer(data);
const outBB = new ByteBuffer();
const SHIFT = 1_000_000;
const shiftGuid = (g, k) => (g ? { sessionID: g.sessionID + k * SHIFT, localID: g.localID } : g);
let nodeCount = 0;
const structural = new Set(['DOCUMENT', 'CANVAS', 'VARIABLE_SET', 'VARIABLE']);
const nodesOut = [];
for (;;) {
  const fid = bb.readVarUint();
  if (fid === 0) break;
  const f = fields.get(fid);
  if (f.name === 'nodeChanges') {
    const len = bb.readVarUint();
    for (let i = 0; i < len; i++) nodesOut.push(schema.decodeNodeChange(bb));
    nodeCount = len;
  } else if (f.name === 'blobs') {
    const len = bb.readVarUint();
    outBB.writeVarUint(fid);
    outBB.writeVarUint(len);
    for (let i = 0; i < len; i++) schema.encodeBlob(schema.decodeBlob(bb), outBB);
    // nodeChanges field is written last in our output, ordering of fields does not matter for the reader
  } else {
    // any other message field: read generically and copy its raw bytes
    const defs = new Map(sb.definitions.map((d) => [d.name, d]));
    const readScalar = (ff) => {
      switch (ff.type) {
        case 'bool': return bb.readByte();
        case 'byte': return bb.readByte();
        case 'int': return bb.readVarInt();
        case 'uint': return bb.readVarUint();
        case 'float': return bb.readVarFloat();
        case 'string': return bb.readString();
        case 'int64': return bb.readVarInt64();
        case 'uint64': return bb.readVarUint64();
        default: { const d = defs.get(ff.type); return d.kind === 'ENUM' ? bb.readVarUint() : schema['decode' + d.name](bb); }
      }
    };
    const startIdx = bb._index;
    if (f.isArray) { if (f.type === 'byte') bb.readByteArray(); else { const len = bb.readVarUint(); for (let i = 0; i < len; i++) readScalar(f); } } else readScalar(f);
    outBB.writeVarUint(fid);
    for (const byte of data.subarray(startIdx, bb._index)) outBB.writeByte(byte);
  }
}
// write nodeChanges
const total = nodesOut.filter((n) => !structural.has(n.type)).length * canvasCopies + nodesOut.filter((n) => structural.has(n.type)).length;
outBB.writeVarUint(ncField.value);
outBB.writeVarUint(total);
const canvasIds = new Set(nodesOut.filter((n) => n.type === 'CANVAS').map((n) => `${n.guid.sessionID}:${n.guid.localID}`));
for (const n of nodesOut) if (structural.has(n.type)) schema.encodeNodeChange(n, outBB);
for (let k = 0; k < canvasCopies; k++) {
  for (const n of nodesOut) {
    if (structural.has(n.type)) continue;
    if (k === 0) { schema.encodeNodeChange(n, outBB); continue; }
    const c = { ...n, guid: shiftGuid(n.guid, k) };
    if (n.parentIndex) {
      const pg = n.parentIndex.guid;
      const isRoot = canvasIds.has(`${pg.sessionID}:${pg.localID}`);
      c.parentIndex = { ...n.parentIndex, guid: isRoot ? pg : shiftGuid(pg, k) };
    }
    if (n.symbolData?.symbolID) c.symbolData = { ...n.symbolData, symbolID: shiftGuid(n.symbolData.symbolID, k) };
    schema.encodeNodeChange(c, outBB);
  }
}
outBB.writeVarUint(0);
const message = Buffer.from(outBB.toUint8Array());
console.log(`nodes ${nodeCount} -> ${total}, decompressed canvas ${(message.length / 1e6).toFixed(1)} MB`);
const head = Buffer.alloc(12); head.write('fig-kiwi', 0, 'latin1'); head.writeUInt32LE(canvas.readUInt32LE(8), 8);
const len4 = (b) => { const x = Buffer.alloc(4); x.writeUInt32LE(b.length); return x; };
const schemaChunk = chunks[0];
const dataChunk = zlib.zstdCompressSync(message);
const newCanvas = Buffer.concat([head, len4(schemaChunk), schemaChunk, len4(dataChunk), dataChunk]);

// ZIP with deflate entries, written incrementally
const fd = fs.openSync(out, 'w');
let offset = 0;
const central = [];
const entry = (name, buf) => {
  const nameB = Buffer.from(name);
  const comp = zlib.deflateRawSync(buf, { level: 1 });
  const crc = zlib.crc32(buf) >>> 0;
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(buf.length, 22); lh.writeUInt16LE(nameB.length, 26);
  fs.writeSync(fd, lh); fs.writeSync(fd, nameB); fs.writeSync(fd, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(buf.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
  central.push(ch, nameB);
  offset += 30 + nameB.length + comp.length;
};
entry('canvas.fig', newCanvas);
entry('meta.json', fs.readFileSync(path.join(tmp, 'meta.json')));
let nImg = 0, imgBytes = 0;
const imgDir = path.join(tmp, 'images');
for (const name of fs.existsSync(imgDir) ? fs.readdirSync(imgDir) : []) {
  const buf = fs.readFileSync(path.join(imgDir, name));
  for (let k = 0; k < imageCopies; k++) {
    // k=0 keeps the original name (referenced by fills); copies get perturbed content so they are distinct assets
    const b = k === 0 ? buf : Buffer.concat([buf, crypto.randomBytes(16)]);
    entry(`images/${k === 0 ? name : crypto.createHash('sha1').update(b).digest('hex')}`, b);
    nImg++; imgBytes += b.length;
  }
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22);
const entries = central.length / 2;
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
fs.writeSync(fd, cd); fs.writeSync(fd, end);
fs.closeSync(fd);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out}: ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${nImg} images (${(imgBytes / 1e6).toFixed(1)} MB)`);
