#!/usr/bin/env node
// Synthetic large .pen: repeats the top-level frames of an existing .pen (fresh ids) and mixes in base64 image frames.
// usage: node scripts/gen-pen.mjs <src.pen> <out.pen> <targetMB> [imageShare=0.25]
import fs from 'node:fs';
import crypto from 'node:crypto';

const [src, out, targetMB, share = '0.25'] = process.argv.slice(2);
if (!src || !out || !targetMB) { console.error('usage: gen-pen.mjs <src.pen> <out.pen> <targetMB> [imageShare]'); process.exit(1); }
const text = fs.readFileSync(src, 'utf8');
const start = text.indexOf('"children": [') + '"children": ['.length;
const end = text.lastIndexOf('\n  ]');
const body = text.slice(start, end);
// top-level children are the objects indented by exactly 4 spaces
const blocks = [];
const re = /\n    \{\n[\s\S]*?\n    \}(?=,?\n|$)/g;
for (let m; (m = re.exec(body)); ) blocks.push(m[0].slice(1));
if (!blocks.length) throw new Error('no top-level children found');
const target = Number(targetMB) * 1e6;
const imgBudget = target * Number(share);
const fd = fs.openSync(out, 'w');
let written = 0;
const w = (s) => { const b = Buffer.from(s); fs.writeSync(fd, b); written += b.length; };
w('{\n  "version": "2.21",\n  "children": [\n');
let i = 0, first = true, imgBytes = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(1_500_000)]);
// 1) base64 image frames up to the image share
while (imgBytes < imgBudget) {
  png[20] = i & 255; png[21] = (i >> 8) & 255; png[22] = (i >> 16) & 255;
  const b64 = png.toString('base64');
  w((first ? '' : ',\n') + `    { "type": "frame", "id": "img~${i}", "name": "Image board ${i}", "x": ${i * 50}, "y": 100000, "width": 2000, "height": 1200, "fill": { "type": "image", "url": "data:image/png;base64,${b64}", "mode": "cover" } }`);
  first = false; imgBytes += b64.length; i++;
}
// 2) repeat top-level frames (smallest first, fresh ids per round) until the target size is reached
const order = blocks.map((b, idx) => [b.length, idx]).sort((a, b) => a[0] - b[0]);
let repeated = 0;
for (let round = 0; written < target; round++) {
  let progressed = false;
  for (const [len, idx] of order) {
    if (written + len > target * 1.01) continue;
    let blk = blocks[idx];
    if (round > 0 || true) blk = blk.replace(/"id": "([^"]+)"/g, (_, id) => `"id": "${id}~${round}"`);
    w((first ? '' : ',\n') + blk); first = false; repeated++; progressed = true;
    if (written >= target) break;
  }
  if (!progressed) break;
}
i = repeated;
w('\n  ]\n}\n');
fs.closeSync(fd);
console.log(`${out}: ${(written / 1e6).toFixed(1)} MB, ${i} repeated top-level frames, ${(imgBytes / 1e6).toFixed(1)} MB base64 images`);
