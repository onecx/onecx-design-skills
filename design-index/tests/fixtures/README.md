# Real `.fig` test files (not in this repository)

`tests/real-files.test.ts` checks the parser against facts that Figma itself saved in real exports (laid-out sizes, the fonts of
its saved glyphs, outlines) and against what Figma renders for authored cases. The files are **not committed**: download them
into a folder of your choice and point `DESIGN_INDEX_FIXTURES` at it. Without the variable (or for a file that is missing) the
tests are skipped.

```bash
mkdir -p ~/fig-fixtures/f2s && cd ~/fig-fixtures
# open-pencil fixtures (Git LFS, pinned commit)
for f in material3 nuxtui gold-preview slots circle-text variable-override-precedence; do
  curl -fLo $f.fig https://media.githubusercontent.com/media/open-pencil/open-pencil/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/$f.fig
done
# OpenFig CLI reference files (pinned commit)
for f in basic-shapes clip-test medium-complex open-peeps; do
  curl -fLo $f.fig https://raw.githubusercontent.com/OpenFig-org/openfig-cli/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/$f.fig
done
# Octopus (opendesigndev) Figma parser test asset (pinned commit)
curl -fLo Complex.fig https://raw.githubusercontent.com/opendesigndev/octopus/c3751d2d458354be118d138df8eb60b8be4bb8d3/packages/octopus-fig/test/integration/figma-parser/assets/aoZAhPTVzGi1rXnU35YPVb/Complex.fig
# fig2sketch test data (pinned commit), into f2s/
for f in broken_images corners noise_and_grain prototyping prototyping_components prototyping_swaps_and_instances sections stacks_wrap structure vector; do
  curl -fLo f2s/$f.fig https://raw.githubusercontent.com/sketch-hq/fig2sketch/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/$f.fig
done

cd <repo>/design-index
DESIGN_INDEX_FIXTURES=~/fig-fixtures npm test      # material3 + nuxtui take about a minute to ingest
```

Never copy these files into the repository (`*.fig` below `tests/fixtures/` is Git-ignored). Check each licence before
redistributing a file.

| File | Source (pinned) | Licence | SHA-256 |
|---|---|---|---|
| `material3.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/material3.fig) | repository MIT (REUSE.toml); content: Google's "Material 3 Design Kit" from Figma Community, CC BY 4.0 | `75c99e40a4a0e62db6e8f1127ef586369cc6737bd8c9f6369191ce7431f43519` |
| `nuxtui.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/nuxtui.fig) | repository MIT (REUSE.toml); content: "Nuxt UI v4 Official Design Kit" from Figma Community, CC BY 4.0 | `add13fd8037ea2d1c3df1e86a224425b0c11dfa093f102a60b9e122ac8ea4361` |
| `gold-preview.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/gold-preview.fig) | MIT (REUSE.toml; authored by the OpenPencil authors) | `8e54efe5f1e11a1bf3cce669a4de8e3fa42047f4325472da2d8cd3b152c2da33` |
| `slots.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/slots.fig) | MIT (REUSE.toml) | `5d3c0855b44db5552c8ac801225062b5f4d88bed08fc7e1a72b829cbb00b29a6` |
| `circle-text.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/circle-text.fig) | MIT (REUSE.toml) | `23fd94a2593021ca996d96ebe33701aca0831936299f2b2da6819f3709f6136a` |
| `variable-override-precedence.fig` | [open-pencil `tests/fixtures`](https://github.com/open-pencil/open-pencil/blob/de913ce91ab83054637269479348c44ada3790aa/tests/fixtures/variable-override-precedence.fig) | MIT (REUSE.toml) | `636796f9c78161e084ebd972b5a7d78a7d7c5211e48047e576249946d3237e78` |
| `basic-shapes.fig` | [OpenFig-org/openfig-cli `test/fixtures/figs/reference`](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/basic-shapes.fig) | MIT (repository LICENSE) | `c7cd6d3a8b338b28ea41c9a101f5eb0eecf731c562111025f9aec5d4ad87b028` |
| `clip-test.fig` | [OpenFig-org/openfig-cli](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/clip-test.fig) | MIT (repository LICENSE) | `9007435e519d652f7b52da67825003d024571cfc24897e6d03c926ae31efa6ed` |
| `medium-complex.fig` | [OpenFig-org/openfig-cli](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/medium-complex.fig) | MIT (repository LICENSE) | `5126634984cb7a441c8c12583f0cef916cf01dee8084c107a2d6abf75b54928e` |
| `open-peeps.fig` | [OpenFig-org/openfig-cli](https://github.com/OpenFig-org/openfig-cli/blob/05f662bfad105d3fd8da8e0cdc0b4e0113e69799/test/fixtures/figs/reference/open-peeps.fig) | MIT (repository LICENSE); no separate licence stated for the illustration content | `2493c670da109daa17ebde8b89a42ae629f37bdfc3565990eef155822f41be3e` |
| `Complex.fig` | [opendesigndev/octopus `packages/octopus-fig/test/integration/figma-parser/assets`](https://github.com/opendesigndev/octopus/blob/c3751d2d458354be118d138df8eb60b8be4bb8d3/packages/octopus-fig/test/integration/figma-parser/assets/aoZAhPTVzGi1rXnU35YPVb/Complex.fig) | Apache-2.0 (repository LICENSE) | `151ee2dcafd30c4b17ef432700ed11e92e8acb8591f9542de4a57937a3d8c81d` |
| `f2s/vector.fig` | [sketch-hq/fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/vector.fig) | MIT (repository LICENSE) | `3802d80f8581af7d4b1aa90ccf946dc1c656fb281daa22cd3eb4b8cad7cfc865` |
| `f2s/broken_images.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/broken_images.fig) | MIT | `0f7534d05369a6739375e6245a9a51a80c30d34999f90d1c817cfcbef2559f79` |
| `f2s/structure.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/structure.fig) | MIT | `2625997d999ecec64de7f8f8c2e4c57a714f1006e362ba79a118ae9606113b50` |
| `f2s/noise_and_grain.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/noise_and_grain.fig) | MIT | `ee3b467033f20fde9255f200eca0cb92e23ee6feeb9087a0f5b47f3a90d0a957` |
| `f2s/corners.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/corners.fig) | MIT | `2d1aa94b4fffa882bb229dfebd7c5e30ed6fc9ae3390071cb40c953ff2d942b6` |
| `f2s/prototyping.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/prototyping.fig) | MIT | `90607b4ccea74b90da359b9888c57cb2e023832b67eefdf3d1c3493f16f6e818` |
| `f2s/prototyping_components.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/prototyping_components.fig) | MIT | `e9d442674128cfdbd5ac4c5a74d329d9cefcd388fd16165d3e47550739cc01cb` |
| `f2s/prototyping_swaps_and_instances.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/prototyping_swaps_and_instances.fig) | MIT | `ee6be08d435d833fa3c399b369acab370faa385ad6456fe2599fdfd1e6207315` |
| `f2s/sections.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/sections.fig) | MIT | `7b2693f9bd69ddad2f91404a6bb1041931bd4744f5b52644b8fc74b4868fd768` |
| `f2s/stacks_wrap.fig` | [fig2sketch `tests/data`](https://github.com/sketch-hq/fig2sketch/blob/4eddfd4f4e6185264ab59a3a65922a33843fc34d/tests/data/stacks_wrap.fig) | MIT | `92f15ff966fb78c2db369d4d2b2430a2f8eaae1642525916c693443f94eafa12` |

The open-pencil files are stored in Git LFS: use the `media.githubusercontent.com` URLs above (the `raw.githubusercontent.com`
URL returns the LFS pointer). Files with no stated licence (for example the Microsoft download-centre samples used during the
research) are deliberately not listed and must not be used in shared test setups.
