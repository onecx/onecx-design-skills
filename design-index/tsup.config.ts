import { defineConfig } from 'tsup';

// Third-party deps are devDependencies and get bundled: the shipped skill only needs Node >= 22.13.
export default defineConfig({
  entry: { cli: 'src/cli.ts', 'fig-worker': 'src/parsers/fig-worker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  noExternal: [/.*/],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  onSuccess: 'node scripts/copy-assets.mjs',
});
