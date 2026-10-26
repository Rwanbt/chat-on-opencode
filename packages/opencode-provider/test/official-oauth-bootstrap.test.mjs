import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installProvider, inspectInstalledProvider } from '../src/official-install.mjs'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { stageOAuthBootstrap, removeOAuthBootstrap, oauthBootstrapStatus } from '../src/official-oauth-bootstrap.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const official = process.env.CHAT_ON_OPENCODE_TEST_CLI
const quiet = { probe: () => ({ status: 0, stdout: '0\r\n' }), expectedSha256: candidateDigest(source) }
const busy = { ...quiet, probe: () => ({ status: 0, stdout: '7\r\n' }) }

async function fixture(t, { oldProvider = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-oauth-bootstrap-'))
  const children = new Set()
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 5000 })
      } else if (child.exitCode === null) child.kill('SIGTERM')
    }
    await Promise.all([...children].filter(child => child.exitCode === null).map(child =>
      Promise.race([new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 4000))])))
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
  })
  const configDir = path.join(root, 'config'), old = path.join(root, 'old')
  const profile = path.join(root, 'profile'), workspace = path.join(root, 'workspace')
  for (const dir of [configDir, old, profile, workspace]) await mkdir(dir)
  for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(source, name), path.join(old, name), { recursive: true })
  for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) cpSync(path.join(source, name), path.join(old, name))
  const index = path.join(old, 'plugin', 'index.ts')
  const before = readFileSync(index, 'utf8')
  assert.ok(before.includes("if (ctx.options.nativeOAuth !== 'off') await registerNativeSIWC(ctx)"))
  if (oldProvider) {
    writeFileSync(index, before.replace("if (ctx.options.nativeOAuth !== 'off') await registerNativeSIWC(ctx)", '// Previous installed bundle: no OAuth registration'))
  }
  const config = path.join(configDir, 'opencode.jsonc')
  writeFileSync(config, '{"plugins":[],"providers":{},"goal":{"enabled":true},"loop":true,"daemon":true}\n')
  const cli = path.join(root, 'fake-cli.exe'), runtime = path.join(root, 'fake-runtime.exe')
  writeFileSync(cli, 'synthetic'), writeFileSync(runtime, 'synthetic')
  writeFileSync(path.join(profile, 'config.json'), '{"ui":{"chatBrowser":"cos"},"controlApi":{"enabled":true,"allowActions":true}}')
  installProvider({ configFile: config, officialCli: cli, bundleDir: old, runtimeExecutable: runtime,
    runtimeData: profile, nodeExecutable: process.execPath },
  { runner: () => ({ status: 0, stdout: 'opencode v2.1.4\n' }) })
  return { root, configDir, config, workspace, children, managed: inspectInstalledProvider(config).managed }
}

function preserved(v) {
  const info = inspectInstalledProvider(v.config)
  return { config: readFileSync(v.config), manifest: readFileSync(path.join(info.managed, 'install-manifest.json')),
    plugin: readFileSync(path.join(info.managed, 'plugin', 'index.ts')), backup: readFileSync(info.manifest.backup) }
}

function equalPreserved(before, after) {
  for (const field of Object.keys(before)) assert.deepEqual(after[field], before[field], field)
}

async function availablePort() {
  const srv = createServer()
  await new Promise((resolve, reject) => srv.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = srv.address().port
  await new Promise(resolve => srv.close(resolve))
  return port
}

async function probeServer(v, port, child, pw, expectedOAuth) {
  const headers = { Authorization: 'Basic ' + Buffer.from('opencode:' + pw).toString('base64') }
  const until = Date.now() + 27000
  let lastStatus
  while (Date.now() < until && child.exitCode === null) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/integration/chat-on-opencode', {
        headers, signal: AbortSignal.timeout(1200), redirect: 'error',
      })
      lastStatus = response.status
      if (response.ok) {
        const body = await response.json()
        const methods = body.data?.methods ?? body.methods
        if (Array.isArray(methods) &&
          methods.some(m => m.id === 'chatgpt' && m.type === 'oauth') === expectedOAuth) {
          return { methods, headers }
        }
      }
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  throw Error('official_integration_unavailable_' + lastStatus + '_exit_' + child.exitCode)
}

async function runOfficial(t, v, expectedOAuth) {
  assert.ok(path.isAbsolute(official) && existsSync(official))
  const port = await availablePort(), pw = randomBytes(24).toString('base64url')
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)) env[name] = value
  }
  for (const name of ['home', 'data', 'cache', 'appdata', 'localappdata']) {
    await mkdir(path.join(v.root, name), { recursive: true })
  }
  Object.assign(env, {
    HOME: path.join(v.root, 'home'), USERPROFILE: path.join(v.root, 'home'),
    APPDATA: path.join(v.root, 'appdata'), LOCALAPPDATA: path.join(v.root, 'localappdata'),
    XDG_CONFIG_HOME: v.configDir, XDG_DATA_HOME: path.join(v.root, 'data'),
    XDG_CACHE_HOME: path.join(v.root, 'cache'), OPENCODE_CONFIG_DIR: v.configDir,
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: pw,
  })
  const child = spawn(official, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: v.workspace, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  v.children.add(child)
  let diagnostic = ''
  child.stderr.on('data', data => { if (diagnostic.length < 2500) diagnostic += String(data) })
  child.stdout.on('data', data => { if (diagnostic.length < 2500) diagnostic += String(data) })
  const stop = () => {
    if (child.exitCode !== null) return
    if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 5000 })
    else child.kill('SIGTERM')
  }
  try { return { ...await probeServer(v, port, child, pw, expectedOAuth), stop, child, port } }
  catch (error) { throw Error(error.message + ' startup-output=' + diagnostic.replace(/[A-Z]:\\[^\s]+/gi, '[isolated-path]').slice(0, 400)) }
}

test('side-by-side OAuth bootstrap changes no config, active payload, manifest or original backup', async t => {
  const v = await fixture(t), before = preserved(v)
  assert.throws(() => stageOAuthBootstrap(v.config, source, busy),
    /oauth_bootstrap_official_processes_active_or_unknown/)
  assert.equal(existsSync(path.join(v.configDir, 'plugins')), false)
  assert.throws(() => stageOAuthBootstrap(v.config, source, {
    ...quiet, expectedSha256: 'a'.repeat(64),
  }), /oauth_bootstrap_candidate_untrusted/)
  const staged = stageOAuthBootstrap(v.config, source, quiet)
  assert.equal(staged.staged, true)
  assert.equal(oauthBootstrapStatus(v.config).present, true)
  equalPreserved(before, preserved(v))
  assert.throws(() => stageOAuthBootstrap(v.config, source, quiet), /oauth_bootstrap_exists/)
  assert.equal(removeOAuthBootstrap(v.config, quiet).removed, true)
  equalPreserved(before, preserved(v))
  assert.equal(oauthBootstrapStatus(v.config).present, false)
})

test('a provider that already offers native OAuth refuses competing bootstrap', async t => {
  const v = await fixture(t, { oldProvider: false }), before = preserved(v)
  assert.throws(() => stageOAuthBootstrap(v.config, source, quiet),
    /oauth_bootstrap_native_oauth_already_available/)
  assert.equal(existsSync(path.join(v.configDir, 'plugins')), false)
  equalPreserved(before, preserved(v))
})

test('bootstrap refuses tampered versioned files, symlinks and external config mutation', async t => {
  const v = await fixture(t), before = preserved(v)
  stageOAuthBootstrap(v.config, source, quiet)
  const plugin = path.join(v.configDir, 'plugins', 'chat-on-opencode-oauth-bootstrap')
  const marker = path.join(plugin, 'payload', 'plugin', 'native-siwc.mjs')
  const bytes = readFileSync(marker)
  writeFileSync(marker, 'tampered')
  assert.throws(() => removeOAuthBootstrap(v.config, quiet), /oauth_bootstrap_payload_changed/)
  equalPreserved(before, preserved(v))
  writeFileSync(marker, bytes)
  const dir = path.join(plugin, 'payload', 'attacker')
  symlinkSync(v.workspace, dir, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => removeOAuthBootstrap(v.config, quiet), /oauth_bootstrap_unsafe/)
  await rm(dir)
  writeFileSync(v.config, Buffer.concat([before.config, Buffer.from('//changed')]))
  assert.throws(() => removeOAuthBootstrap(v.config, quiet), /oauth_bootstrap_config_changed|provider_config_modified_refuse_rollback/)
  assert.ok(existsSync(plugin))
})

test('real OpenCode 2.1.4 discovers bootstrap alongside old format-1 provider; OAuth only', {
  skip: !official ? 'CHAT_ON_OPENCODE_TEST_CLI required' : false,
  timeout: 110000,
}, async t => {
  const v = await fixture(t), before = preserved(v)
  const baseline = await runOfficial(t, v, false)
  assert.equal(baseline.methods.some(m => m.id === 'chatgpt' && m.type === 'oauth'), false)
  baseline.stop()
  await new Promise((resolve, reject) => {
    if (baseline.child.exitCode !== null) return resolve()
    const timer = setTimeout(() => reject(Error('baseline_official_process_did_not_exit')), 5000)
    baseline.child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  stageOAuthBootstrap(v.config, source, quiet)
  const enabled = await runOfficial(t, v, true)
  const entry = enabled.methods.find(m => m.id === 'chatgpt' && m.type === 'oauth')
  assert.ok(entry, 'OAuth not registered by global shim')
  assert.equal(entry.label, 'Continue with ChatGPT')
  assert.equal(enabled.methods.some(m => m.type === 'key'), false)
  // Native OpenCode starts an owned loopback OAuth attempt. Do not open a
  // browser, exchange tokens or log the authorization URL.
  const endpoint = 'http://127.0.0.1:' + enabled.port + '/api/integration/chat-on-opencode/connect/oauth'
  const connect = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4500),
    headers: { ...enabled.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ methodID: 'chatgpt', answer: null, label: null }),
  })
  assert.equal(connect.status, 200, 'native OAuth attempt refused')
  const body = await connect.json()
  assert.ok(typeof body.data?.attemptID === 'string')
  assert.match(JSON.stringify(body.data), /auth\.openai\.com/)
  const cancel = await fetch(endpoint + '/' + encodeURIComponent(body.data.attemptID), {
    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(4500),
    headers: enabled.headers,
  })
  assert.equal(cancel.status, 204)
  equalPreserved(before, preserved(v))
})
