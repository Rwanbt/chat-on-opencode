/** Windows-only, no-inference probe of the real official CLI -> plugin -> gateway -> packaged Electron. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = process.env.COO_OFFLINE_OFFICIAL_CLI
const ELECTRON = process.env.COO_OFFLINE_PROVIDER_EXE
const here = path.dirname(fileURLToPath(import.meta.url))
const source = path.resolve(here, '..')
const hasInputs = process.platform === 'win32' && CLI && ELECTRON && existsSync(CLI) && existsSync(ELECTRON)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test('official 2.2.0 run --standalone launches real packaged Electron without inference', {
  skip: hasInputs ? false : 'Windows plus COO_OFFLINE_OFFICIAL_CLI and COO_OFFLINE_PROVIDER_EXE are required',
  timeout: 55_000,
}, async () => {
  const version = spawnSync(CLI, ['--version'], { encoding: 'utf8', timeout: 5000 })
  assert.match(version.stdout, /opencode v2\.2\.0/)
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-provider-e2e-offline-'))
  let child
  try {
    const listener = createServer()
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    for (const name of ['home', 'appdata', 'localappdata', 'config', 'data', 'cache', 'workspace', 'profile']) {
      mkdirSync(path.join(root, name))
    }
    // Frozen, non-secret output of scripts/provider-isolated-profile.ts.
    // No app-module imports or Bun compilation are needed at test runtime.
    const consent = JSON.parse(readFileSync(path.join(here, 'fixtures', 'consented-provider-default-config.json'), 'utf8'))
    assert.equal(consent.ui.chatBrowser, 'cos')
    assert.deepEqual(consent.controlApi, { enabled: true, allowActions: true })
    assert.deepEqual(consent.roots, [])
    assert.ok(Object.values(consent.capabilities).every(value => value === false))
    writeFileSync(path.join(root, 'profile', 'config.json'), JSON.stringify(consent))
    const bundle = path.join(root, 'bundle')
    cpSync(source, bundle, { recursive: true, filter: file => !/node_modules|\.git/.test(file) })
    const entry = path.join(bundle, 'plugin', 'index.ts')
    let code = readFileSync(entry, 'utf8')
    // Test-only: launch provider and throw before the HTTP model request. No credentials or inference.
    assert.ok(code.includes('      await service.ensure()'))
    code = code.replace('      await service.ensure()', "      await service.ensure()\n      throw new Error('offline_probe_before_inference')")
    code = code.replace("option('runtimeExecutable'),", "option('runtimeExecutable') ?? process.env.COO_OFFLINE_PROVIDER_EXE,")
      .replace("option('runtimeData'),", "option('runtimeData') ?? process.env.COO_OFFLINE_PROFILE,")
      .replace("option('nodeExecutable') ?? '',", "option('nodeExecutable') ?? process.env.COO_OFFLINE_NODE ?? '',")
      .replace("option('port') ?? '45861'", "option('port') ?? process.env.COO_OFFLINE_PORT ?? '45861'")
    writeFileSync(entry, code)
    const config = {
      plugin: [path.join(bundle, 'plugin')],
      provider: { 'chat-on-opencode': {
        npm: '@ai-sdk/openai-compatible', name: 'offline',
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        models: { 'chatgpt-default': { name: 'offline', limit: { context: 65536, output: 2048 } } },
      } },
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP)$/i.test(name)))
    Object.assign(env, {
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
      OPENCODE_CONFIG_DIR: path.join(root, 'config'), OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
      COO_OFFLINE_PROVIDER_EXE: ELECTRON, COO_OFFLINE_PROFILE: path.join(root, 'profile'),
      COO_OFFLINE_NODE: process.execPath, COO_OFFLINE_PORT: String(port),
      CHAT_ON_OPENCODE_STAGE_TRACE: path.join(root, 'trace'),
    })
    child = spawn(CLI, ['run', '--standalone', '--model', 'chat-on-opencode/chatgpt-default',
      '--agent', 'build', 'offline probe no inference'], {
      cwd: path.join(root, 'workspace'), shell: false, windowsHide: true,
      stdio: 'ignore', env,
    })
    const required = ['plugin_setup', 'model_request', 'gateway_child_spawned', 'runtime_child_spawned']
    let stages = []
    const deadline = Date.now() + 27_000
    while (Date.now() < deadline) {
      stages = existsSync(env.CHAT_ON_OPENCODE_STAGE_TRACE)
        ? readFileSync(env.CHAT_ON_OPENCODE_STAGE_TRACE, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []
      if (stages.includes('gateway_listening') || stages.includes('runtime_child_exited')) break
      if (child.exitCode !== null && stages.includes('model_request')) break
      await pause(250)
    }
    const filtered = [...new Set(stages)].filter(stage => /^[a-z_]+$/.test(stage))
    // Only fixed categorical stages are reported; never print stdout, prompts, paths or tokens.
    process.stdout.write(JSON.stringify({ stages: filtered, connected: filtered.includes('control_connected'),
      listening: filtered.includes('gateway_listening') }) + '\n')
    for (const stage of required) assert.ok(filtered.includes(stage), `missing categorical stage: ${stage}`)
    assert.ok(filtered.includes('control_connected'), 'real packaged Electron never connected its isolated control endpoint')
    assert.ok(filtered.includes('gateway_listening'), 'owned gateway never reached authenticated health state')
  } finally {
    if (child?.pid && child.exitCode === null) {
      // Only terminate the isolated CLI process tree spawned by this test.
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, timeout: 5000 })
    }
    await pause(400)
    rmSync(root, { recursive: true, force: true })
  }
})
