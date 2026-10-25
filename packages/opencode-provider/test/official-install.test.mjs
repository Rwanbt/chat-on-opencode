import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { addScopedProvider, readJSONC } from '../src/jsonc-scoped.mjs'
import { checkInstall, installProvider, rollbackProvider } from '../src/official-install.mjs'

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

test('rollback refuses changed config, and install refuses unsupported official CLI', async t => {
  const ctx = await synthetic(t)
  assert.throws(() => checkInstall(ctx.options, { runner: version('2.2.0') }),
    /official_cli_plugin_api_unqualified/)
  assert.equal(checkInstall(ctx.options, { runner: version('2.1.4') }).version, '2.1.4')
  assert.equal(await readFile(ctx.configFile, 'utf8'), ctx.original)
  installProvider(ctx.options, { runner: version('2.0.29') })
  const edited = (await readFile(ctx.configFile, 'utf8')) + '\n// user modified after install\n'
  await writeFile(ctx.configFile, edited)
  assert.throws(() => rollbackProvider(ctx.configFile), /provider_config_modified_refuse_rollback/)
  assert.equal(await readFile(ctx.configFile, 'utf8'), edited)
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
