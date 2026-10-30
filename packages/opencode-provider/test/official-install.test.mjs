import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { addScopedProvider, readJSONC } from '../src/jsonc-scoped.mjs'
import { checkInstall, installProvider, rollbackProvider } from '../src/official-install.mjs'
import { parseOptions, checkOfficialModel, smokeOfficialModel, smokePassed } from '../bin/official-model-check.mjs'

const bundleDir = fileURLToPath(new URL('..', import.meta.url))
const version = value => () => ({ status: 0, stdout: 'opencode v' + value + '\n' })

function generated() {
  return { plugins: [{ package: '/tmp/dedicated/plugin', options: {} }],
    providers: { 'chat-on-opencode': { name: 'Provider', models: { 'chatgpt-default': {} } } } }
}

test('JSONC appends two entries without normalizing or removing original comments', () => {
  for (const source of ['{}', '{\n// comments\n"goal":{"enabled":true,},\n}',
    '{"plugins": ["goal",], "providers": {"other": 1,}, "loop": true, }',
    '{/* keep */ "plugins": [], "providers": {}, "other": [1,2]}',
    '{"plugins": ["loop"], /*comment*/ "providers": {"a":0} }',
  ]) {
    const result = addScopedProvider(source, generated())
    const parsed = readJSONC(result)
    assert.equal(parsed.type, 'object')
    assert.ok(result.includes('"chat-on-opencode"'))
    assert.ok(result.includes('"chatgpt-default"'))
    assert.ok(result.includes('"/tmp/dedicated/plugin"'))
    const portions = source.match(/goal|loop|comments|other|\/\* keep \*\//g) ?? []
    portions.forEach(portion => assert.ok(result.includes(portion)))
  }
  assert.throws(() => readJSONC('{"a":1,"a":2}'), /duplicate_jsonc_key/)
  assert.throws(() => readJSONC('{"a":1,"b" 2}'), /invalid_jsonc_colon/)
  assert.throws(() => addScopedProvider('{"providers":{"chat-on-opencode":1}}', generated()), /provider_already_present/)
  assert.throws(() => addScopedProvider('{"plugins": {}}', generated()), /plugins_must_be_array/)
})

async function synthetic(t, configText = '{\r\n  // keep existing settings exactly\r\n  "plugins": [{"package":"goal-loop"}],\r\n  "providers": {"existing":{"models":{}}},\r\n  "goal": {"keep":true},\r\n  "loop": {"keep":true},\r\n  "daemon": {"keep":true}\r\n}\r\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-install-synthetic-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'opencode')
  const profile = path.join(root, 'provider-profile')
  await mkdir(directory)
  await mkdir(profile)
  const configFile = path.join(directory, 'opencode.jsonc')
  await writeFile(configFile, configText)
  await writeFile(path.join(profile, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const fakeCli = path.join(root, 'opencode.exe')
  const fakeRuntime = path.join(root, 'provider.exe')
  await writeFile(fakeCli, 'dummy')
  await writeFile(fakeRuntime, 'dummy')
  return { root, configFile, original: configText, options: {
    configFile, officialCli: fakeCli, bundleDir,
    runtimeExecutable: fakeRuntime, runtimeData: profile, nodeExecutable: process.execPath,
  } }
}

test('scoped install + rollback preserve Goal/Loop/Daemon and every original byte', async t => {
  const ctx = await synthetic(t)
  const runner = version('2.0.32')
  const preflight = checkInstall(ctx.options, { runner })
  assert.equal(await readFile(ctx.configFile, 'utf8'), ctx.original)
  assert.ok(preflight.proposed.includes('"chatgpt-default"'))
  const installed = installProvider(ctx.options, { runner })
  assert.ok(installed.installed)
  const active = await readFile(ctx.configFile, 'utf8')
  assert.ok(active.includes('// keep existing settings exactly\r\n'))
  assert.ok(active.includes('"package":"goal-loop"'))
  for (const name of ['goal','loop','daemon','goal-loop','existing']) assert.ok(active.includes(name))
  assert.equal(await readFile(installed.backup, 'utf8'), ctx.original)
  const manifest = JSON.parse(await readFile(path.join(path.dirname(ctx.configFile),
    '.chat-on-opencode-managed', 'install-manifest.json'), 'utf8'))
  assert.equal(manifest.installedSha256, installed.installedSha256)
  assert.equal((await stat(path.join(path.dirname(ctx.configFile),
    '.chat-on-opencode-managed', 'plugin', 'index.ts'))).isFile(), true)
  assert.throws(() => installProvider(ctx.options, { runner }), /provider_previous_install_or_backup_present/)
  const restored = rollbackProvider(ctx.configFile)
  assert.ok(restored.rolledBack)
  assert.equal(await readFile(ctx.configFile, 'utf8'), ctx.original)
  assert.equal((await readdir(path.dirname(ctx.configFile))).includes('.chat-on-opencode-managed'), false)
  assert.equal(await readFile(installed.backup, 'utf8'), ctx.original)
  // Preserved historic backups must not prevent a new, independently backed install.
  const next = installProvider(ctx.options, { runner })
  assert.notEqual(next.backup, installed.backup)
  rollbackProvider(ctx.configFile)
})

test('rollback preserves a foreign edit, and install refuses unsupported official CLI', async t => {
  const ctx = await synthetic(t)
  assert.throws(() => checkInstall(ctx.options, { runner: version('2.2.0') }),
    /official_cli_plugin_api_unqualified/)
  assert.equal(checkInstall(ctx.options, { runner: version('2.1.4') }).version, '2.1.4')
  assert.equal(await readFile(ctx.configFile, 'utf8'), ctx.original)
  installProvider(ctx.options, { runner: version('2.0.29') })
  const manifest = JSON.parse(await readFile(path.join(path.dirname(ctx.configFile),
    '.chat-on-opencode-managed', 'install-manifest.json'), 'utf8'))
  const edited = (await readFile(ctx.configFile, 'utf8')) + '\n// user modified after install\n'
  await writeFile(ctx.configFile, edited)
  // A foreign edit is never destroyed by a rollback: only the owned entries go.
  const result = rollbackProvider(ctx.configFile)
  assert.equal(result.rolledBack, true)
  assert.equal(result.mode, 'SCOPED_REMOVAL')
  const restored = await readFile(ctx.configFile, 'utf8')
  assert.ok(restored.includes('// user modified after install'))
  assert.ok(!restored.includes('chat-on-opencode'))
  // The immutable backup still holds the exact original bytes.
  assert.equal(await readFile(manifest.backup, 'utf8'), ctx.original)
})

test('rollback refuses to delete modified managed payload and keeps config intact', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.0.32') })
  const managedPlugin = path.join(path.dirname(ctx.configFile),
    '.chat-on-opencode-managed', 'plugin', 'index.ts')
  const originalPlugin = await readFile(managedPlugin)
  await writeFile(managedPlugin, Buffer.concat([originalPlugin, Buffer.from('\n// edit\n')]))
  const configBefore = await readFile(ctx.configFile, 'utf8')
  assert.throws(() => rollbackProvider(ctx.configFile), /provider_payload_modified_refuse_delete/)
  assert.equal(await readFile(ctx.configFile, 'utf8'), configBefore)
  await writeFile(managedPlugin, originalPlugin)
  assert.equal(rollbackProvider(ctx.configFile).rolledBack, true)
})

test('real installed official CLI capability gate is read-only, with no personal config access', async () => {
  const cli = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
  if (!cli) return
  // Each test creates a fresh temp config, but a real --version may be queried read-only.
  const dummy = { officialCli: cli }
  assert.ok(dummy.officialCli)
  const processResult = spawnSync(cli, ['--version'], { shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 5000 })
  assert.equal(typeof processResult.stdout, 'string')
})

test('official model preflight verifies exact managed manifest and CLI version without writes', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const prior = await readFile(ctx.configFile)
  const plan = checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.1.4') })
  assert.equal(plan.version, '2.1.4')
  assert.deepEqual(await readFile(ctx.configFile), prior)
  assert.throws(() => checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.0.32') }), /official_cli_version_mismatch/)
  // A foreign edit no longer invalidates the installation: the preflight pins
  // the bytes it actually inspected, and the smoke refuses a plan whose bytes
  // moved underneath it.
  const edited = Buffer.concat([prior, Buffer.from('\n// concurrent user edit\n')])
  await writeFile(ctx.configFile, edited)
  const afterEdit = checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.1.4') })
  assert.equal(afterEdit.version, '2.1.4')
  assert.notEqual(afterEdit.configSha256, plan.configSha256)
  await assert.rejects(async () => smokeOfficialModel(plan, {
    launcher() { assert.fail('the child must not start on a stale plan') },
    stopper() {},
  }), /official_model_config_changed_since_plan/)
  assert.deepEqual(await readFile(ctx.configFile), edited)
  assert.deepEqual(parseOptions(['--smoke', '--config', ctx.configFile, '--cli', ctx.options.officialCli]), {
    smoke: true, config: ctx.configFile, cli: ctx.options.officialCli,
  })
  assert.throws(() => parseOptions(['--config', ctx.configFile, '--config', ctx.configFile]),
    /invalid_model_check_argument/)
  assert.throws(() => parseOptions(['--config', ctx.configFile, '--cli', ctx.options.officialCli,
    '--unknown']), /unknown_model_check_argument/)
})

test('official model smoke uses child-only ephemeral key, exact model and terminates only its child', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const plan = checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.1.4') })
  const previous = await readFile(ctx.configFile)
  let checked = false
  let stopped = 0
  const result = await smokeOfficialModel(plan, {
    launcher(executable, args, options) {
      assert.equal(executable, ctx.options.officialCli)
      assert.deepEqual(args, ['models', '--standalone'])
      assert.equal(options.env.OPENCODE_CONFIG_DIR, path.dirname(ctx.configFile))
      assert.equal(options.env.CHAT_ON_OPENCODE_GATEWAY_KEY.length, 64)
      assert.notEqual(options.env.CHAT_ON_OPENCODE_GATEWAY_KEY, process.env.CHAT_ON_OPENCODE_GATEWAY_KEY)
      assert.equal(options.env.OPENCODE_DISABLE_AUTOUPDATE, '1')
      checked = true
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        child.stdout.write('other/model\nchat-on-opencode/chatg')
        child.stdout.write('pt-default\n')
      })
      return child
    },
    stopper(child) {
      stopped++
      queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    },
  })
  assert.ok(checked)
  assert.equal(stopped, 1)
  assert.equal(result.modelPresent, true)
  assert.equal(result.configUnchanged, true)
  assert.equal(result.officialCliVersion, '2.1.4')
  assert.equal(result.terminatedAfterMatch, true)
  assert.equal(smokePassed(result), true)
  assert.deepEqual(await readFile(ctx.configFile), previous)
})

test('official model smoke refuses absence and accidental config mutation', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.0.32') })
  const plan = checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.0.32') })
  const launch = (message, change) => ({
    stopper() { /* synthetic child exits on its own in the next microtask */ },
    launcher() {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(async () => {
        if (change) await writeFile(ctx.configFile, (await readFile(ctx.configFile, 'utf8')) + ' ')
        child.stdout.write(message)
        child.emit('close', 0, null)
      })
      return child
    },
  })
  const missing = await smokeOfficialModel(plan, launch('other/model\n', false))
  assert.equal(missing.modelPresent, false)
  assert.equal(smokePassed(missing), false)
  assert.equal(missing.configUnchanged, true)
  const mutated = await smokeOfficialModel(plan, launch('chat-on-opencode/chatgpt-default\n', true))
  assert.equal(mutated.modelPresent, true)
  assert.equal(mutated.configUnchanged, false)
  assert.equal(smokePassed(mutated), false)
  // The plan was made against the previous bytes: the smoke refuses it rather
  // than probing against a config that moved underneath it.
  await assert.rejects(async () => smokeOfficialModel(plan, launch('chat-on-opencode/chatgpt-default\n')),
    /official_model_config_changed_since_plan/)
})

test('model smoke distinguishes native CLI crash, child error, and bounded shutdown', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const plan = checkOfficialModel({ config: ctx.configFile, cli: ctx.options.officialCli },
    { runner: version('2.1.4') })
  const newChild = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    return child
  }
  const crashed = await smokeOfficialModel(plan, {
    launcher() {
      const child = newChild()
      // The final unterminated model line is not a successful CLI invocation.
      queueMicrotask(() => { child.stdout.write('chat-on-opencode/chatgpt-default'); child.emit('close', 1, null) })
      return child
    },
    stopper() { assert.fail('already closed child must not be killed') },
  })
  assert.equal(crashed.modelPresent, true)
  assert.equal(crashed.terminatedAfterMatch, false)
  assert.equal(smokePassed(crashed), false)

  await assert.rejects(() => smokeOfficialModel(plan, {
    launcher() {
      const child = newChild()
      queueMicrotask(() => child.emit('error', new Error('synthetic_spawn_error')))
      return child
    },
  }), /synthetic_spawn_error/)

  let stopped = 0
  await assert.rejects(() => smokeOfficialModel(plan, {
    launcher() { return newChild() },
    stopper() { stopped++ },
    startupTimeoutMs: 15, shutdownTimeoutMs: 15,
  }), /official_model_child_did_not_exit/)
  assert.equal(stopped, 1)

  let secret
  const recovered = await smokeOfficialModel(plan, {
    launcher(_exe, _args, options) {
      secret = options.env.CHAT_ON_OPENCODE_GATEWAY_KEY
      const child = newChild()
      queueMicrotask(() => {
        child.stdout.write('chat-on-opencode/chatgpt-default\n')
        child.emit('close', 1, null) // Windows taskkill can produce exit code 1
      })
      return child
    },
    stopper() {},
  })
  assert.equal(smokePassed(recovered), true)
  assert.equal(JSON.stringify(recovered).includes(secret), false)
  assert.equal((await readFile(ctx.configFile, 'utf8')).includes(secret), false)
})
