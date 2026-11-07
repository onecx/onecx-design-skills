---
name: run-test-instance
description: Runs this OneCX app (Angular or React microfrontend) in a browser without the OneCX shell and without a backend, using mock BFF data, and takes screenshots. Use when a change to the app has to be seen or checked in the browser.
---

# run-test-instance

`onecx-test.mjs` puts the built app on a test page. The test page plays the OneCX shell (topics, user, permissions, theme, auth)
and answers the BFF calls with mock data you write. The test page, mocks and screenshots live in a work folder outside the repo,
so the app repo stays unchanged: change app code only for the feature you work on, never to make the test page work.

`T` below means `node .claude/skills/run-test-instance/onecx-test.mjs`. Run every command in the root folder of the app repo.

## Steps (do them in order, tick them off in your reply)

1. **Build.** `npm install` (only if `node_modules` is missing), then `npx nx build --configuration=development`.
   Done when the build ends without errors. A build error is an error in the app code: fix it and build again.
2. **Init.** `T init`.
   Done when it prints `Test page: <file>` and the list `BFF operations`. If it prints `ERROR`, do what the error text says.
3. **Mock data.** Open the test page file printed by `init`. Edit only the part between `EDIT HERE` and `END EDIT HERE`.
   `init` wrote one `MOCKS` entry per BFF operation; its comment names the response schema (`// searchBooks -> SearchBookResponse`).
   For every entry with `body: {}` or `body: []`: look up that schema under `components:` → `schemas:` in the openapi file
   printed by `init` and replace the body with data of exactly that shape (rules below).
   Done when no `body: {}` and no `body: []` is left.
4. **Serve.** Start `T serve` as a background process; it keeps running.
   Done when it prints `Test page: http://localhost:<port>/test` (also when it says the server is already running).
5. **Check.** `T check /test/<route>`, with a route from the line `Other pages` of `init` (only `T check` if there is none).
   Done when it prints `App loaded: yes` and `OK: no problems found`.
   Otherwise fix the first entry under `PROBLEMS` (table below) and run the same check again.
6. **See the change.** Open the screenshot printed by `check` and find the part of the app you changed.
   - To click something first: `T check /test/<route> --click "<visible text of a button or link>"`.
   - After every code change: `npx nx build --configuration=development`, then check again. Server and mocks stay.
   Done when a screenshot shows your change working.
7. **Report and stop.** Tell the user the screenshot path and what it shows. Stop the server with `T stop`.
   Run `git status`: it lists only your own code changes.

## Rules for mock data
- Use the schema exactly: same field names, same nesting, the types the schema says. Fill every `required` field.
- Lists: 3 to 5 items with different, realistic values. Page results: `totalElements` equals the number of items.
- An id that a list returns also works for the detail url of that item (`/bff/books/*` matches `/bff/books/b1`).
- Dates as ISO strings (`2026-01-31T10:00:00Z`). Enum fields only with values listed in the schema.
- Entries with `body: null` stay `null` (no body, or an image: the app shows its default image).
- Error case: set `status` of that entry to `400` or `500`.
- Missing permission: remove it from `PERMISSIONS`. German texts: `LOCALE = 'de'`.
- Look: `init` sets `THEME = 'onecx'` (OneCX default theme) for repos of the onecx GitHub organisation, otherwise
  `THEME = 'none'` (the app's own styles only). Change it only when the user asks for the other look.
- Run `T init` again after a build whenever you like: it keeps your `PERMISSIONS`, `LOCALE` and `MOCKS`.

## Problems and fixes

| `check` prints | Fix |
|---|---|
| `NO MOCK for POST /bff/books/search` | Add a `MOCKS` entry with exactly this method and url. |
| `TypeError: Cannot read properties of undefined (reading 'x')` | A mock body misses a field the app reads. Compare that body with its schema; add the missing field. |
| `app message: error ...` | The app shows an error toast, usually because a mock is missing or has the wrong shape. Fix that mock. |
| `App loaded: NO`, `LOAD FAILED` or `HTTP 404 /<file>.js` | Build again (step 1), then `T init`, then check again. |
| `Cannot open http://localhost:<port>/test` | The server is not running: step 4. |
| `Playwright is not installed` | Run the two install commands it prints. They install into the work folder, not into the app. |
| `the app shows no text on this page` | Check a route from the line `Other pages` of `init`. |
| `the app did not start within ...` | Check again with `--wait 15000`. If it stays, read `reference.md`. |
| `info: topic without value: <name>` | Only a hint; act on it only when the app shows nothing. |

Any other problem, or a change to the test page itself: read `reference.md` (how the test page replaces the shell).
