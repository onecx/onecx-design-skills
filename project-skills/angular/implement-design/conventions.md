# Conventions (Angular)

Filled in by the agent during "Detect the project" and updated when the dependencies change. Replace every `(not detected yet)` / `(path)` with the real value (the agent must fill this file before writing code); delete the hint lines when done.
Keep this file under 100 lines. It records what the repo already does; do not add framework knowledge from memory here.

Dependency fingerprint: (hash or list of the main dependency versions from package.json / lockfile; compare it on every session)

## Detected
- Framework + version: (not detected yet)
- Language / strictness (TypeScript or JavaScript): (not detected yet)
- Build tool / workspace: (not detected yet)
- Styling approach: (not detected yet)
- State handling: (not detected yet)
- Component style (file layout, naming, one component per file?): (not detected yet)
- Workspace type (CLI, Nx; app or library): (not detected yet)
- Template style / control flow in use: (not detected yet)
- Component library (Material, PrimeNG, none): (not detected yet)
- i18n mechanism: (not detected yet)
- Test setup and commands: (not detected yet)
- Lint / format / type-check commands: (not detected yet)

## Design integration
- Token file (output of `design-query tokens --format css --out …`): `src/styles/tokens.generated.css` (keep this name and path; generated, never edited)
- Where the token file is imported: `angular.json` `styles` array, once
- Asset directory for `design-query assets export --out …`: (path)
- Where screens / pages live: (path)
- Where shared components live: (path)

## Existing CSS
Filled in during phase A of `spec-to-css.md` (inventory), one line per item; update it when you add a shared class or component. Reuse these before writing CSS.
- Shared utility classes (name = what it sets, file): (not inventoried yet)
- Components with their custom properties (e.g. `Card`: `--card-header-bg` ...) and slots/inputs: (not inventoried yet)
- Class naming scheme (BEM `block__element--modifier` or other; scoping): (not inventoried yet)
- Where new CSS goes (component's own file; never global base files): (not inventoried yet)
- Token naming and how components read tokens (short component-level custom properties): (not inventoried yet)

## Deviations
Features of the preferred style the installed version does not support, with the fallback used and the doc page checked.
