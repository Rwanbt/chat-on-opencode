/**
 * Genuine official OpenCode CLI 2.1.4 -> shipped plugin -> owned gateway ->
 * independently packaged Electron, with an unpaired disposable profile.
 * A refusal is EXPECTED. Never mistake this for authenticated ChatGPT inference.
 * Windows GitHub runner only. No personal browser, cookies, OAuth or secrets.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'packaged Windows CLI integration only')
const cli = process.env.CHAT_ON_OPENCODE_TEST_CLI
assert.ok(cli && path.isAbsolute(cli) && existsSync(cli), 'official CLI 2.1.4 missing')
const rootRepo = fileURLToPath(new URL('..', import.meta.url))
const packaged = path.join(rootRepo, 'release', 'provider')
const binary = path.join(packaged, 'win-unpacked', 'Chat On OpenCode Provider.exe')
const plugin = path.join(packaged, 'opencode-plugin')
assert.ok(existsSync(binary) && existsSync(path.join(plugin, 'plugin', 'index.ts')), 'packaged artifacts missing')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-official-cli-'))
const paths = Object.fromEntries(['appdata', 'localappdata', 'config', 'data', 'cache', 'workspace', 'isolated']
  .map(name => [name, path.join(tmp, name)]))
let child
let port
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function stopTestChild() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise(resolve => child.once('close', resolve)), pause(2500)])
  if (child.exitCode === null && child.pid) {
    // CI disposable process tree ONLY; never target a real user's OpenCode.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
      shell: false, windowsHide: true, timeout: 8000,
    })
  }
}
try {
  for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true })
  const profile = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', paths.isolated], {
    cwd: rootRepo, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000,
  })
  assert.equal(profile.status, 0, 'disposable service profile fixture failed')
  port = await freePort()
  const generated = spawnSync(process.execPath, [path.join(rootRepo,
    'packages', 'opencode-provider', 'bin', 'generate-config.mjs'),
    '--runtime', binary, '--data', paths.isolated, '--node', process.execPath,
    '--plugin-dir', plugin, '--port', String(port)], {
    cwd: paths.workspace, encoding: 'utf8', windowsHide: true, shell: false, timeout: 8000,
  })
  assert.equal(generated.status, 0, 'standalone config generator failed')
  const config = JSON.parse(generated.stdout)
  assert.equal(config.providers['chat-on-opencode'].models['chatgpt-default'].limit.context, 65536)
  config.plugins[0].options.nativeOAuth = 'off' // native OAuth always requires explicit consent
  // Preserve the coherent Windows HOME/USERPROFILE that Electron requires.
  // Only the per-process OpenCode and provider data move to disposable folders.
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^(CHAT_ON_OPENCODE_|COS_|ELECTRON_|OPENAI_API_KEY$|OPENCODE_SERVER_PASSWORD$)/i.test(name)) delete env[name]
  }
  Object.assign(env, {
    APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata,
    XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data,
    XDG_CACHE_HOME: paths.cache, OPENCODE_CONFIG_DIR: paths.config,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    CLF_BRIDGE_PORTS: '8765', // must be disregarded by provider, pinned to 8766
  })
  assert.equal(env.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
  assert.equal(env.HOME, process.env.HOME)
  assert.equal(env.USERPROFILE, process.env.USERPROFILE)
  const prompt = 'Only reply with OFFICIAL_PACKAGED_PROOF_IF_AUTHENTICATED'
  child = spawn(cli, ['run', '--standalone', '--format', 'json',
    '--model', 'chat-on-opencode/chatgpt-default', '--agent', 'chat-on-opencode-text', prompt], {
    cwd: paths.workspace, env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-150_000) })
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-50_000) })
  let gatewayReached = false
  let refusalObserved = false
  const deadline = Date.now() + 85_000
  for (;;) {
    try {
      const health = await fetch('http://127.0.0.1:' + port + '/health', {
        redirect: 'error', signal: AbortSignal.timeout(1200),
      })
      if (health.status === 401) gatewayReached = true
    } catch { /* the selected plugin may not have started its gateway yet */ }
    refusalObserved = /chatgpt_sign_in_required|chatgpt_session_unobserved|cos_companion_unpaired|cos_companion_not_connected/.test(stdout + stderr)
    if (gatewayReached && refusalObserved) break
    if (child.exitCode !== null || Date.now() >= deadline) break
    await pause(250)
  }
  const emittedText = stdout.split(/\r?\n/).flatMap(line => {
    try { const event = JSON.parse(line); return event.type === 'text' ? [event.part?.text ?? ''] : [] }
    catch { return [] }
  }).join('')
  let journal = ''
  try { journal = await readFile(path.join(paths.data, 'opencode', 'log', 'opencode.log'), 'utf8') } catch {}
  const eventCounts = {}
  for (const line of stdout.split(/\\r?\\n/)) {
    try {
      const event = JSON.parse(line)
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      eventCounts[type] = (eventCounts[type] ?? 0) + 1
    } catch {}
  }
  const has = expression => expression.test(journal)
  process.stdout.write('OFFICIAL_CLI_CATEGORICAL_DIAG=' + JSON.stringify({
    gatewayReached, refusalObserved, exited: child.exitCode !== null,
    stdoutNonempty: !!stdout.length, stderrNonempty: !!stderr.length,
    events: eventCounts, logModelRequest: has(/model\\.request/),
    logHttpRequest: has(/http\\.request/), logCompaction: has(/compaction/),
    logError: has(/\\b(ERROR|WARN)\\b/i), logRefusal: has(/chatgpt_sign_in_required|cos_companion_unpaired/)
  }) + '\\n')
  assert.equal(emittedText.length, 0, 'an unpaired provider must never return assistant inference')
  assert.equal(gatewayReached, true, 'official CLI did not reach real packaged Electron-owned gateway')
  assert.equal(refusalObserved, true, 'unpaired official CLI must surface typed ChatGPT sign-in refusal')
  process.stdout.write('OFFICIAL_CLI_2_1_4_PACKAGED_ELECTRON_GATEWAY=PASS\n')
  process.stdout.write('UNPAIRED_AUTH_REFUSAL=PASS\n')
} finally {
  await stopTestChild()
  for (let n = 0; n < 20; n++) {
    try { await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break }
    catch (error) { if (n === 19) throw error; await pause(400) }
  }
}
