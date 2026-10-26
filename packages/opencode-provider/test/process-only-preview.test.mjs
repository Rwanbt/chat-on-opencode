import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { cpSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installProvider, inspectInstalledProvider } from '../src/official-install.mjs'
import { stageUpgrade, publishVersionedCandidate } from '../src/official-upgrade.mjs'
import { createProcessOnlyPreview, smokeProcessOnlyPreview } from '../src/process-only-preview.mjs'

const bundle = fileURLToPath(new URL('..', import.meta.url))
const hash = v => createHash('sha256').update(v).digest('hex')
const version = () => ({ status: 0, stdout: 'opencode v2.1.4\n' })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-process-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const dir of ['config', 'home', 'data', 'cache', 'appdata', 'localappdata', 'tmp',
    'workspace', 'runtime-data', 'future']) await mkdir(path.join(root, dir))
  const configFile = path.join(root, 'config', 'opencode.jsonc')
  const oldConfig = '{\r\n // Goal Loop Daemon preserved\r\n "plugins": ["Goal","Loop"],'+
    '\r\n "providers": {"unrelated":{"apiKey":"PRIVATE_DO_NOT_COPY"}},'+
    '\r\n "daemon": {"enabled":true}\r\n}\r\n'
  await writeFile(configFile, oldConfig)
  await writeFile(path.join(root, 'runtime.exe'), 'dummy, never executed')
  await writeFile(path.join(root, 'opencode.exe'), 'dummy, never executed')
  await writeFile(path.join(root, 'runtime-data', 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const install = { configFile, officialCli: path.join(root, 'opencode.exe'), bundleDir: bundle,
    runtimeExecutable: path.join(root, 'runtime.exe'), runtimeData: path.join(root, 'runtime-data'),
    nodeExecutable: process.execPath }
  installProvider(install, { runner: version })
  for (const folder of ['bin', 'src', 'plugin']) cpSync(path.join(bundle, folder),
    path.join(root, 'future', folder), { recursive: true })
  for (const file of ['package.json', 'README.md', 'opencode.example.jsonc']) {
    cpSync(path.join(bundle, file), path.join(root, 'future', file))
  }
  const { stagedDigest } = stageUpgrade({ configFile, bundleDir: path.join(root, 'future'),
    officialCli: install.officialCli }, { runner: version })
  publishVersionedCandidate(configFile)
  return { root, configFile, options: { root, publishedSha256: stagedDigest,
    officialCli: install.officialCli, nodeExecutable: process.execPath } }
}

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

test('preview uses only process-child variables and refuses to duplicate user auth or unrelated config', async t => {
  const c = await fixture(t)
  const before = await readFile(c.configFile)
  const backup = inspectInstalledProvider(c.configFile).manifest.backup
  const originalBackup = await readFile(backup)
  const previous = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'MUST_NEVER_ENTER_CHILD_ENV'
  try {
    const plan = createProcessOnlyPreview(c.options, { runner: version })
    const parsed = JSON.parse(plan.env.OPENCODE_CONFIG_CONTENT)
    assert.deepEqual(Object.keys(parsed).sort(), ['plugins', 'providers'])
    assert.equal(parsed.plugins.length, 1)
    assert.equal(parsed.plugins[0].options.nativeTools, 'off')
    assert.equal(parsed.providers['chat-on-opencode'].models['chatgpt-default'].capabilities.tools, false)
    assert.ok(parsed.plugins[0].package.includes('.chat-on-opencode-version-'))
    assert.equal(JSON.stringify(plan.env).includes('MUST_NEVER_ENTER_CHILD_ENV'), false)
    assert.equal(JSON.stringify(plan.env).includes('PRIVATE_DO_NOT_COPY'), false)
    assert.equal(plan.env.OPENAI_API_KEY, undefined)
    assert.equal(plan.env.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
    assert.deepEqual(plan.args, ['models', '--standalone'])
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previous
  }
  assert.deepEqual(await readFile(c.configFile), before)
  assert.deepEqual(await readFile(backup), originalBackup)
})

test('model readout through a single fake child confirms without touching active bytes', async t => {
  const c = await fixture(t)
  const before = await readFile(c.configFile)
  let stops = 0
  const result = await smokeProcessOnlyPreview(c.options, { runner: version,
    launcher(_cli, args, opts) {
      assert.deepEqual(args, ['models', '--standalone'])
      assert.equal(opts.env.OPENCODE_CONFIG_PROJECT_DISABLE, '1')
      const child = fakeChild()
      queueMicrotask(() => child.stdout.write('unrelated/model\nchat-on-opencode/chatgpt-default\n'))
      return child
    },
    stopper(child) { stops++; queueMicrotask(() => child.emit('close', 1)) },
  })
  assert.deepEqual(result, { modelPresent: true, cliVersion: '2.1.4', configUnchanged: true,
    processOnly: true, promotionAllowed: false })
  assert.equal(stops, 1)
  assert.deepEqual(await readFile(c.configFile), before)
})

test('fail-closed for wrong version, tampered candidate, junction and outside root', async t => {
  const c = await fixture(t)
  assert.throws(() => createProcessOnlyPreview(c.options, { runner: () => ({ status: 0, stdout: 'opencode v2.2.0' }) }),
    /preview_official_cli_214_required/)
  assert.throws(() => createProcessOnlyPreview({ ...c.options, publishedSha256: 'not-a-sha' }, { runner: version }),
    /upgrade_published_digest_invalid/)
  assert.throws(() => createProcessOnlyPreview({ ...c.options, root: path.dirname(c.root) }, { runner: version }),
    /preview_root_must_be_disposable|preview_incorrect_path_kind/)
  const link = path.join(c.root, 'alias')
  symlinkSync(path.join(c.root, 'runtime-data'), link, process.platform === 'win32' ? 'junction' : 'dir')
  await rm(path.join(c.root, 'runtime-data'), { recursive: true })
  symlinkSync(link, path.join(c.root, 'runtime-data'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => createProcessOnlyPreview(c.options, { runner: version }), /preview_symlink_or_junction_refused/)
})

test('modified published file is rejected before any child launch', async t => {
  const c = await fixture(t)
  const candidate = path.join(c.root, 'config',
    '.chat-on-opencode-version-' + c.options.publishedSha256, 'plugin', 'index.ts')
  await writeFile(candidate, 'modified candidate')
  let launched = false
  await assert.rejects(smokeProcessOnlyPreview(c.options, { runner: version,
    launcher() { launched = true; return fakeChild() },
  }), /upgrade_published_candidate_invalid/)
  assert.equal(launched, false)
})

test('CLI refuses unknown options without printing private paths or secrets', async t => {
  const c = await fixture(t)
  const cli = fileURLToPath(new URL('../bin/official-process-preview.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, '--root', c.root, '--cli', c.options.officialCli,
    '--sha', c.options.publishedSha256, '--promote'], { encoding: 'utf8', shell: false, timeout: 5000 })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes(c.root), false)
  assert.equal(result.stderr.includes('PRIVATE_DO_NOT_COPY'), false)
})

test('external JSONC edit during child launch is detected and never overwritten', async t => {
  const c = await fixture(t)
  let changed
  await assert.rejects(smokeProcessOnlyPreview(c.options, { runner: version,
    launcher() {
      const child = fakeChild()
      queueMicrotask(async () => {
        changed = Buffer.concat([await readFile(c.configFile), Buffer.from('\n// concurrent edit')])
        await writeFile(c.configFile, changed)
        child.stdout.write('chat-on-opencode/chatgpt-default\n')
      })
      return child
    },
    stopper(child) { queueMicrotask(() => child.emit('close', 1)) },
  }), /provider_config_modified_refuse_rollback|preview_config_drift/)
  assert.deepEqual(await readFile(c.configFile), changed)
})

test('process-only model smoke refuses missing model without requesting inference', async t => {
  const c = await fixture(t)
  await assert.rejects(smokeProcessOnlyPreview(c.options, { runner: version,
    launcher() {
      const child = fakeChild()
      queueMicrotask(() => { child.stdout.write('another/model\n'); child.emit('close', 0) })
      return child
    },
  }), /preview_model_not_confirmed/)
})

test('real official CLI 2.1.4 reads model from env-only candidate without personal profile', {
  skip: !process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI ? 'explicit real CLI path not provided' : false,
  timeout: 90000,
}, async t => {
  const c = await fixture(t)
  const original = await readFile(c.configFile)
  const cli = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
  const result = await smokeProcessOnlyPreview({ ...c.options, officialCli: cli })
  assert.equal(result.modelPresent, true)
  assert.equal(result.processOnly, true)
  assert.equal(result.promotionAllowed, false)
  assert.deepEqual(await readFile(c.configFile), original)
})
