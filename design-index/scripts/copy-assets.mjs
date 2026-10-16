import fs from 'node:fs';

fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm', 'dist/resvg.wasm');
fs.cpSync('assets', 'dist/assets', { recursive: true });
