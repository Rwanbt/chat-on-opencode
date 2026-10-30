/**
 * Genuine official OpenCode CLI 2.1.4 -> shipped plugin -> owned gateway ->
 * independently packaged Electron, with an unpaired disposable profile.
 * A refusal is EXPECTED. Never mistake this for authenticated ChatGPT inference.
 * Windows GitHub runner only. No personal browser, cookies, OAuth or secrets.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'packaged Windows CLI integration only')
const cli = process.env.CHAT_ON_OPENCODE_TEST_CLI
assert.ok(cli && path.isAbsolute(cli) && existsSync(cli), 'official CLI 2.1.4 missing')
const rootRepo = fileURLToPath(new URL('..', import.meta.url))
const legacyOverlay = process.env.CHAT_ON_OPENCODE_TEST_LEGACY_OVERLAY === '1'
const actualAdditive = legacyOverlay && process.env.CHAT_ON_OPENCODE_TEST_REAL_ADDITIVE === '1'
const packaged = path.join(rootRepo, 'release', 'provider')
const binary = path.join(packaged, 'win-unpacked', 'Chat On OpenCode Provider.exe')
const plugin = path.join(packaged, 'opencode-plugin')
assert.ok(existsSync(binary) && existsSync(path.join(plugin, 'plugin', 'index.ts')), 'packaged artifacts missing')
const tmp = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-official-cli-'))
const paths = Object.fromEntries(['appdata', 'localappdata', 'config', 'data', 'cache', 'workspace', 'isolated']
  .map(name => [name, path.join(tmp, name)]))
let child
let port
let overlayInstaller = null
let originalConfigSha = null
const preservedFiles = new Map()
let verifiedTransaction = false
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
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
  let originalConfig = null
  if (legacyOverlay) {
    // Exactly the historical 16k definition in the user's format-1 config.
    // The add-only globally discovered overlay repairs it in-memory.
    config.providers['chat-on-opencode'].models['chatgpt-default'].limit.context = 16384
    delete config.agents['chat-on-opencode-text']
    // A disposable stand-in for opencode.jsonc proves this path never edits it.
    originalConfig = '{\n  // Existing config and plugin settings are managed separately\n}\n'
    const configFile = path.join(paths.config, 'opencode.jsonc')
    await writeFile(configFile, originalConfig, { flag: 'wx' })
    originalConfigSha = sha256(await readFile(configFile))
    if (actualAdditive) {
      // Keep representative foreign plugins and the *old* managed swap chain
      // byte-for-byte; PR #47 must only add its own global plugin/agent pair.
      const plugins = path.join(paths.config, 'plugins')
      const agents = path.join(paths.config, 'agents')
      await mkdir(plugins, { recursive: true })
      await mkdir(agents, { recursive: true })
      for (const name of ['Goal', 'Loop', 'Daemon', 'Scheduler']) {
        const foreign = path.join(plugins, name, 'index.ts')
        await mkdir(path.dirname(foreign), { recursive: true })
        // These are loadable *no-op* OpenCode plugins, not invalid strings.
        // The E2E must prove real provider discovery still works when existing
        // third-party extensions are present, with their exact bytes preserved.
        const bytes = Buffer.from(
          "import { Plugin } from '@opencode/plugin'\n" +
          'export default Plugin.define({ id: ' + JSON.stringify('foreign-fixture-' + name) +
          ', async setup() { return () => {} } })\n',
        )
        await writeFile(foreign, bytes, { flag: 'wx' })
        preservedFiles.set(foreign, sha256(bytes))
      }
      const oldJournal = path.join(paths.config, '.chat-on-opencode-directory-switch.json')
      const oldPrevious = path.join(paths.config, '.chat-on-opencode-directory-previous', 'previous.js')
      const oldBackup = path.join(paths.config, 'opencode.jsonc.previous-generation.bak')
      await mkdir(path.dirname(oldPrevious), { recursive: true })
      for (const [target, contents] of [
        [oldJournal, '{"version":1,"note":"existing generation, never touch"}'],
        [oldPrevious, 'OLDER MANAGED PROVIDER GENERATION\n'],
        [oldBackup, originalConfig],
      ]) {
        const bytes = Buffer.from(contents)
        await writeFile(target, bytes, { flag: 'wx' })
        preservedFiles.set(target, sha256(bytes))
      }
      overlayInstaller = path.join(plugin, 'bin', 'additive-context.mjs')
      // An earlier packaged-CLI smoke in this job can finish its parent before
      // Windows reaps the last helper. Never bypass the installer's fail-closed
      // quiescence check: wait for the *same* process-name set to become empty.
      const processCount = () => {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode","opencode-cli","Chat On OpenCode Provider") }).Count'],
        { encoding: 'utf8', windowsHide: true, timeout: 7000 })
        if (result.status !== 0 || !/^\d+\s*$/.test(result.stdout ?? '')) return null
        return Number(result.stdout.trim())
      }
      let remaining = null
      for (let attempt = 0; attempt < 24; attempt++) {
        remaining = processCount()
        if (remaining === 0) break
        if (remaining === null) break
        await pause(500)
      }
      assert.equal(remaining, 0, 'additive install requires truly idle official app; count is ' +
        (remaining === null ? 'unknown' : remaining))
      const additive = (args) => {
        const result = spawnSync(process.execPath, [
          overlayInstaller, ...args, '--config', configFile, '--bundle', plugin,
        ], { cwd: paths.workspace, encoding: 'utf8', timeout: 20000, windowsHide: true })
        const diagnostic = String(result.error?.code ?? result.stderr)
        const category = ['additive_opencode_processes_active_or_unknown', 'additive_pin_mismatch',
          'additive_existing_install_or_journal', 'additive_unsafe_path',
          'additive_source_or_configuration_changed'].find(value => diagnostic.includes(value)) ?? 'other'
        assert.equal(result.status, 0, 'transactional additive CLI failed, category=' + category)
        return JSON.parse(result.stdout)
      }
      const digest = spawnSync(process.execPath,
        [overlayInstaller, '--digest', '--bundle', plugin],
        { cwd: paths.workspace, encoding: 'utf8', timeout: 10000, windowsHide: true })
      assert.equal(digest.status, 0, 'bundle digest failed')
      const sourceSha = JSON.parse(digest.stdout).sourceSha256
      assert.match(sourceSha, /^[a-f0-9]{64}$/)
      assert.equal(additive(['--status']).state, 'absent')
      const installed = additive([
        '--install', '--config-sha256', originalConfigSha, '--source-sha256', sourceSha,
      ])
      assert.equal(installed.installed, true)
      assert.equal(installed.sourceSha256, sourceSha)
      assert.equal(additive(['--status']).state, 'installed')
      assert.equal(sha256(await readFile(configFile)), originalConfigSha)
      for (const [file, sha] of preservedFiles) {
        assert.equal(sha256(await readFile(file)), sha, 'foreign file mutated by installation')
      }
      verifiedTransaction = true
      process.stdout.write('ACTUAL_ADDITIVE_INSTALLATION=PASS\n')
    } else {
      const overlaySource = path.join(plugin, 'src', 'context-overlay')
      const overlayTarget = path.join(paths.config, 'plugins', 'chat-on-opencode-context-overlay')
      const agents = path.join(paths.config, 'agents')
      await mkdir(overlayTarget, { recursive: true })
      await mkdir(agents, { recursive: true })
      for (const name of ['index.ts', 'overlay.mjs']) {
        await copyFile(path.join(overlaySource, name), path.join(overlayTarget, name))
      }
      await copyFile(path.join(overlaySource, 'chat-on-opencode-browser-text.md'),
        path.join(agents, 'chat-on-opencode-text.md'))
    }
  }
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
  const errorCategories = {}
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      const type = typeof event.type === 'string' ? event.type : 'unknown'
      eventCounts[type] = (eventCounts[type] ?? 0) + 1
      if (type === 'error') {
        // Only a fixed, non-sensitive category: no error message, prompt,
        // stack, path, account or provider response leaves the fixture.
        const code = String(event.error?.data?.code ?? event.error?.name ?? '')
        const category = /AbortError/i.test(code) ? 'aborted'
          : /ModelNotFound/i.test(code) ? 'model_not_found'
          : /ProviderNotFound/i.test(code) ? 'provider_not_found'
          : /Authentication/i.test(code) ? 'authentication'
          : /UnknownAgent/i.test(code) ? 'agent_unavailable'
          : /APIError/i.test(code) ? 'api_error' : 'other'
        errorCategories[category] = (errorCategories[category] ?? 0) + 1
      }
    } catch {}
  }
  const has = expression => expression.test(journal)
  process.stdout.write('OFFICIAL_CLI_CATEGORICAL_DIAG=' + JSON.stringify({
    gatewayReached, refusalObserved, exited: child.exitCode !== null,
    stdoutNonempty: !!stdout.length, stderrNonempty: !!stderr.length,
    events: eventCounts, errorCategories, logModelRequest: has(/model\.request/),
    logHttpRequest: has(/http\.request/), logCompaction: has(/compaction/),
    logError: has(/\b(ERROR|WARN)\b/i), logRefusal: has(/chatgpt_sign_in_required|cos_companion_unpaired/)
  }) + '\n')
  assert.equal(emittedText.length, 0, 'an unpaired provider must never return assistant inference')
  assert.equal(gatewayReached, true, 'official CLI did not reach real packaged Electron-owned gateway')
  assert.equal(refusalObserved, true, 'unpaired official CLI must surface typed ChatGPT sign-in refusal')
  if (legacyOverlay) {
    assert.equal(await readFile(path.join(paths.config, 'opencode.jsonc'), 'utf8'),
      originalConfig, 'global legacy overlay must not rewrite opencode.jsonc')
    process.stdout.write('LEGACY_16K_CONTEXT_ADDITIVE_OVERLAY=PASS\n')
  }
  process.stdout.write('OFFICIAL_CLI_2_1_4_PACKAGED_ELECTRON_GATEWAY=PASS\n')
  process.stdout.write('UNPAIRED_AUTH_REFUSAL=PASS\n')
} finally {
  await stopTestChild()
  if (actualAdditive && verifiedTransaction) {
    const configFile = path.join(paths.config, 'opencode.jsonc')
    const removed = spawnSync(process.execPath, [
      overlayInstaller, '--remove', '--config', configFile, '--bundle', plugin,
    ], { cwd: paths.workspace, encoding: 'utf8', timeout: 20000, windowsHide: true })
    assert.equal(removed.status, 0,
      'transactional rollback failed: ' + String(removed.error?.code ?? removed.stderr).slice(-300))
    assert.equal(JSON.parse(removed.stdout).removed, true)
    assert.equal(sha256(await readFile(configFile)), originalConfigSha)
    for (const [file, sha] of preservedFiles) {
      assert.equal(sha256(await readFile(file)), sha, 'foreign file mutated by rollback')
    }
    for (const name of [
      path.join(paths.config, 'plugins', 'chat-on-opencode-context-overlay'),
      path.join(paths.config, 'agents', 'chat-on-opencode-text.md'),
      path.join(paths.config, '.chat-on-opencode-context-overlay.receipt.json'),
      path.join(paths.config, '.chat-on-opencode-context-overlay.pending.json'),
    ]) assert.equal(existsSync(name), false, 'owned additive resource survives rollback')
    process.stdout.write('ACTUAL_ADDITIVE_ROLLBACK=PASS\n')
    process.stdout.write('EXISTING_SWAP_AND_USER_PLUGINS_UNCHANGED=PASS\n')
  }
  for (let n = 0; n < 20; n++) {
    try { await rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break }
    catch (error) { if (n === 19) throw error; await pause(400) }
  }
}
