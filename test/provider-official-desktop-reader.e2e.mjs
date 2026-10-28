/**
 * REAL unmodified official Desktop 2.1.4 GUI reader acceptance.
 * CI-only; no personal files, app instances, processes, or browser windows.
 *
 * Both generations advertise the SAME model ID. A provider-import marker is
 * necessary but never sufficient: the unique generated text must actually
 * appear in the owned Desktop renderer. Compare cold A, hot reload B, cold B.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createOpenCodeConfig } from '../packages/opencode-provider/src/config.mjs'

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
  for (const name of ['bin', 'plugin', 'src']) {
    await cp(path.join(packageRoot, name), path.join(pluginDir, name), { recursive: true })
  }
  const entry = path.join(pluginDir, 'plugin', 'index.ts')
  const source = await readFile(entry, 'utf8')
  const importReceipt = path.join(dirs.receipts, generation + '.import')
  await writeFile(entry, "import { writeFileSync as guiImportReceipt } from 'node:fs'\n" +
    'guiImportReceipt(' + JSON.stringify(importReceipt) + ', ' + JSON.stringify(generation) + ')\n' + source)
  const config = createOpenCodeConfig({
    runtimeExecutable: binary, runtimeData: dirs.provider,
    nodeExecutable: process.execPath, pluginDir, port: await port(),
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
  CHAT_ON_OPENCODE_TEST_TRACE_DIR: dirs.provider,
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
    response.writeHead(reply.statusCode, reply.headers)
    reply.pipe(response)
  })
  upstream.setTimeout(12_000, () => upstream.destroy(Error('owned_upstream_timeout')))
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  request.pipe(upstream)
})
ownedProxy.on('connect', (_request, socket) => {
  blockedExternal++
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
})
ownedProxy.on('upgrade', (_request, socket) => {
  blockedExternal++
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
    stages:existsSync(path.join(dirs.receipts,'stages.txt'))
      ? (await readFile(path.join(dirs.receipts,'stages.txt'),'utf8')).trim().split(/\r?\n/).slice(-16)
      : [],
  }
  process.stderr.write('OWNED_COMPOSER_TIMEOUT_DIAGNOSTICS=' + JSON.stringify(diagnostics) + '\n')
  throw Error('desktop_generated_reply_not_rendered')
}
try {
  await configFor('A')
  await startDesktop()
  const coldA = await realGeneratedReader('Offline cold A actual reader marker', 'A')
  assert.ok(existsSync(path.join(dirs.receipts, 'A.import')), 'actual_plugin_A_never_imported')
  await stopDesktop()
  // A Desktop process restart without stopping its background CLI is NOT cold:
  // that service retains plugin modules, model settings and session state.
  // Stop ONLY the disposable service on this exact test-owned port first.
  assert.match(stopOwnedManagedCli(), /ONLY_TEST_OWNED_SERVICE_STOPPED|OWNED_SERVICE_ALREADY_ABSENT/)
  await configFor('B')
  await startDesktop()
  const coldB = await realGeneratedReader('Offline cold B actual reader marker', 'B')
  assert.ok(existsSync(path.join(dirs.receipts, 'B.import')), 'actual_plugin_B_never_imported')
  // A hot renderer reload is not a service restart; observe whether the
  // running B service preserves B or imports A after changing the config.
  await configFor('A')
  await cdp.call('Page.reload', { ignoreCache: true })
  await sleep(1500)
  const hot = await realGeneratedReader('Offline hot reload actual reader marker', 'A')
  await stopDesktop()
  process.stdout.write(JSON.stringify({
    verified: 'ACTUAL_OFFICIAL_GUI_GENERATED_RENDER',
    modelId: 'chat-on-opencode/chatgpt-default', coldA, hot, coldB,
    onlyTestOwnedWindows: true, personalProfilesUntouched: true,
  }) + '\n')
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
        closed:true}) + '\n')
  }
  // CI runner owns cleanup of all disposable app storage and helper handles.
}
