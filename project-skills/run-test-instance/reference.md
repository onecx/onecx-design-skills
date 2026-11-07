# How the test page replaces the OneCX shell

Read this only when `check` shows a problem the table in `SKILL.md` does not cover, or when you change `test.html` / `onecx-test.mjs`.
Verified with onecx-tenant-ui (Angular 19, libs 6), a generated Angular 21 app (libs 8) and a generated React 19 app (libs 8).

## Loading the app
- The app is a module federation remote. `remoteEntry.js` is an ES module with `init` and `get`; the page calls
  `init({})` with an empty share scope, so the app uses its own bundled Angular/React (no shell preloader needed).
- `get('<exposed module>')()` runs the app's bootstrap, which defines the web component (`customElements.define`). The page
  then creates the element with the attributes the shell sets: `data-style-id="<productName>|<appId>"`, `data-style-isolation`,
  `data-mfe-element` (without them the scoped PrimeNG styles do not apply).
- Angular: `polyfills.js` (zone.js) is loaded by the page, the shell normally provides it. `styles.css` of the app is linked.
- The page lives at `/test`; the app's `baseHref` is `/test/`. No trailing slash on the page url: the Angular router does not
  match `test/`. App routes are below it: `/test/book`.
- Vite production builds use base `/mfe/<name>/`; `init` reads the base from `dist/index.html`, `serve` mounts dist there.

## Topics
Topics (`@onecx/integration-interface`) are messages `{ type: 'TopicNext', name, version, data, timestamp, id }`.
The page sets `globalThis['@onecx/accelerator'].topic.useBroadcastChannel = false` before anything loads, so all topics use
`window.postMessage`. A topic created later asks with `TopicGet`; the page answers with the last value (the shell does the same).

| Topic (name) | Value on the test page | Why it is needed |
|---|---|---|
| `currentMfe` | appId, productName, `remoteBaseUrl` (server + base), `baseHref: '/test/'`, elementName | Angular router init waits for it; BFF base path = remoteBaseUrl + `bff`; React routes use baseHref |
| `userProfile` | test user, `settings.locales` and `accountSettings.localeAndTimeSettings.locale` = `LOCALE` | Angular apps do not start without it (language); date formats |
| `permissions` | `PERMISSIONS` (from `helm/values.yaml`) | `hasPermission`, `ocx-portal-page permission=...` |
| `permissionsRpc` | answered with `PERMISSIONS` | permission requests of slot components |
| `isAuthenticated` | (no data) | libs 8+: every HTTP call waits for it |
| `currentTheme` | `THEME = 'onecx'`: theme `default` of onecx-local-env (`onecx-data/theme/default_OneCX.json`); `'none'`: only `general.primary-color`/`secondary-color` | PrimeNG theme preset; crashes without `general.primary-color` |
| `currentPortal` (= current workspace) | test workspace, `baseUrl: '/'` | page header, React href |
| `configuration` | `{}` | search header and config service wait for it |
| `currentLocation` | `{ url, isFirst }`, again after every `history.pushState/replaceState` | router sync |
| `remoteComponentsInfo` | no slots | slots wait for it |
| `parameters`, `imageRepository`, `globalLoading` | empty / false | optional, avoids waiting |

Published by the app and shown by the page: `message` (toasts, logged as `app message:`), `globalError`, `currentPage`,
`manualBreadcrumbs`, `translationCache`.

## Theme
`THEME = 'onecx'` (default for repos with a `github.com/onecx/...` remote) gives the look of the app inside OneCX:
the properties of the OneCX default theme are published in `currentTheme` and set as CSS variables (`--primary-color`, ...),
and the page gets the global styles of the shell (`@onecx/portal-layout-styles` `theme_defaults.scss` and the shell's
`global-styles.scss`): Ubuntu font (bundled in `fonts/`, served at `/__onecx-test/fonts/`), 14px, body background
`#f7f7f7`, text colour. `THEME = 'none'` is for business apps with a hardcoded theme: only the values the libs need to start.

## Other things the shell provides
- `window.onecxAuth` and `window.onecxAngularAuth` with `authServiceProxy.v1 = { getHeaderValues, updateTokenIfNeeded }`:
  without it every BFF call fails before it is sent. Set **after** zone.js has loaded: zone.js clears every `window.on*` property.
- `document.createElementFromPrimeNg`, `createElementFromMaterial`, `createOnecxElement`, `createElementFromSharedStylesHost`,
  `createOnecxDynamicContainer`: the app build rewrites PrimeNG/Material code to call them (dialogs, overlays).
- `window['onecx-shell-capabilities']` and `globalThis.APP_CONFIG = { APP_BASE_HREF: '/' }` (React reads it instead of
  `assets/env.json`, which still holds `${...}` placeholders after a build).

## BFF mocks
The page patches `XMLHttpRequest` (Angular HttpClient) and `fetch` (generated React client). A request whose path matches a
`MOCKS` entry (method + url pattern, host ignored) gets the mock answer. Angular calls `<server>/bff/<path>`; the generated React
client calls the first `servers` url of the openapi file (`http://onecx-<name>-bff:8080/<path>`), so its mocks have no `/bff`.
`*` in a mock url matches one path part. Unmatched calls are logged as `NO MOCK` and answered with 501 (calls to another
server by the page, calls to `/bff/` by the server, which also logs them).
