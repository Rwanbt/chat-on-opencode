/**
 * REAL unmodified official Desktop 2.1.4 GUI reader acceptance.
 * CI-only; no personal files, app instances, processes, or browser windows.
 *
 * Both generations advertise the SAME model ID. A provider-import marker is
 * necessary but never sufficient: the unique generated text must actually
 * appear in the owned Desktop renderer. On CI, prove the restart-only A→B
 * pointer with real idle-process enforcement, hot reload and cold rollback.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createSseDataFieldCounter } from './helpers/sse-framing.mjs'
import { createOpenCodeConfig } from '../packages/opencode-provider/src/config.mjs'
import { candidateDigest } from '../packages/opencode-provider/src/official-upgrade.mjs'
import { inspectRestartOnlyPointer, publishRestartOnlyPointer } from '../packages/opencode-provider/src/official-versioned-pointer.mjs'

assert.equal(process.platform, 'win32', 'windows_only')
const ci = process.env.GITHUB_ACTIONS === 'true'
const isolatedLocal = process.env.COO_OFFICIAL_GUI_ISOLATED_LOCAL === '1'
assert.ok(ci || isolatedLocal, 'explicit_disposable_runner_only')
const base = process.env.RUNNER_TEMP
const desktop = process.env.CHAT_ON_OPENCODE_TEST_DESKTOP_EXE
assert.ok(base && path.isAbsolute(base), 'runner_temp_required')
assert.ok(desktop && path.isAbsolute(desktop) && existsSync(desktop), 'official_desktop_214_missing')
assert.ok(path.resolve(desktop).toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep),
  'no_personal_installed_desktop')
if (isolatedLocal && !ci) {
  // Local execution is deliberately opt-in, and may only reuse an explicitly
  // named disposable vendor extraction. Do not bake any contributor's Windows
  // account, checkout or absolute workspace path into the public CI fixture.
  assert.equal(path.basename(path.resolve(base)), '.scratch-official-214',
    'local_scratch_must_be_explicit_disposable_extraction')
}

const root = await mkdtemp(path.join(base, 'coo-desktop-reader-'))
const dirs = Object.fromEntries(['home','appdata','localappdata','config','data','state',
  'cache','workspace','provider','bundles','binaries','receipts','desktopRoot']
  .map(name => [name, path.join(root, name)]))
for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true })
// Desktop's initial renderer IPC queries the Windows Documents known folder.
// Missing profile shell directories previously coincided with an inert GUI
// error page. Only create throwaway dirs here: never rewrite HKCU shell
// registry settings or touch the actual user's Documents.
for (const folder of ['Documents','Desktop','Downloads','Pictures','Music','Videos']) {
  await mkdir(path.join(dirs.home, folder), { recursive: true })
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const mark = generation => 'GUI_GENERATOR_ACTUAL_' + generation + '_271828'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packageRoot = path.join(import.meta.dirname, '..', 'packages', 'opencode-provider')
const configFile = path.join(dirs.config, 'opencode.jsonc')
const windowProbe = path.join(import.meta.dirname, '..', 'scripts', 'probe-official-desktop-window.ps1')
await writeFile(path.join(dirs.provider, 'config.json'), JSON.stringify({
  ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
}))

async function port() {
  const socket = createServer()
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve))
  const found = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return found
}
const configs = new Map()
const generationDirs = new Map()
for (const generation of ['A', 'B']) {
  // Independent offline CoS runtimes return DIFFERENT generated strings from
  // the very same provider model ID. Never connect to a ChatGPT account.
  const original = await readFile(path.join(packageRoot, 'test', 'fixtures', 'mock-cos.ts'), 'utf8')
  assert.ok(original.includes("'OFFLINE_FORK_OK'"))
  const fixture = path.join(dirs.binaries, generation + '.ts')
  const binary = path.join(dirs.binaries, generation + '.exe')
  // Per-prompt correlation is mandatory. A delayed session hydration can
  // insert the previous generation's exact old answer AFTER our DOM baseline.
  // Echo only a synthetic nonce from this new message, never auth/user data.
  const syntheticText = JSON.stringify(mark(generation)) +
    ' + ":" + (input.text.match(/GUI_NONCE_[A-F0-9]{12}/)?.[0] ?? "MISSING_NONCE")'
  // Genuine CoS persists its outbox and event journal across restarts. The
  // stock offline mock kept sessions/events ONLY in process memory, which
  // turned B into a false "first" input while TurnCustody knew A already ran:
  // B was rejected as turn_first_message_pending before readiness. Persist
  // ONLY the test's own synthetic journal in its disposable runtime profile.
  assert.ok(original.includes('const sessions = new Set<string>()'))
  assert.ok(original.includes('const events = new Map<string, Array<Record<string, unknown>>>()'))
  assert.ok(original.includes('    events.set(id, list)'))
  assert.ok(original.includes("list.push({ seq: seq + 2, kind: 'assistant_message'"))
  assert.ok(original.includes("list.push({ seq: seq + 3, kind: 'turn_end'"))
  const durableMock = "import { readFileSync as readOfflineJournal } from 'node:fs'\n" +
    original
      .replace('const sessions = new Set<string>()',
        "const journalFile = path.join(folder, 'offline-synthetic-journal.json')\n" +
        "const journal = (() => { try { return JSON.parse(readOfflineJournal(journalFile, 'utf8')) } catch { return { sessions: [], events: [] } } })()\n" +
        'const sessions = new Set<string>(journal.sessions)')
      .replace('const events = new Map<string, Array<Record<string, unknown>>>()',
        'const events = new Map<string, Array<Record<string, unknown>>>(journal.events)')
      .replace('    events.set(id, list)',
        '    events.set(id, list)\n' +
        '    await writeFile(journalFile, JSON.stringify({ sessions: [...sessions], events: [...events] }))')
      // Only the disposable synthetic runtime emits two temporally separated
      // assistant revisions. Their final answer and nonce are unchanged.
      .replace("    list.push({ seq: seq + 2, kind: 'assistant_message', turnId, message: { text: assistantText, truncated: false } })",
        "    list.push({ seq: seq + 2, kind: 'assistant_message', turnId, message: { text: assistantText.slice(0, -5), truncated: false } })\n" +
        "    list.push({ seq: seq + 3, kind: 'assistant_message', turnId, message: { text: assistantText, truncated: false } })")
      .replace("    list.push({ seq: seq + 3, kind: 'turn_end'",
        "    list.push({ seq: seq + 4, kind: 'turn_end'")
      .replace("    for (const event of list) if ((event.seq as number) >= Number(stream[2])) {",
        "    for (const event of list) if ((event.seq as number) >= Number(stream[2])) {\n" +
        "      if (event.kind === 'assistant_message') await new Promise(resolve => setTimeout(resolve, 400))")
      .replace("'OFFLINE_FORK_OK'", syntheticText)
  await writeFile(fixture, durableMock)
  // The compiler must not inherit ChatGPT/browser/account tokens or unrelated
  // user environment variables even though this fixture is wholly offline.
  const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)))
  Object.assign(buildEnv, {
    HOME:dirs.home,USERPROFILE:dirs.home,APPDATA:dirs.appdata,LOCALAPPDATA:dirs.localappdata,
    TEMP:dirs.cache,TMP:dirs.cache,
    BUN_INSTALL_CACHE_DIR:dirs.cache,
  })
  const build = spawnSync('bun', ['build', fixture, '--compile', '--outfile', binary], {
    cwd: dirs.workspace, env:buildEnv,
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 45_000,
  })
  assert.equal(build.status, 0, 'mock_runtime_build_failed')
  const pluginDir = path.join(dirs.bundles, generation)
  await mkdir(pluginDir)
  generationDirs.set(generation, pluginDir)
  for (const name of ['bin', 'plugin', 'src']) {
    await cp(path.join(packageRoot, name), path.join(pluginDir, name), { recursive: true })
  }
  const entry = path.join(pluginDir, 'plugin', 'index.ts')
  const source = await readFile(entry, 'utf8')
  // The test-only copy records sanitized gateway failure codes; this exposes
  // the exact early 409/503 reason when a GUI request never yields a reply.
  const gatewayFile = path.join(pluginDir, 'src', 'gateway.mjs')
  const gatewaySource = await readFile(gatewayFile, 'utf8')
  assert.ok(gatewaySource.includes('diagnostics.lastFailure = code'),
    'gateway_error_contract_changed')
  await writeFile(gatewayFile, gatewaySource.replace('diagnostics.lastFailure = code',
    'diagnostics.lastFailure = code\n      traceStage(code)'))
  // A live Desktop may add native text-only bookkeeping around the prior answer.
  // Instrument only synthetic request role/length structure, never content.
  const transcriptFile = path.join(pluginDir, 'src', 'transcript-handoff.mjs')
  const transcriptSource = await readFile(transcriptFile, 'utf8')
  const gapSource = 'const gap = dialogue.slice(matching[0] + 1, -1)'
  assert.ok(transcriptSource.includes(gapSource), 'transcript_handoff_contract_changed')
  const shapeReceipt = path.join(dirs.receipts, generation + '.transcript-shape.jsonl')
  const syntheticTrace = 'try { logSyntheticShape(' + JSON.stringify(shapeReceipt) +
    ', JSON.stringify({ roles:dialogue.map(item=>item.role),' +
    ' gap:gap.map(item=>({role:item.role,chars:item.content.length})), matches:matching.length })' +
    ' + "\\n") } catch {}'
  await writeFile(transcriptFile,
    "import { appendFileSync as logSyntheticShape } from 'node:fs'\n" +
    transcriptSource.replace(gapSource, gapSource + '\n' + syntheticTrace))
  const importReceipt = path.join(dirs.receipts, generation + '.import')
  const providerPort = await port()
  // A pointer changes only plugins[0].package. The unchanged JSONC retains
  // generation A's options/baseURL. Synthetic immutable A and B plugin source
  // therefore pins its OWN offline CoS process and port, making a real GUI
  // response identify the imported version (not merely the old config).
  const originalPort = "const port = Number(option('port') ?? '45861')"
  const originalRuntime = "runtimeExecutable: option('runtimeExecutable'),"
  assert.ok(source.includes(originalPort) && source.includes(originalRuntime),
    'plugin_lifecycle_contract_changed')
  const pinnedSource = source
    .replace(originalPort, 'const port = ' + providerPort)
    .replace(originalRuntime, 'runtimeExecutable: ' + JSON.stringify(binary) + ',')
  await writeFile(entry, "import { writeFileSync as guiImportReceipt } from 'node:fs'\n" +
    'guiImportReceipt(' + JSON.stringify(importReceipt) + ', ' + JSON.stringify(generation) + ')\n' + pinnedSource)
  const config = createOpenCodeConfig({
    runtimeExecutable: binary, runtimeData: dirs.provider,
    nodeExecutable: process.execPath, pluginDir, port: providerPort,
  })
  config.model = 'chat-on-opencode/chatgpt-default'
  configs.set(generation, config)
}
const configFor = generation => writeFile(configFile, JSON.stringify(configs.get(generation), null, 2))
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)))
Object.assign(env, {
  HOME: dirs.home, USERPROFILE: dirs.home,
  APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata,
  TEMP:dirs.cache,TMP:dirs.cache,
  XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data,
  XDG_CACHE_HOME: dirs.cache, XDG_STATE_HOME: dirs.state,
  OPENCODE_CONFIG_DIR: dirs.config, OPENCODE_DESKTOP_TEST_ROOT: dirs.desktopRoot,
  CHAT_ON_OPENCODE_STAGE_TRACE: path.join(dirs.receipts, 'stages.txt'),
  // Mock route tracing checks path.dirname(runtimeData); log only synthetic
  // request method/path into the disposable runtime, and redact session IDs
  // when reporting a failure.
  CHAT_ON_OPENCODE_TEST_TRACE_DIR: root,
  OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
})
// Desktop 2.1.4 defaults to the machine-wide managed-service port 28894.
// A *disposable* Desktop must never connect to, replace or fight an existing
// personal user's service on that port. Set an ephemeral isolated port BEFORE
// launching the first owned GUI, through the vendor's own bundled CLI.
const ownedServicePort = await port()
const allowedProviderPorts = [...configs.values()].map(config =>
  Number(config.plugins[0].options.port))
const allowedPorts = new Set([ownedServicePort, ...allowedProviderPorts])
let blockedExternal = 0
let forwardedLocal = 0
let transientProxyResets = 0
// Count bounded SSE framing and timings in the disposable strict localhost proxy.
// Never retain or log payloads, user prompts, provider tokens, or event contents.
const ownedSse = { responses:0, frames:0, firstAt:null, lastAt:null }
// Chromium's forced proxy previously swallowed every localhost fetch.
// Instead, the test owns a loopback-only proxy that forwards exclusively to
// explicitly generated disposable service/provider ports. HTTPS CONNECT,
// foreign hosts, and unrelated local ports are never forwarded.
const ownedProxy = http.createServer((request, response) => {
  let target
  try { target = new URL(request.url) } catch { response.writeHead(400).end(); return }
  const chosenPort = Number(target.port)
  if (target.protocol !== 'http:' ||
      !['127.0.0.1','localhost'].includes(target.hostname) ||
      !allowedPorts.has(chosenPort)) {
    blockedExternal++
    response.writeHead(403).end()
    return
  }
  forwardedLocal++
  const headers = { ...request.headers,
    host:'127.0.0.1:' + chosenPort }
  delete headers['proxy-authorization']
  delete headers['proxy-connection']
  const upstream = http.request({
    protocol:'http:', hostname:'127.0.0.1',port:chosenPort,
    path:target.pathname + target.search,
    method:request.method,headers,
    agent:false,
  }, reply => {
    if (/\btext\/event-stream\b/i.test(String(reply.headers['content-type'] ?? ''))) {
      ownedSse.responses++
      const counter = createSseDataFieldCounter()
      reply.on('data', chunk => {
        const before = counter.snapshot().fields
        counter.push(chunk)
        const added = counter.snapshot().fields - before
        if (added > 0) {
          const now = Date.now()
          if (ownedSse.firstAt === null) ownedSse.firstAt = now
          ownedSse.lastAt = now
          ownedSse.frames += added
        }
      })
    }
    response.writeHead(reply.statusCode, reply.headers)
    reply.pipe(response)
  })
  upstream.setTimeout(12_000, () => upstream.destroy(Error('owned_upstream_timeout')))
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  // Renderer reload or a cold GUI shutdown may interrupt an in-flight
  // proxy request. A client disconnect is not a test process crash.
  request.on('error', error => {
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE') transientProxyResets++
    else ownedNetwork.failures.push('proxy_request_' + String(error.code || 'unknown'))
    upstream.destroy()
  })
  response.on('error', error => {
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE') transientProxyResets++
    else ownedNetwork.failures.push('proxy_response_' + String(error.code || 'unknown'))
    upstream.destroy()
  })
  request.pipe(upstream)
})
ownedProxy.on('clientError', (error, socket) => {
  if (error.code === 'ECONNRESET' || error.code === 'EPIPE') transientProxyResets++
  else ownedNetwork.failures.push('proxy_client_' + String(error.code || 'unknown'))
  socket.destroy()
})
ownedProxy.on('connect', (_request, socket) => {
  blockedExternal++
  socket.on('error', error => {
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE') transientProxyResets++
    else ownedNetwork.failures.push('proxy_connect_' + String(error.code || 'unknown'))
  })
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
})
ownedProxy.on('upgrade', (_request, socket) => {
  blockedExternal++
  socket.on('error', error => {
    if (error.code === 'ECONNRESET' || error.code === 'EPIPE') transientProxyResets++
    else ownedNetwork.failures.push('proxy_upgrade_' + String(error.code || 'unknown'))
  })
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
})
await new Promise((resolve,reject) =>
  ownedProxy.once('error',reject).listen(0,'127.0.0.1',resolve))
const ownedProxyPort = ownedProxy.address().port
env.HTTP_PROXY = 'http://127.0.0.1:' + ownedProxyPort
env.HTTPS_PROXY = env.HTTP_PROXY
const officialCLI = path.join(path.dirname(desktop), 'resources', 'opencode-cli.exe')
assert.ok(existsSync(officialCLI), 'vendor_bundled_cli_missing')
const isolatedServicePort = spawnSync(officialCLI, ['service', 'set', 'port', String(ownedServicePort)], {
  cwd: dirs.workspace, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000,
})
assert.equal(isolatedServicePort.status, 0, 'cannot_isolate_official_desktop_managed_service_port')

class CDP {
  constructor(socket) {
    this.socket = socket
    this.next = 0
    this.pending = new Map()
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data)
      if (!this.pending.has(data.id)) return
      const promise = this.pending.get(data.id)
      this.pending.delete(data.id)
      data.error ? promise.reject(Error('devtools_rejected')) : promise.resolve(data.result)
    })
  }
  async call(method, params = {}) {
    const id = ++this.next
    const value = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.socket.send(JSON.stringify({ id, method, params }))
    return Promise.race([value, sleep(8000).then(() => { throw Error('devtools_timeout_' + method) })])
  }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.equal(Boolean(result.exceptionDetails), false, 'renderer_expression_failed')
    return result.result?.value
  }
  close() { this.socket.close() }
}
let owned = null
let cdp = null
const ownedNetwork = {requests:0,responses:[],failures:[],unknownFailures:0}
function windowState(close = false) {
  assert.ok(owned?.pid && owned.exitCode === null)
  const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',windowProbe,
    '-OwnerProcessId',String(owned.pid)]
  if (close) args.push('-CloseOwnedWindow')
  const result = spawnSync('powershell.exe', args, {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 12_000,
  })
  assert.equal(result.status, 0, 'only_owned_open_code_window_allowed')
  return result.stdout.trim()
}
async function connectRenderer(portNumber) {
  let page
  const until = Date.now() + 26_000
  while (Date.now() < until) {
    try {
      const response = await fetch('http://127.0.0.1:' + portNumber + '/json/list',
        { signal: AbortSignal.timeout(900) })
      const list = (await response.json()).filter(item => item.type === 'page' &&
        item.webSocketDebuggerUrl)
      if (list.length === 1) { page = list[0]; break }
    } catch { /* test-owned debug listener is not ready */ }
    await sleep(300)
  }
  assert.ok(page, 'official_desktop_owned_renderer_unavailable')
  const websocket = new WebSocket(page.webSocketDebuggerUrl)
  await Promise.race([
    new Promise((resolve, reject) => {
      websocket.addEventListener('open', resolve, { once: true })
      websocket.addEventListener('error', reject, { once: true })
    }),
    sleep(8000).then(() => { throw Error('owned_renderer_websocket_timeout') }),
  ])
  cdp = new CDP(websocket)
  await cdp.call('Runtime.enable')
  await cdp.call('Page.enable')
  const localRequests = new Set()
  websocket.addEventListener('message', event => {
    const payload = JSON.parse(event.data)
    const data = payload.params
    if (payload.method === 'Network.requestWillBeSent') {
      try {
        const address = new URL(data.request.url)
        if (['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) {
          localRequests.add(data.requestId)
          ownedNetwork.requests++
        }
      } catch {}
    }
    if (payload.method === 'Network.loadingFailed') {
      if (localRequests.has(data.requestId)) {
        ownedNetwork.failures.push(String(data.errorText).slice(0, 72))
      } else { ownedNetwork.unknownFailures++ }
    }
    if (payload.method === 'Network.responseReceived' && localRequests.has(data.requestId)) {
      ownedNetwork.responses.push(data.response.status)
    }
  })
  await cdp.call('Network.enable')
  // Capture the official GUI's own SDK reconnect in an attached renderer.
  await cdp.call('Page.reload', { ignoreCache:true })
}
async function startDesktop() {
  const debuggingPort = await port()
  owned = spawn(desktop, ['--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + debuggingPort, '--disable-background-networking',
    // Restrict external traffic, but NEVER route the official Desktop's own
    // 127.0.0.1 managed-service event stream to the dead proxy. Chromium's
    // special <-loopback> rule removes its default localhost exemption.
    '--proxy-server=127.0.0.1:' + ownedProxyPort,
    '--proxy-bypass-list=<-loopback>'], {
    cwd: dirs.workspace, env, shell: false, windowsHide: false, stdio: 'ignore',
  })
  assert.ok(owned.pid, 'official_gui_child_not_started')
  const until = Date.now() + 45_000
  let visible = false
  while (Date.now() < until) {
    assert.equal(owned.exitCode, null, 'official_gui_child_died')
    const result = windowState()
    if (result === 'OWNED_OPEN_CODE_WINDOW_VISIBLE') { visible = true; break }
    assert.equal(result, 'NO_WINDOW')
    await sleep(350)
  }
  assert.equal(visible, true, 'official_gui_window_not_visible')
  await connectRenderer(debuggingPort)
}
async function stopDesktop() {
  cdp?.close()
  cdp = null
  if (!owned || owned.exitCode !== null) return
  try {
    if (windowState() === 'OWNED_OPEN_CODE_WINDOW_VISIBLE') {
      assert.equal(windowState(true), 'OWNED_WM_CLOSE_SENT')
    }
  } catch { /* only this runner's direct child may be signalled below */ }
  const exited = await Promise.race([
    new Promise(resolve => owned.once('exit', () => resolve(true))),
    sleep(5500).then(() => false),
  ])
  if (!exited && owned.exitCode === null) {
    owned.kill('SIGTERM')
    const terminated = await Promise.race([
      new Promise(resolve => owned.once('exit', () => resolve(true))),
      sleep(4000).then(() => false),
    ])
    assert.equal(terminated, true, 'official_gui_owned_process_refused_shutdown')
  }
  owned = null
}
async function reloadOwnedRenderer() {
  // Register BEFORE navigation so a fast local renderer cannot beat the
  // observer. A fixed delay would be a race on slower/faster CI hosts.
  const client = cdp
  const loaded = new Promise((resolve, reject) => {
    const complete = event => {
      let payload
      try { payload = JSON.parse(event.data) } catch { return }
      if (payload.method !== 'Page.loadEventFired') return
      clearTimeout(timer)
      client.socket.removeEventListener('message', complete)
      resolve()
    }
    const timer = setTimeout(() => {
      client.socket.removeEventListener('message', complete)
      reject(Error('owned_renderer_reload_timeout'))
    }, 15_000)
    client.socket.addEventListener('message', complete)
  })
  await Promise.all([client.call('Page.reload', { ignoreCache:true }), loaded])
}
function stopOwnedManagedCli() {
  // Desktop may leave its child service alive after the owned HWND exits.
  // Resolve ONLY the disposable port that this runner chose and verify the
  // executable is staged inside this exact test root before sending any stop.
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$port = ' + ownedServicePort,
    '$root = ' + "'" + dirs.desktopRoot.replaceAll("'", "''") + "'",
    '$conn = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)',
    'if ($conn.Count -eq 0) { Write-Output "OWNED_SERVICE_ALREADY_ABSENT"; exit 0 }',
    'if ($conn.Count -ne 1) { throw "AMBIGUOUS_OWNED_SERVICE_PORT" }',
    '$id = [int]$conn[0].OwningProcess',
    '$proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id)',
    'if (-not $proc) { Write-Output "OWNED_SERVICE_EXITED"; exit 0 }',
    '$prefix = $root.TrimEnd([char]92) + [IO.Path]::DirectorySeparatorChar',
    'if ($proc.Name -ne "opencode-cli.exe" -or ' +
      '-not $proc.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { ' +
      'throw "OWNED_SERVICE_PATH_UNPROVEN_NO_SIGNAL" }',
    'Stop-Process -Id $id -Force -ErrorAction Stop',
    'Start-Sleep -Milliseconds 500',
    'if (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id)) { throw "OWNED_SERVICE_PID_NOT_GONE" }',
    'Write-Output "ONLY_TEST_OWNED_SERVICE_STOPPED"',
  ].join('; ')
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
    windowsHide:true, shell:false, encoding:'utf8', timeout:10_000,
  })
  assert.equal(result.status, 0, 'owned_service_cleanup_unproven:' +
    String(result.stderr).slice(0, 350).replaceAll(dirs.desktopRoot, '[owned-root]'))
  return result.stdout.trim()
}
const ownedEndpoint = path.join(dirs.provider, 'control-api', 'endpoint.json')
async function ownedRuntimePid() {
  if (!existsSync(ownedEndpoint)) return null
  const endpoint = JSON.parse(await readFile(ownedEndpoint, 'utf8'))
  assert.ok(Number.isSafeInteger(endpoint.pid) && endpoint.pid > 0,
    'test_owned_runtime_endpoint_invalid')
  return endpoint.pid
}
async function awaitRuntimeStopped(pid) {
  // Close may leave the compiled test-only CoS mock running with a stale
  // control endpoint even when the official managed CLI is already gone.
  // Allow a short natural exit first; on hosted CI, the exact binary path
  // AND service switch must prove it is our synthetic runtime before a kill.
  const isAlive = () => {
    if (pid === null) return false
    const script = '$p=Get-Process -Id ' + pid +
      ' -ErrorAction SilentlyContinue; if ($null -eq $p) { "ABSENT" } else { "ALIVE" }'
    const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
      windowsHide:true,shell:false,encoding:'utf8',timeout:7000,
    })
    assert.equal(result.status, 0, 'owned_runtime_exit_unverifiable')
    return /^ALIVE\s*$/.test(result.stdout)
  }
  const naturalDeadline = Date.now() + 4_000
  while (Date.now() < naturalDeadline) {
    if (!isAlive() && !existsSync(ownedEndpoint)) return
    await sleep(250)
  }
  const running = isAlive()
  process.stderr.write('TEST_ONLY_COLD_STOP_DIAGNOSTIC=' +
    JSON.stringify({ endpointPresent:existsSync(ownedEndpoint), runtimeAlive:running }) + '\n')
  if (running) {
    const escape = value => "'" + value.replaceAll("'", "''") + "'"
    const allowed = ['A','B'].map(g => escape(path.join(dirs.binaries,g+'.exe'))).join(',')
    const script = [
      '$ErrorActionPreference="Stop"',
      '$id=' + pid,
      '$p=Get-CimInstance Win32_Process -Filter ("ProcessId=" + $id)',
      'if ($null -eq $p) { Write-Output "TEST_MOCK_ALREADY_EXITED"; exit 0 }',
      '$expected=@(' + allowed + ')',
      'if (-not ($expected -contains $p.ExecutablePath)) { throw "UNOWNED_RUNTIME_PATH_NO_SIGNAL" }',
      'if ($p.CommandLine -notlike "*--chat-on-opencode-provider-service*") { throw "UNOWNED_RUNTIME_ARGS_NO_SIGNAL" }',
      'Stop-Process -Id $id -Force -ErrorAction Stop',
      'Write-Output "VERIFIED_SYNTHETIC_RUNTIME_STOPPED"',
    ].join('; ')
    const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
      windowsHide:true,shell:false,encoding:'utf8',timeout:8000,
    })
    assert.equal(result.status,0,'synthetic_runtime_cleanup_unproven:' +
      String(result.stderr).slice(0,200).replaceAll(root,'[runner-owned]'))
    assert.match(result.stdout,/VERIFIED_SYNTHETIC_RUNTIME_STOPPED|TEST_MOCK_ALREADY_EXITED/)
  }
  const exitDeadline = Date.now() + 8_000
  while (Date.now() < exitDeadline && isAlive()) await sleep(250)
  assert.equal(isAlive(),false,'test_mock_runtime_refused_exit')
  // The old mock can die without its SIGTERM listener, leaving only its
  // synthetic endpoint/token. Delete these two files only AFTER its exact
  // process has exited, so the cold B service cannot adopt stale transport.
  await rm(ownedEndpoint,{force:true})
  await rm(path.join(dirs.provider,'control-api','token'),{force:true})
  assert.equal(existsSync(ownedEndpoint),false,'owned_endpoint_cleanup_failed')
}

function drainOnlyRunnerOwnedOpenCode() {
  // The publisher correctly counts ALL official OpenCode GUI/CLI/provider
  // processes, including orphan renderer children with no listening port.
  // On the disposable runner, stop only executables proven to reside inside
  // RUNNER_TEMP. An unrelated personal process blocks the test without signal.
  const q = value => "'" + value.replaceAll("'", "''") + "'"
  const script = [
    '$ErrorActionPreference="Stop"',
    '$root=' + q(path.resolve(base)),
    '$prefix=$root.TrimEnd([char]92)+[IO.Path]::DirectorySeparatorChar',
    '$names=@("OpenCode","opencode","opencode-cli","Chat On OpenCode Provider")',
    '$targets=@([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in $names })',
    '$verified=@()',
    'foreach($proc in $targets) {',
    '  $detail=Get-CimInstance Win32_Process -Filter ("ProcessId="+$proc.Id)',
    '  if ($null -eq $detail) { continue }',
    '  if ([string]::IsNullOrWhiteSpace($detail.ExecutablePath) -or ' +
      '-not $detail.ExecutablePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { ' +
      'throw "EXTERNAL_OPEN_CODE_PROCESS_NO_SIGNAL" }',
    '  $verified+=,$detail',
    '}',
    'foreach($prior in $verified) {',
    '  $current=Get-CimInstance Win32_Process -Filter ("ProcessId="+$prior.ProcessId)',
    '  if ($null -eq $current) { continue }',
    '  if ($current.ExecutablePath -ne $prior.ExecutablePath -or ' +
      '$current.CreationDate -ne $prior.CreationDate) { throw "OPEN_CODE_PID_REUSED_NO_SIGNAL" }',
    '  Stop-Process -Id $prior.ProcessId -Force -ErrorAction Stop',
    '}',
    'Write-Output ("VERIFIED_RUNNER_OWNED_OPENCODE_STOPPED="+$verified.Count)',
  ].join('\n')
  const result = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
    shell:false,windowsHide:true,encoding:'utf8',timeout:10_000,
  })
  assert.equal(result.status,0,'runner_owned_opencode_drain_unproven:' +
    String(result.stderr).slice(0,250).replaceAll(base,'[runner-temp]'))
  assert.match(result.stdout,/^VERIFIED_RUNNER_OWNED_OPENCODE_STOPPED=\d+\s*$/)
  process.stderr.write('TEST_ONLY_OPEN_CODE_IDLE_DRAIN=' + result.stdout.trim() + '\n')
}
async function coldStopDesktop() {
  const runtimePid = await ownedRuntimePid()
  await stopDesktop()
  assert.match(stopOwnedManagedCli(), /ONLY_TEST_OWNED_SERVICE_STOPPED|OWNED_SERVICE_ALREADY_ABSENT/)
  drainOnlyRunnerOwnedOpenCode()
  await awaitRuntimeStopped(runtimePid)
}
async function journalState() {
  const file = path.join(dirs.provider, 'offline-synthetic-journal.json')
  if (!existsSync(file)) return { exists:false }
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(Array.isArray(saved.sessions) && Array.isArray(saved.events),
    'synthetic_journal_invalid')
  const records = saved.events.flatMap(entry => Array.isArray(entry[1]) ? entry[1] : [])
  return { exists:true, sessionCount:saved.sessions.length,
    eventGroupCount:saved.events.length, records:records.length,
    userReceipts:records.filter(event => event.kind === 'user_message').length,
    completedTurns:records.filter(event => event.kind === 'turn_end' && event.outcome === 'completed').length,
    custodyFiles:existsSync(path.join(dirs.provider, '.chat-on-opencode-turn-custody'))
      ? (await readdir(path.join(dirs.provider, '.chat-on-opencode-turn-custody'))).length : 0 }
}
async function openOwnedFreshSession(priorGeneration) {
  // Official signed 2.1.4 exposes exactly one visible "New session" native
  // button. Click the real GUI; never create a session via SDK/direct HTTP.
  const newButton = '[...document.querySelectorAll("button,[role=button]")].filter(e=>' +
    'e.getClientRects().length && e.getAttribute("aria-label")==="New session")'
  const limit = Date.now() + 15_000
  let count = 0
  while (Date.now() < limit) {
    count = await cdp.eval('(() => ' + newButton + '.length)()')
    if (count === 1) break
    if (count > 1) throw Error('ambiguous_native_new_session_buttons')
    await sleep(250)
  }
  const previousLocation = await cdp.eval('location.pathname + location.search + location.hash')
  if (count !== 1) {
    // Failure-only, privacy-safe DOM diagnostics from the owned test renderer.
    // Never log innerText, form values, cookies, URLs or account identifiers.
    const diagnostic = await cdp.eval(`(() => ({
      readyState: document.readyState,
      mainPresent: !!document.querySelector('main'),
      buttonCount: document.querySelectorAll('button,[role=button]').length,
      newSessionAriaCount: [...document.querySelectorAll('button,[role=button]')]
        .filter(e => e.getAttribute('aria-label') === 'New session').length,
      newSessionVisibleCount: [...document.querySelectorAll('button,[role=button]')]
        .filter(e => e.getAttribute('aria-label') === 'New session' && e.getClientRects().length).length,
      visibleComposerCount: [...document.querySelectorAll('textarea,[contenteditable=true],[role=textbox]')]
        .filter(e => e.getClientRects().length && !e.disabled).length,
      navigationKind: location.pathname === '/' ? 'root' : 'non_root'
    }))()`)
    process.stderr.write('OWNED_NEW_SESSION_READINESS_RED=' + JSON.stringify({
      ...diagnostic, localRequests: ownedNetwork.requests,
      localStatusCount: Object.fromEntries([...new Set(ownedNetwork.responses)]
        .map(status => [status, ownedNetwork.responses.filter(x => x === status).length])),
      localFailures: ownedNetwork.failures.slice(-10),
      unknownFailures: ownedNetwork.unknownFailures,
      transientProxyResets,
    }) + '\n')
  }
  assert.equal(count, 1, 'native_new_session_button_not_found')
  assert.equal(await cdp.eval('(() => {const buttons=' + newButton +
    ';if(buttons.length!==1)return false;buttons[0].click();return true})()'),
    true, 'native_new_session_click_failed')
  const old = priorGeneration ? mark(priorGeneration) : ''
  const deadline = Date.now() + 16_000
  while (Date.now() < deadline) {
    const status = await cdp.eval('(() => ({ oldAnswerPresent:' +
      '(document.querySelector("main")?.innerText??"").includes(' + JSON.stringify(old) + '),' +
      'surfaceFound:!!document.querySelector("main"),' +
      'location:location.pathname + location.search + location.hash,' +
      'composers:[...document.querySelectorAll("textarea,[contenteditable=true],[role=textbox]")]' +
      '.filter(e=>e.getClientRects().length>0&&!e.disabled).length }))()')
    // The body includes persistent session history/sidebar. Require the actual
    // conversation surface to clear, or an observed native route transition;
    // never treat an unchanged button click as proof of a new conversation.
    if (status.composers === 1 &&
        ((status.surfaceFound && !status.oldAnswerPresent) ||
          status.location !== previousLocation)) return
    await sleep(250)
  }
  throw Error('native_new_session_did_not_display_fresh_composer')
}
async function realGeneratedReader(prompt, expected) {
  // An actual on-screen composer must accept user input. Do not send a model
  // request via CLI/HTTP bypassing the GUI, or count a plugin-import receipt.
  // Persistent Desktop sessions retain previous assistant messages across
  // renderer reload AND process restart. Compare new marker occurrences to
  // the pre-submit DOM, otherwise cold B falsely fails on a stale A response.
  const nonce = 'GUI_NONCE_' + randomBytes(6).toString('hex').toUpperCase()
  const exactReply = generation => mark(generation) + ':' + nonce
  const fields = '[...document.querySelectorAll("textarea,[contenteditable=true],[role=textbox]")]'
  const visible = fields + '.filter(e=>e.getClientRects().length>0 && !e.disabled)'
  const until = Date.now() + 20_000
  let available = false
  while (Date.now() < until) {
    available = await cdp.eval('(() => { const items=' + visible +
      ';return items.length===1 })()')
    if (available) break
    await sleep(250)
  }
  if (!available) {
    const diagnostic = await cdp.eval('(() => ({title:document.title,' +
      'origin:location.origin,visibleControls:[...document.querySelectorAll("button,input,textarea,[role=textbox],[contenteditable]")]' +
      '.filter(e=>e.getClientRects().length>0).slice(0,16).map(e=>({' +
      'tag:e.tagName,role:e.getAttribute("role"),type:e.getAttribute("type"),' +
      'label:(e.getAttribute("aria-label")||e.getAttribute("placeholder")||' +
      'e.textContent||"").slice(0,80)})),bodyChars:document.body?.innerText.length??0}))()')
    process.stderr.write('OFFICIAL_214_ISOLATED_GUI_CONTROLS=' + JSON.stringify(diagnostic) + '\n')
  }
  assert.equal(available, true, 'desktop_composer_not_uniquely_visible')
  // Test-owned renderer only: watch *lengths* and monotonic timings, never response text.
  // A completed synthetic reply does not itself prove progressive rendering.
  const ownedExpectedReply = expected ? exactReply(expected) : ''
  const ownedDomObserverScript = "(() => {const root=document.querySelector(\"main\")||document.body;const state={mutations:0,distinctLengths:0,firstAt:null,lastAt:null,lastLength:root?.innerText?.length??0,partialBeforeFull:false,partialAt:null,fullAt:null};window.__cooOwnedDomStream=state;const observer=new MutationObserver(()=>{const t=performance.now();state.mutations++;const text=root?.innerText??\"\";if(state.partialAt===null&&text.includes(partial)&&!text.includes(full)){state.partialBeforeFull=true;state.partialAt=t}if(state.fullAt===null&&text.includes(full))state.fullAt=t;const length=text.length;if(length!==state.lastLength){state.distinctLengths++;state.lastLength=length;if(state.firstAt===null)state.firstAt=t;state.lastAt=t}});observer.observe(root,{subtree:true,childList:true,characterData:true});window.__cooOwnedDomStreamStop=()=>observer.disconnect()})()".replace('const root=', 'const partial=' + JSON.stringify(ownedExpectedReply.slice(0, -5)) + ';const full=' + JSON.stringify(ownedExpectedReply) + ';const root=')
  await cdp.eval(ownedDomObserverScript)
  const proxiedSseAtStart = { frames:ownedSse.frames, responses:ownedSse.responses }
  await cdp.eval('(() => {const items=' + visible + ';items[0].focus()})()')
  await cdp.call('Input.insertText', { text: prompt + ' ' + nonce })
  await cdp.call('Input.dispatchKeyEvent', { type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 })
  await cdp.call('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13 })
  // A restored renderer may expose its textarea before the conversation
  // action is enabled. After a bounded grace period, inspect ONLY the owned
  // synthetic composer. If text remains in the input and exactly one visible
  // enabled Send button exists, click that real GUI button (never call SDK).
  await sleep(4000)
  const sendSnapshot = await cdp.eval('(() => {' +
    'const fields=[...document.querySelectorAll("textarea,[contenteditable=true],[role=textbox]")].filter(e=>e.getClientRects().length && !e.disabled);' +
    'const buttons=[...document.querySelectorAll("button")].filter(e=>e.getClientRects().length && !e.disabled);' +
    'const send=buttons.filter(e=>/^(send|envoyer|submit|envia)/i.test((e.getAttribute("aria-label")||e.getAttribute("title")||e.textContent||"").trim()));' +
    'const content=fields.length===1 ? (fields[0].value??fields[0].innerText??"") : "";' +
    'const retained=content.includes(' + JSON.stringify(nonce) + ');' +
    'if(retained && send.length===1){send[0].click();return {retained:true,clickedOwnedSend:true,buttonCount:buttons.length}};' +
    'return {retained,clickedOwnedSend:false,buttonCount:buttons.length,' +
    'visibleSendCandidates:send.length};' +
  '})()')
  process.stderr.write('OWNED_SEND_DIAGNOSTIC=' + JSON.stringify(sendSnapshot) + '\n')
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const text = await cdp.eval('document.body?.innerText ?? ""')
    for (const generation of ['A', 'B']) {
      if (text.includes(exactReply(generation))) {
        if (expected) assert.equal(generation, expected, 'wrong_real_gui_generator')
        const domStream = await cdp.eval("(() => {const s=window.__cooOwnedDomStream;window.__cooOwnedDomStreamStop?.();return s?{mutations:s.mutations,distinctLengths:s.distinctLengths,elapsedMs:s.firstAt===null?0:Math.round(s.lastAt-s.firstAt),partialBeforeFull:s.partialBeforeFull,partialLeadMs:s.partialAt===null||s.fullAt===null?null:Math.round(s.fullAt-s.partialAt)}:null})()")
        process.stdout.write('OFFICIAL_GUI_DOM_STREAM_CATEGORICAL=' + JSON.stringify({
          synthetic:true, observed:domStream, progressiveProven:domStream?.partialBeforeFull===true && domStream?.partialLeadMs>0,
          loopbackResponses:ownedNetwork.responses.length,
          proxiedSseFrames:ownedSse.frames-proxiedSseAtStart.frames,
          proxiedSseResponses:ownedSse.responses-proxiedSseAtStart.responses,
          proxiedSseElapsedMs:ownedSse.firstAt===null ? 0 : Math.max(0,ownedSse.lastAt-ownedSse.firstAt),
        }) + '\n')
        assert.ok(domStream?.partialBeforeFull && domStream?.partialLeadMs > 0,
          'official_gui_synthetic_partial_not_rendered_before_final')
        process.stdout.write('OWNED_REAL_GUI_NONCE_RESPONSE=' + JSON.stringify({
          generation, probe:prompt, match:true, modelId:'chat-on-opencode/chatgpt-default',
        }) + '\n')
        return generation
      }
    }
    await sleep(350)
  }
  const body = await cdp.eval('document.body?.innerText ?? ""')
  const diagnostics = {
    promptVisible:body.includes(prompt),
    nonceVisible:body.includes(nonce),
    historicMarkers:['A','B'].filter(gen => body.includes(mark(gen))),
    pluginAImported:existsSync(path.join(dirs.receipts,'A.import')),
    pluginBImported:existsSync(path.join(dirs.receipts,'B.import')),
    syntheticJournal:await journalState(),
    transcriptRoles:await Promise.all(['A','B'].map(async generation => {
      const file = path.join(dirs.receipts, generation + '.transcript-shape.jsonl')
      if (!existsSync(file)) return { generation, exists:false }
      const lines = (await readFile(file,'utf8')).trim().split(/\r?\n/).filter(Boolean)
      return { generation, shapes:lines.slice(-5).map(line => JSON.parse(line)) }
    })),
    failureKinds:['turn_first_message_pending','turn_first_message_conflict',
      'cos_replay_input_unavailable','cos_transport_unavailable','cos_stream_ended_without_terminal']
      .filter(kind => body.includes(kind)),
    syntheticControlRoutes:existsSync(path.join(dirs.provider,'fixture-routes.txt'))
      ? (await readFile(path.join(dirs.provider,'fixture-routes.txt'),'utf8')).trim()
        .split(/\r?\n/).slice(-22).map(route => route
          .replace(/\/v1\/sessions\/[0-9a-z-]+/g, '/v1/sessions/{id}')
          .replace(/\/v1\/inputs\/[0-9a-z-]+/g, '/v1/inputs/{id}'))
      : [],
    stages:existsSync(path.join(dirs.receipts,'stages.txt'))
      ? (await readFile(path.join(dirs.receipts,'stages.txt'),'utf8')).trim().split(/\r?\n/).slice(-16)
      : [],
  }
  process.stderr.write('OWNED_COMPOSER_TIMEOUT_DIAGNOSTICS=' + JSON.stringify(diagnostics) + '\n')
  throw Error('desktop_generated_reply_not_rendered')
}
try {
  await configFor('A')
  const initialConfig = await readFile(configFile)
  const initialSha = sha(initialConfig)
  const a = generationDirs.get('A')
  const b = generationDirs.get('B')
  const aSha = candidateDigest(a)
  const bSha = candidateDigest(b)
  assert.equal(configs.get('A').model, configs.get('B').model, 'different_model_ids')
  await startDesktop()
  const coldA = await realGeneratedReader('Offline cold A actual reader marker', 'A')
  assert.ok(existsSync(path.join(dirs.receipts, 'A.import')), 'actual_plugin_A_never_imported')
  // Real Desktop same-conversation followup, NOT a fresh New session. The
  // provider must handle native user→assistant→user→user transcript history.
  // Unique reply nonce confirms generation A actually answered a second turn.
  const sameSessionA = await realGeneratedReader('Offline same native session multiturn followup', 'A')
  assert.equal(sameSessionA, 'A')
  process.stdout.write('ACTUAL_OFFICIAL_GUI_SAME_SESSION_MULTITURN_SYNTHETIC=PASS\n')
  const persistedA = await journalState()
  assert.ok(persistedA.exists && persistedA.sessionCount > 0 &&
    persistedA.userReceipts > 0 && persistedA.completedTurns > 0,
  'synthetic_CoS_journal_not_durable_after_first_reply')
  process.stderr.write('SYNTHETIC_FIRST_TURN_PERSISTENCE=' + JSON.stringify(persistedA) + '\n')
  const uiNav = await cdp.eval('(() => [...document.querySelectorAll("button,[role=button]")]' +
    '.filter(e=>e.getClientRects().length)' +
    '.map(e=>({label:(e.getAttribute("aria-label")||e.getAttribute("title")||"").slice(0,80)}))' +
    '.filter(e=>/new|nouve|chat|session|conversation/i.test(e.label)).slice(0,20))()')
  process.stderr.write('SYNTHETIC_OFFICIAL_GUI_NAV=' + JSON.stringify(uiNav) + '\n')
  if (ci) {
    // The publisher MUST reject a live official GUI. This is the required
    // RED case: do not bypass its real Windows process scan with a fake probe.
    const firstProof = { configSha:initialSha, fromSha:aSha, toSha:bSha }
    assert.throws(() => publishRestartOnlyPointer(configFile, a, b, firstProof),
      /versioned_pointer_busy_or_unknown/, 'live_gui_must_block_pointer')
    assert.deepEqual(await readFile(configFile), initialConfig, 'busy_attempt_modified_config')
    await reloadOwnedRenderer()
    await openOwnedFreshSession('A')
    const hotA = await realGeneratedReader('Offline hot A same active reader', 'A')
    await coldStopDesktop()
    // Closing the HWND alone is insufficient: the vendor's managed CLI keeps
    // plugin modules in memory. Stop only the disposable service on our port.
    assert.throws(() => publishRestartOnlyPointer(configFile, a, b, {
      ...firstProof, fault:point => { if (point === 'before_publish') throw Error('RED_before_commit') },
    }), /RED_before_commit/, 'pre_rename_failure_must_be_observable')
    assert.deepEqual(await readFile(configFile), initialConfig, 'RED_modified_config')
    const promoted = publishRestartOnlyPointer(configFile, a, b, firstProof)
    assert.equal(promoted.status, 'RESTART_REQUIRED_ONLY')
    assert.equal(promoted.activationAuthorized, false)
    assert.equal(inspectRestartOnlyPointer(configFile, initialSha,
      promoted.publishedConfigSha256).state, 'NEW')
    const promotedConfig = JSON.parse(await readFile(configFile, 'utf8'))
    assert.equal(promotedConfig.plugins[0].package, path.join(b, 'plugin'),
      'versioned_pointer_did_not_select_B_package')
    assert.deepEqual(promotedConfig.plugins[0].options, configs.get('A').plugins[0].options,
      'pointer_must_preserve_existing_runtime_options')
    assert.deepEqual(promotedConfig.providers, configs.get('A').providers,
      'pointer_must_preserve_provider_declaration')
    assert.equal(promotedConfig.model,
      'chat-on-opencode/chatgpt-default')
    assert.equal(candidateDigest(a), aSha, 'immutable_A_changed')
    assert.equal(candidateDigest(b), bSha, 'immutable_B_changed')
    await startDesktop()
    await openOwnedFreshSession('A')
    const coldB = await realGeneratedReader('Offline cold B through published pointer', 'B')
    assert.ok(existsSync(path.join(dirs.receipts, 'B.import')), 'actual_plugin_B_never_imported')
    await reloadOwnedRenderer()
    await openOwnedFreshSession('B')
    const hotB = await realGeneratedReader('Offline hot B same active reader', 'B')
    await coldStopDesktop()
    const reverted = publishRestartOnlyPointer(configFile, b, a, {
      configSha:promoted.publishedConfigSha256, fromSha:bSha, toSha:aSha,
    })
    assert.equal(reverted.status, 'RESTART_REQUIRED_ONLY')
    assert.deepEqual(await readFile(configFile), initialConfig, 'rollback_not_byte_exact')
    await startDesktop()
    await openOwnedFreshSession('B')
    const rollbackColdA = await realGeneratedReader('Offline cold A restored pointer', 'A')
    await coldStopDesktop()
    process.stdout.write(JSON.stringify({
      verified:'ACTUAL_OFFICIAL_GUI_VERSIONED_POINTER_RESTART_ONLY',
      modelId:'chat-on-opencode/chatgpt-default', coldA, hotA, coldB, hotB, rollbackColdA,
      livePointerRefused:true, faultBeforePublishRefused:true, exactRollback:true,
      onlyTestOwnedWindows:true, personalProfilesUntouched:true,
    }) + '\n')
  } else {
    // Explicit disposable local extracts keep the earlier A→cold B smoke.
    await coldStopDesktop()
    await configFor('B')
    await startDesktop()
    await openOwnedFreshSession('A')
    const coldB = await realGeneratedReader('Offline cold B actual reader marker', 'B')
    assert.ok(existsSync(path.join(dirs.receipts, 'B.import')), 'actual_plugin_B_never_imported')
    await configFor('A')
    await reloadOwnedRenderer()
    await openOwnedFreshSession('B')
    const hotB = await realGeneratedReader('Offline hot B actual reader marker', 'B')
    await coldStopDesktop()
    process.stdout.write(JSON.stringify({ verified:'ACTUAL_OFFICIAL_GUI_GENERATED_RENDER',
      modelId:'chat-on-opencode/chatgpt-default', coldA, coldB, hotB,
      onlyTestOwnedWindows:true, personalProfilesUntouched:true }) + '\n')
  }
} finally {
  try { await stopDesktop() } finally {
    const responseStatusCount = Object.fromEntries([...new Set(ownedNetwork.responses)].map(
      status => [String(status), ownedNetwork.responses.filter(s => s === status).length]))
    const failureCounts = Object.fromEntries([...new Set(ownedNetwork.failures)].map(
      reason => [reason, ownedNetwork.failures.filter(s => s === reason).length]))
    process.stderr.write('OWNED_LOCAL_NETWORK_PROOF=' + JSON.stringify({
      requests:ownedNetwork.requests, responseStatusCount,
      failureCounts,unknownFailures:ownedNetwork.unknownFailures }) + '\n')
    process.stderr.write('ISOLATED_CLI_CLEANUP=' + stopOwnedManagedCli() + '\n')
    ownedProxy.closeAllConnections()
    await new Promise(resolve => ownedProxy.close(resolve))
    process.stderr.write('OWNED_PROXY_PROOF=' +
      JSON.stringify({forwardedLocal,blockedExternal,restrictedPorts:allowedPorts.size,
        closed:true,transientProxyResets}) + '\n')
  }
  // CI runner owns cleanup of all disposable app storage and helper handles.
}
