import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installProvider } from '../src/official-install.mjs'
import { planOfficialPreview, previewOfficialModel } from '../src/official-preview.mjs'
import { parsePreviewArgs } from '../bin/official-preview.mjs'

const bundleDir = fileURLToPath(new URL('..', import.meta.url))
const mockedVersion = () => ({ status: 0, stdout: 'opencode v2.1.4\n' })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-preview-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'config'), profile = path.join(root, 'runtime')
  await mkdir(dir)
  await mkdir(profile)
  const configFile = path.join(dir, 'opencode.jsonc')
  const original = '{// user config\n"plugins":["goal","loop"],"providers":{"other":{}},"daemon":true}'
  await writeFile(configFile, original)
  await writeFile(path.join(profile, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
    privateFixture: 'DO_NOT_COPY_THIS_SECRET',
  }))
  const cli = path.join(root, 'opencode.exe'), runtime = path.join(root, 'runtime.exe')
  await writeFile(cli, 'synthetic executable never launched')
  await writeFile(runtime, 'synthetic executable never launched')
  const options = { configFile, officialCli: cli, bundleDir, runtimeExecutable: runtime,
    runtimeData: profile, nodeExecutable: process.execPath }
  installProvider(options, { runner: mockedVersion })
  return { root, options }
}

function mockLauncher({
  output = 'chat-on-opencode/chatgpt-default\n', stderr = '', childCode = 0,
  onLaunch = () => {},
} = {}) {
  return (cli, args, opts) => {
    onLaunch({ cli, args, opts })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = null
    child.exitCode = null
    queueMicrotask(() => {
      child.stdout.end(output)
      child.stderr.end(stderr)
      child.exitCode = childCode
      child.emit('close', childCode)
    })
    return child
  }
}

test('process-only candidate model check preserves live byte hashes and never imports other plugins', async t => {
  const { options } = await fixture(t)
  const plan = planOfficialPreview(options, { runner: mockedVersion })
  const original = await readFile(options.configFile)
  let captured
  const result = await previewOfficialModel(plan, {
    launcher: mockLauncher({ onLaunch: p => { captured = p } }),
  })
  assert.equal(result.status, 'PREVIEW_MODEL_AVAILABLE')
  assert.equal(result.modelPresent, true)
  assert.equal(result.originalUnchanged, true)
  assert.equal(result.inferenceAuthenticated, false)
  assert.equal(result.activeInstallationUpgraded, false)
  assert.deepEqual(await readFile(options.configFile), original)
  assert.deepEqual(captured.args, ['models', '--standalone'])
  assert.equal(captured.opts.env.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
  assert.equal(captured.opts.env.OPENCODE_DISABLE_AUTOUPDATE, '1')
  assert.notEqual(captured.opts.env.HOME, os.homedir())
  assert.ok(captured.opts.env.TEMP.startsWith(path.dirname(captured.opts.env.HOME)))
  assert.equal(captured.opts.env.TEMP, captured.opts.env.TMP)
  const injected = JSON.parse(captured.opts.env.OPENCODE_CONFIG_CONTENT)
  assert.equal(injected.plugins.length, 1)
  assert.ok(injected.plugins[0].package.endsWith(path.join('opencode-provider', 'plugin')))
  assert.deepEqual(Object.keys(injected.providers), ['chat-on-opencode'])
  assert.doesNotMatch(JSON.stringify(injected), /DO_NOT_COPY_THIS_SECRET|"goal"|"loop"/)
})

test('no inference is claimed if child model is missing, regardless of exit', async t => {
  const { options } = await fixture(t)
  const plan = planOfficialPreview(options, { runner: mockedVersion })
  const result = await previewOfficialModel(plan, {
    launcher: mockLauncher({ output: 'some-other-model\n' }),
  })
  assert.equal(result.status, 'NO_GO_PREVIEW')
  assert.equal(result.modelPresent, false)
  assert.equal(result.originalUnchanged, true)
})

test('standalone CLI partial final model line terminates without waiting for EOF', async t => {
  const { options } = await fixture(t)
  const plan = planOfficialPreview(options, { runner: mockedVersion })
  let terminated = 0
  const result = await previewOfficialModel(plan, {
    timeoutMs: 1500,
    launcher: () => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 123456
      child.exitCode = null
      queueMicrotask(() => child.stdout.write('chat-on-opencode/chatgpt-default'))
      return child
    },
    terminator: child => {
      terminated++
      child.exitCode = 0
      child.emit('close', 0)
    },
  })
  assert.equal(terminated, 1)
  assert.equal(result.status, 'PREVIEW_MODEL_AVAILABLE')
})

test('changed active config and changed candidate fail closed before launching a child', async t => {
  const { options } = await fixture(t)
  const plan = planOfficialPreview(options, { runner: mockedVersion })
  const before = await readFile(options.configFile)
  await writeFile(options.configFile, Buffer.concat([before, Buffer.from('// extra editor comment')]))
  await assert.rejects(() => previewOfficialModel(plan, { launcher: () => {
    throw Error('should_not_launch')
  } }), /preview_source_changed/)
  assert.throws(() => planOfficialPreview(options, { runner: mockedVersion }),
    /provider_config_modified_refuse_rollback/)
})

test('bad CLI versions and CLI argument manipulation are rejected without spawning services', async t => {
  const { options } = await fixture(t)
  assert.throws(() => planOfficialPreview(options, { runner: () => ({ status: 0, stdout: 'opencode v2.2.0' }) }),
    /preview_official_cli_unqualified/)
  assert.throws(() => parsePreviewArgs(['--config', 'relative']), /preview_all_absolute_paths_required/)
  assert.throws(() => parsePreviewArgs(['--config', options.configFile, '--config', 'duplicate']),
    /preview_arguments_invalid/)
})

test('optional real official OpenCode 2.1.4 models probe uses only a synthetic installed profile', {
  skip: !process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI,
  timeout: 60000,
}, async t => {
  const cli = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-preview-real-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cfg = path.join(root, 'config'), provider = path.join(root, 'provider')
  await mkdir(cfg); await mkdir(provider)
  await writeFile(path.join(provider, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const runtime = path.join(root, 'runtime.exe')
  await writeFile(runtime, 'offline never executed')
  const configFile = path.join(cfg, 'opencode.jsonc')
  await writeFile(configFile, '{"plugins":["goal"],"providers":{},"daemon":true}')
  const options = { configFile, officialCli: cli, bundleDir,
    runtimeExecutable: runtime, runtimeData: provider, nodeExecutable: process.execPath }
  const version = spawnSync(cli, ['--version'], { windowsHide: true, shell: false,
    encoding: 'utf8', timeout: 5000 })
  assert.equal(version.status, 0)
  installProvider(options, { runner: () => version })
  const plan = planOfficialPreview(options, { runner: () => version })
  const result = await previewOfficialModel(plan, { timeoutMs: 30000 })
  assert.equal(result.modelPresent, true)
  assert.equal(result.originalUnchanged, true)
})
