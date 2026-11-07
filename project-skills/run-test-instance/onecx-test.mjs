#!/usr/bin/env node
// Runs one OneCX microfrontend in the browser without the shell.
// Commands (run them in the root folder of the app repo):
//   node onecx-test.mjs init               detect the app, write the test page and print the BFF operations
//   node onecx-test.mjs serve              serve the built app and the test page (keeps running)
//   node onecx-test.mjs stop               stop the server of this app
//   node onecx-test.mjs check [path]       open the test page in Chromium, print problems, write a screenshot
// Nothing is written into the app repo. All files go to the work folder printed by `init`.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO = process.cwd()
const WORK_ROOT = path.join(os.tmpdir(), 'onecx-test')
const MOUNT = '/test' // no trailing slash: the Angular router does not match 'test/'
// Every app gets its own port (4300-4499) so several apps can be tested at the same time.
const portFor = (appId) => 4300 + [...appId].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 200, 7)

const args = process.argv.slice(2)
const cmd = args[0]
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const fail = (msg) => {
  console.error('ERROR: ' + msg)
  process.exit(1)
}

function pkg() {
  const p = path.join(REPO, 'package.json')
  if (!fs.existsSync(p)) fail('No package.json here. Run this command in the root folder of the app repo.')
  return JSON.parse(read(p))
}
const workDir = (appId) => path.join(WORK_ROOT, appId)
const configFile = (appId) => path.join(workDir(appId), 'onecx-test.json')

function loadConfig() {
  const appId = pkg().name
  const f = configFile(appId)
  if (!fs.existsSync(f)) fail(`No test page for "${appId}" yet. Run: node ${path.join(SKILL_DIR, 'onecx-test.mjs')} init`)
  return JSON.parse(read(f))
}

// ---------- init ----------

function findFiles(dir, test, depth = 4, out = []) {
  if (depth < 0 || !fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.nx', '.angular'].includes(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findFiles(p, test, depth - 1, out)
    else if (test(e.name, p)) out.push(p)
  }
  return out
}

function detectFederation() {
  const files = ['module-federation.config.js', 'module-federation.config.ts', 'webpack.config.js', 'webpack.config.ts', 'vite.config.ts', 'vite.config.js', 'vite.config.mts']
  for (const f of files) {
    const src = read(path.join(REPO, f))
    const exposed = src.match(/exposes\s*:\s*\{\s*['"]([^'"]+)['"]/)
    if (exposed) {
      return {
        file: f,
        exposedModule: exposed[1],
        remoteFile: src.match(/filename\s*:\s*['"]([^'"]+)['"]/)?.[1] ?? 'remoteEntry.js'
      }
    }
  }
  fail('No module federation config with "exposes" found (looked at ' + files.join(', ') + ').')
}

function detectTagName() {
  const src = findFiles(path.join(REPO, 'src'), (n) => /\.(ts|tsx|js|jsx)$/.test(n) && !/\.(spec|test)\./.test(n))
  for (const f of src) {
    const m = read(f).match(/(?:createAppEntrypoint|createViteAppWebComponent|createWebComponent|bootstrapRemoteComponent)\s*\([^'"]*['"]([a-z][a-z0-9]*-[a-z0-9-]+)['"]/)
    if (m) return m[1]
  }
  const helm = read(path.join(REPO, 'helm', 'values.yaml')).match(/tagName:\s*['"]?([a-z0-9-]+)/)
  if (helm) return helm[1]
  fail('Tag name of the web component not found. Search src for customElements.define or createAppEntrypoint.')
}

function detectProductName(appId) {
  const helm = read(path.join(REPO, 'helm', 'values.yaml'))
  const m = helm.match(/productName:\s*(?:&\S+\s+)?['"]?([a-z0-9-]+)/)
  if (m) return m[1]
  const app = findFiles(path.join(REPO, 'src'), (n) => /^App\.(tsx|jsx|ts)$/.test(n))[0]
  const p = app && read(app).match(/PRODUCT_NAME\s*:\s*['"]([^'"]+)['"]/)
  if (p) return p[1]
  return appId.replace(/-ui$/, '')
}

// Reads "permissions:" from helm/values.yaml: RESOURCE: { ACTION: 'text' } -> RESOURCE#ACTION
function detectPermissions() {
  const lines = read(path.join(REPO, 'helm', 'values.yaml')).split('\n')
  const start = lines.findIndex((l) => /^\s*permissions:\s*$/.test(l))
  if (start < 0) return []
  const base = lines[start].search(/\S/)
  const result = []
  let resource = null
  let resourceIndent = -1
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.search(/\S/)
    if (indent <= base) break
    const key = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!key) continue
    if (resource === null || indent <= resourceIndent) {
      resource = key[1]
      resourceIndent = indent
    } else if (key[2] !== '') result.push(`${resource}#${key[1]}`)
  }
  return result
}

// Route paths of the app, so the user knows which /test/<route> pages exist.
function detectRoutes() {
  const routes = new Set()
  for (const f of findFiles(path.join(REPO, 'src'), (n, p) => /\.(ts|tsx)$/.test(n) && !/\.(spec|test)\./.test(n) && !/[\\/](generated|api)[\\/]/.test(p))) {
    const src = read(f)
    for (const m of src.matchAll(/matcher:\s*startsWith\(\s*['"]([^'"]+)['"]\s*\)/g)) routes.add(m[1])
    for (const m of src.matchAll(/path:\s*`\$\{href\}\/([^`*]*)/g)) routes.add(m[1].replace(/\/$/, ''))
    if (/Routes\b|routes\b/.test(src)) for (const m of src.matchAll(/\bpath:\s*['"]([^'"]+)['"]/g)) routes.add(m[1])
  }
  // routes with parameters (':id') are left out: they need a real id from the mocks
  return [...routes].filter((r) => r && r !== '**' && !r.includes(':'))
}

// Apps of the onecx GitHub organisation get the OneCX default theme, all others a neutral one.
// Asks git (works in worktrees and submodules, where .git is a file); any remote counts, e.g. upstream of a fork.
function detectTheme() {
  let remotes = ''
  try {
    remotes = execSync('git config --get-regexp "^remote\\..*\\.url$"', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch { /* no git or no remote */ }
  return /github\.com[:/]onecx\//i.test(remotes) ? 'onecx' : 'none'
}

function findOpenApi() {
  const files = findFiles(path.join(REPO, 'src'), (n) => /openapi.*\.ya?ml$|swagger.*\.ya?ml$/i.test(n))
  return files.find((f) => /bff/i.test(f)) ?? files[0]
}

// Lists the operations of an OpenAPI yaml file without a YAML library.
function listOperations(file) {
  const lines = read(file).split('\n')
  const ops = []
  let inPaths = false
  let current = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue }
    if (inPaths && /^\S/.test(line)) inPaths = false
    if (!inPaths) continue
    const p = line.match(/^ {2}(\/\S*):\s*$/)
    if (p) { current = p[1]; continue }
    const m = line.match(/^ {4}(get|post|put|patch|delete):\s*$/)
    if (m && current) {
      const op = { method: m[1].toUpperCase(), path: current, operationId: '', status: '', schema: '', file: false }
      let inSuccess = false
      for (let j = i + 1; j < lines.length && !/^ {0,4}\S/.test(lines[j]); j++) {
        const l = lines[j]
        op.operationId ||= l.match(/^ {6}operationId:\s*(\S+)/)?.[1] ?? ''
        const s = l.match(/^ {8}['"]?(\d\d\d|default)['"]?:\s*$/)
        if (s) {
          if (inSuccess) break
          inSuccess = s[1].startsWith('2')
          if (inSuccess) op.status = s[1]
          continue
        }
        if (!inSuccess) continue
        if (/format:\s*binary/.test(l) || /^\s*['"]?(image\/|application\/octet-stream|application\/pdf|\*\/\*)/.test(l)) op.file = true
        if (!op.schema) op.schema = l.match(/\$ref:\s*['"]?#\/components\/(?:schemas|responses)\/([A-Za-z0-9_]+)/)?.[1] ?? (/type:\s*array/.test(l) ? 'array' : /type:\s*(object|string|integer|number|boolean)/.test(l) ? 'inline' : '')
      }
      ops.push(op)
    }
  }
  return ops
}

function detectApiPrefix(framework, openapi) {
  if (framework === 'angular') {
    const env = read(path.join(REPO, 'src', 'environments', 'environment.ts'))
    const prefix = env.match(/apiPrefix\s*:\s*['"]([^'"]*)['"]/)?.[1] ?? 'bff'
    return '/' + prefix.replace(/^\/|\/$/g, '')
  }
  // React: the generated client calls the first "servers" url of the openapi file.
  const server = openapi ? read(openapi).match(/servers:\s*\n\s*-\s*url:\s*['"]?(\S+?)['"]?\s*$/m)?.[1] : undefined
  if (!server) return ''
  try { return new URL(server, 'http://x').pathname.replace(/\/$/, '') } catch { return '' }
}

function init() {
  const p = pkg()
  const deps = { ...p.dependencies, ...p.devDependencies }
  const framework = deps['@angular/core'] ? 'angular' : deps.react ? 'react' : fail('Neither @angular/core nor react in package.json.')
  const appId = p.name
  const fed = detectFederation()
  const remotes = findFiles(path.join(REPO, 'dist'), (n) => n === fed.remoteFile, 3)
  if (!remotes.length) fail(`No dist/**/${fed.remoteFile} found. Build the app first (npx nx build --configuration=development), then run init again.`)
  const distDir = path.dirname(remotes.sort((a, b) => a.length - b.length)[0])
  // Base path the build was made for: absolute script urls in dist/index.html show it (Vite production: /mfe/<name>/).
  const indexSrc = read(path.join(distDir, 'index.html')).match(/<script[^>]+src="(\/(?:[^"]*\/)?)[^"/]+\.m?js"/)?.[1]
  const base = indexSrc ?? '/'
  let styles = fs.existsSync(path.join(distDir, 'styles.css')) ? 'styles.css'
    : (fs.readdirSync(distDir).find((f) => /^styles.*\.css$/.test(f)) ?? '')
  // A styles.css that still has @import 'package/...' is an unbuilt copy (React/Vite bundles the real CSS into the JS).
  if (styles && /@import\s+(url\()?['"]?(?![./]|https?:)[^'"\s)]+/.test(read(path.join(distDir, styles)))) styles = ''
  const polyfills = fs.readdirSync(distDir).find((f) => /^polyfills.*\.js$/.test(f))
  const tagName = detectTagName()
  const productName = detectProductName(appId)
  const permissions = detectPermissions()
  const openapi = findOpenApi()
  const ops = openapi ? listOperations(openapi) : []
  const apiPrefix = detectApiPrefix(framework, openapi)
  const theme = detectTheme()

  const mocks = ops.map((o) => {
    const url = apiPrefix + o.path.replace(/\{[^}]+\}/g, '*')
    const file = o.method === 'GET' && o.file // binary download such as an image: 404 makes the app show its default
    const status = file ? 404 : Number(o.status || 200)
    const body = file || !o.schema ? 'null' : o.schema === 'array' ? '[]' : '{}'
    const note = file ? 'file/image: 404 shows the default' : o.schema === 'inline' ? '-> schema written inline in the openapi path'
      : o.schema ? '-> ' + o.schema : '-> no body'
    return `  { method: '${o.method}', url: '${url}', status: ${status}, body: ${body} }, // ${o.operationId} ${note}`
  })
  const html = read(path.join(SKILL_DIR, 'test.html'))
    .replaceAll('{{APP_ID}}', appId)
    .replaceAll('{{PRODUCT_NAME}}', productName)
    .replaceAll('{{TAG_NAME}}', tagName)
    .replaceAll('{{REMOTE_ENTRY}}', base.slice(1) + fed.remoteFile)
    .replaceAll('{{EXPOSED_MODULE}}', fed.exposedModule)
    .replaceAll('{{BASE}}', base)
    .replaceAll('{{THEME}}', theme)
    .replaceAll('{{STYLES_LINK}}', styles ? `<link rel="stylesheet" href="${base}${styles}" />` : '')
    .replaceAll('{{PERMISSIONS}}', JSON.stringify(permissions))
    .replaceAll('{{MOCKS}}', mocks.join('\n'))
    .replaceAll('{{POLYFILLS}}', polyfills ? `<script src="${base}${polyfills}" type="module"></script>` : '')

  const dir = workDir(appId)
  fs.mkdirSync(dir, { recursive: true })
  const testHtml = path.join(dir, 'test.html')
  const block = /\/\* =+ EDIT HERE =+ \*\/[\s\S]*?\/\* =+ END EDIT HERE =+ \*\//
  let previous = read(testHtml).match(block)?.[0]
  // a test page from an older skill version has no THEME setting yet: take it over from the new page
  if (previous && !/const THEME\b/.test(previous)) {
    const themeLines = html.match(/\n\/\/ Look of the page[\s\S]*?const THEME = '[a-z]+';\n/)?.[0] ?? ''
    previous = previous.replace(/\/\* =+ END EDIT HERE/, (end) => themeLines + '\n' + end)
  }
  if (previous && !args.includes('--reset')) {
    fs.writeFileSync(testHtml, html.replace(block, () => previous))
    console.log('Kept your PERMISSIONS, LOCALE, THEME and MOCKS from the existing test page ("init --reset" starts from scratch).')
  } else {
    fs.writeFileSync(testHtml, html)
  }
  const oldConfig = fs.existsSync(configFile(appId)) ? JSON.parse(read(configFile(appId))) : {}
  const port = Number(opt('port', oldConfig.port ?? portFor(appId)))
  const config = { appId, framework, productName, tagName, exposedModule: fed.exposedModule, distDir, base, testHtml, openapi, apiPrefix, port }
  fs.writeFileSync(configFile(appId), JSON.stringify(config, null, 2))

  console.log(`Detected (${framework}):`)
  for (const [k, v] of Object.entries(config)) console.log(`  ${k}: ${v}`)
  const usedTheme = read(testHtml).match(/const THEME = '([^']*)'/)?.[1] ?? theme
  console.log(`  theme: ${usedTheme} (${usedTheme === 'onecx' ? 'OneCX default theme' : 'neutral: the app\'s own styles decide'}; ${usedTheme === theme ? `default for this repo` : `kept from the test page, default for this repo is ${theme}`}; change THEME in the test page)`)
  console.log(`  permissions: ${permissions.join(', ') || '(none found in helm/values.yaml: add them to PERMISSIONS in the test page)'}`)
  const routes = detectRoutes()
  console.log(`\nTest page: ${testHtml} (served at http://localhost:${port}${MOUNT})`)
  console.log(`Start page of the app: /test. Other pages (from the route config): ${routes.map((r) => '/test/' + r).join(', ') || '(none found)'}`)
  console.log(`\nBFF operations (${ops.length}) from ${openapi ?? '(no openapi file found)'}. Each one is a MOCKS entry in the test page:`)
  for (const o of ops) console.log(`  ${o.method.padEnd(6)} ${apiPrefix}${o.path}  ${o.operationId}  -> ${o.status || '?'} ${o.file ? '(file)' : o.schema}`)
  console.log(`\nNext: replace every body {} or [] in MOCKS with data that matches the schema named in its comment.`)
}

// ---------- serve ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject', '.map': 'application/json', '.wasm': 'application/wasm' }

function serve() {
  const first = loadConfig()
  const port = first.port
  const server = http.createServer((req, res) => {
    try {
      handle(req, res)
    } catch (e) {
      console.log(`ERROR for ${req.url}: ${e.message}`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(e.message))
    }
  })
  const handle = (req, res) => {
    // read on every request: a new `init` needs no restart
    const c = JSON.parse(fs.readFileSync(configFile(first.appId), 'utf8'))
    const url = new URL(req.url, 'http://localhost')
    let p = decodeURIComponent(url.pathname) // throws on bad % sequences: answered with 500 above
    if (p === '/__onecx-test') return res.end(c.appId)
    if (p === '/__onecx-test/stop') {
      res.end('stopped')
      console.log('Stopped by "stop".')
      return setTimeout(() => process.exit(0), 50)
    }
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
      res.end(body)
    }
    if (p.startsWith('/__onecx-test/fonts/')) {
      const name = path.basename(p)
      const font = path.join(SKILL_DIR, 'fonts', name)
      if (!/^ubuntu-\d{3}\.woff2$/.test(name) || !fs.existsSync(font)) {
        console.log(`Font ${name} missing: copy the fonts/ folder of the skill, or set THEME = 'none' in the test page.`)
        return send(404, 'text/plain', 'font missing: copy the fonts/ folder of the skill')
      }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400' })
      return res.end(fs.readFileSync(font))
    }
    if (p === '/' || p === MOUNT + '/') {
      res.writeHead(302, { location: MOUNT + url.search })
      return res.end()
    }
    if (p === MOUNT || p.startsWith(MOUNT + '/')) {
      // The test page answers /test and every path below it, like the shell does for the app's routes.
      return send(200, 'text/html', fs.readFileSync(c.testHtml))
    }
    if (p.startsWith(c.base)) p = '/' + p.slice(c.base.length)
    const file = path.join(c.distDir, path.normalize(p))
    if (file.startsWith(c.distDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file))
    }
    if (/\.[a-z0-9]+$/i.test(p) && !p.includes('/bff/')) return send(404, 'text/plain', 'not found: ' + p)
    console.log(`NO MOCK: ${req.method} ${url.pathname} (add it to MOCKS in the test page)`)
    return send(501, 'application/json', JSON.stringify({ error: 'NO MOCK', method: req.method, path: url.pathname }))
  }
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') fail(e.message)
    const owner = await fetch(`http://localhost:${port}/__onecx-test`).then((r) => r.text()).catch(() => '')
    if (owner === first.appId) {
      console.log(`The server for ${first.appId} is already running. Test page: http://localhost:${port}${MOUNT}`)
      process.exit(0)
    }
    fail(`Port ${port} is used by another program. Run "init --port <other port>", then serve again.`)
  })
  server.listen(port, () => {
    console.log(`Serving ${first.distDir} under ${first.base}`)
    console.log(`Test page: http://localhost:${port}${MOUNT}`)
    console.log('The test page is read on every request: after editing it, just reload. After a rebuild, just reload.')
  })
}

// ---------- check ----------

async function loadPlaywright() {
  const tries = [path.join(WORK_ROOT, 'tools'), REPO, SKILL_DIR]
  for (const dir of tries) {
    try {
      return createRequire(path.join(dir, 'noop.js'))('playwright')
    } catch { /* try next */ }
  }
  try { return await import('playwright') } catch { /* fall through */ }
  fail(PLAYWRIGHT_MISSING)
}
const PLAYWRIGHT_MISSING = `Playwright is not installed. Install it once into the work folder (this does not touch the app repo):
  npm install --no-save --prefix ${path.join(WORK_ROOT, 'tools')} playwright
  npx --prefix ${path.join(WORK_ROOT, 'tools')} playwright install chromium`

async function check() {
  const c = loadConfig()
  const port = c.port
  let pagePath = args[1] && !args[1].startsWith('--') ? args[1] : MOUNT
  if (pagePath !== MOUNT && !pagePath.startsWith(MOUNT + '/')) pagePath = MOUNT + '/' + pagePath.replace(/^\/+/, '') // '/book' -> '/test/book'
  const target = new URL(pagePath, `http://localhost:${port}`).href
  const slug = (x) => x.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  const clickText = opt('click')
  const name = ['screenshot', slug(new URL(target).pathname.slice(MOUNT.length)), clickText ? 'click-' + slug(clickText) : ''].filter(Boolean).join('-')
  const out = opt('out', path.join(workDir(c.appId), name + '.png'))
  const waitMs = Number(opt('wait', 6000))
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch().catch((e) => fail(PLAYWRIGHT_MISSING + '\n(' + e.message.split('\n')[0] + ')'))
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const problems = []
  const notes = []
  let ready = false
  page.on('console', (m) => {
    const t = m.text()
    if (t.startsWith('[onecx-test] READY')) ready = true
    if (t.startsWith('[onecx-test]')) {
      ;(/NO MOCK|LOAD FAILED|globalError|app message: error/.test(t) ? problems : notes).push(t)
    } else if (m.type() === 'error') problems.push('console error: ' + t.split('\n').slice(0, 3).join(' | '))
  })
  page.on('pageerror', (e) => problems.push('page error: ' + String(e.message).split('\n')[0]))
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/bff\//.test(r.url())) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`)
  })
  try {
    await page.goto(target)
  } catch (e) {
    await browser.close()
    fail(`Cannot open ${target}. Is "node ${path.join(SKILL_DIR, 'onecx-test.mjs')} serve" running? (${e.message.split('\n')[0]})`)
  }
  await page.waitForTimeout(waitMs)
  if (clickText) {
    try {
      await page.getByText(clickText, { exact: false }).first().click({ timeout: 5000 })
      await page.waitForTimeout(2000)
      notes.push(`clicked "${clickText}"`)
    } catch (e) {
      problems.push(`could not click "${clickText}": ${e.message.split('\n')[0]}`)
    }
  }
  await page.screenshot({ path: out, fullPage: true })
  const text = (await page.locator('#onecx-test-app').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  await browser.close()

  console.log(`Page: ${target}`)
  console.log(`App loaded: ${ready ? 'yes' : 'NO'}`)
  console.log(`Visible text (start): ${text.slice(0, 400) || '(empty: the app shows nothing)'}`)
  console.log(`Screenshot: ${out}`)
  for (const n of [...new Set(notes)]) console.log('  info: ' + n)
  if (problems.length) {
    const unique = [...new Set(problems)]
    console.log(`\nPROBLEMS (${unique.length}):`)
    for (const pr of unique) console.log('  - ' + pr)
    process.exitCode = 1
  } else if (!ready || !text) {
    console.log(`\nPROBLEMS (1):\n  - ${ready ? 'the app shows no text on this page: try a route from "Other pages" of init' : `the app did not start within ${waitMs} ms: wait longer with --wait 15000`}`)
    process.exitCode = 1
  } else {
    console.log('\nOK: no problems found. Look at the screenshot to judge the result.')
  }
}

// Stops only the server of this app (never kill node processes by name: that also hits other programs).
async function stop() {
  const c = loadConfig()
  const owner = await fetch(`http://localhost:${c.port}/__onecx-test`).then((r) => r.text()).catch(() => '')
  if (owner !== c.appId) return console.log(`No server for ${c.appId} is running.`)
  await fetch(`http://localhost:${c.port}/__onecx-test/stop`).catch(() => '')
  console.log(`Stopped the server for ${c.appId}.`)
}

if (cmd === 'init') init()
else if (cmd === 'stop') await stop()
else if (cmd === 'serve') serve()
else if (cmd === 'check') await check()
else {
  console.log(`Usage (run in the root folder of the app repo):
  node ${path.join(SKILL_DIR, 'onecx-test.mjs')} init [--reset] [--port N]
  node ${path.join(SKILL_DIR, 'onecx-test.mjs')} serve
  node ${path.join(SKILL_DIR, 'onecx-test.mjs')} stop
  node ${path.join(SKILL_DIR, 'onecx-test.mjs')} check [/test/sub/path] [--click "text"] [--wait ms] [--out file.png]`)
}
