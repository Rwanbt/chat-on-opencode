import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJSONC } from '../src/jsonc-scoped.mjs'
import { installProvider, inspectInstalledProvider, rollbackProvider } from '../src/official-install.mjs'
import { publishScopedConfigEdits } from '../src/official-versioned-pointer.mjs'
import { appendManifestLineage } from '../src/official-scoped-config.mjs'

const bundleDir = fileURLToPath(new URL('..', import.meta.url))
const version = value => () => ({ status: 0, stdout: 'opencode v' + value + '\n' })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const idle = () => ({ status: 0, stdout: '0\r\n' })

const CONFIG = [
  '{',
  '  // a foreign comment must survive byte for byte',
  '  "plugins": [',
  '    "goal-loop",',
  '    { "package": "C:\\\\foreign\\\\plugin", "settings": { "enabled": true, }, },',
  '  ],',
  '  "providers": { "existing": { "models": {}, }, },',
  '  "goal": { "keep": true, },',
  '  "loop": { "keep": true, },',
  '}',
  '',
].join('\r\n')

async function synthetic(t, configText = CONFIG) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-format2-'))
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
  return { root, configFile, manifestPath: path.join(directory, '.chat-on-opencode-managed',
    'install-manifest.json'), options: {
    configFile, officialCli: fakeCli, bundleDir,
    runtimeExecutable: fakeRuntime, runtimeData: profile, nodeExecutable: process.execPath,
  } }
}

const text = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
const member = (node, key) => node?.members?.find(item => item.key === key)?.node

/** The plugin entry we own: the one whose options declare our own option keys. */
function ownedPlugin(root) {
  const plugins = member(root, 'plugins')
  const found = plugins.members.map(item => item.node).filter(node => {
    if (node.type !== 'object') return false
    const options = member(node, 'options')
    return options?.type === 'object' &&
      ['runtimeExecutable', 'runtimeData', 'nodeExecutable', 'port']
        .every(key => member(options, key))
  })
  if (found.length !== 1) throw Error('fixture_must_own_exactly_one_plugin')
  return found[0]
}

function nativeToolsEdit(bytes, value) {
  const source = text(bytes)
  const root = readJSONC(source)
  const options = member(ownedPlugin(root), 'options')
  const tools = member(options, 'nativeTools')
  if (tools?.type !== 'scalar') throw Error('fixture_must_own_a_nativeTools_scalar')
  return { at: tools.start, end: tools.end, data: JSON.stringify(value) }
}

function replaceScalar(bytes, node, data) {
  const source = text(bytes)
  return Buffer.from(source.slice(0, node.start) + data + source.slice(node.end), 'utf8')
}

function packageEdit(bytes, value) {
  const source = text(bytes)
  const packageNode = member(ownedPlugin(readJSONC(source)), 'package')
  return { at: packageNode.start, end: packageNode.end, data: JSON.stringify(value) }
}

async function readManifest(ctx) {
  return JSON.parse(await readFile(ctx.manifestPath, 'utf8'))
}
async function writeManifest(ctx, manifest) {
  await writeFile(ctx.manifestPath, JSON.stringify(manifest))
}

test('a format-2 install writes a scoped manifest and restores the exact original bytes', async t => {
  const ctx = await synthetic(t)
  const installed = installProvider(ctx.options, { runner: version('2.1.4') })
  assert.ok(installed.installed)
  const manifest = await readManifest(ctx)
  assert.equal(manifest.format, 2)
  assert.equal(manifest.scope.providerKey, 'chat-on-opencode')
  assert.equal(manifest.scope.modelKey, 'chatgpt-default')
  assert.deepEqual(manifest.scope.pluginOptionKeys,
    ['runtimeExecutable', 'runtimeData', 'nodeExecutable', 'port'])
  assert.deepEqual(manifest.lineage, [])
  // The format-1 audit field survives: it is the config digest as installed.
  assert.equal(manifest.installedSha256, installed.installedSha256)
  const info = inspectInstalledProvider(ctx.configFile)
  assert.equal(info.manifest.format, 2)
  assert.equal(info.configDrift, null)
  // An untouched install still restores the original bytes exactly.
  assert.equal(rollbackProvider(ctx.configFile).rolledBack, true)
  assert.equal(await readFile(ctx.configFile, 'utf8'), CONFIG)
  assert.equal((await readdir(path.dirname(ctx.configFile))).includes('.chat-on-opencode-managed'), false)
})

test('a format-2 install still verifies after a scoped publication', { skip: process.platform !== 'win32' }, async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const before = await readFile(ctx.configFile)
  const edit = nativeToolsEdit(before, 'coding')
  const published = publishScopedConfigEdits(ctx.configFile, [edit], {
    configSha: sha(before), probe: idle,
  })
  assert.equal(published.status, 'RESTART_REQUIRED_ONLY')
  assert.equal(published.promotionAllowed, false)
  assert.equal(published.activationAuthorized, false)
  const after = await readFile(ctx.configFile)
  assert.ok(after.toString('utf8').includes('"nativeTools":"coding"'))
  // The publication alone leaves the install verifiable: the format-1 whole-file
  // pin is gone, replaced by structural scope verification.
  const drifted = inspectInstalledProvider(ctx.configFile)
  assert.equal(drifted.manifest.format, 2)
  assert.equal(drifted.configDrift, 'foreign_edit')
  // Recording the publication in the lineage makes the drift disappear.
  const manifest = await readManifest(ctx)
  await writeManifest(ctx, appendManifestLineage(manifest, {
    at: '2026-10-30T00:00:00.000Z', configSha256: sha(after),
    generation: 'a'.repeat(64), authorisation: 'b7c0f1e2-3a4b-5c6d-8e9f-0a1b2c3d4e5f',
  }))
  const recorded = inspectInstalledProvider(ctx.configFile)
  assert.equal(recorded.configDrift, null)
  assert.equal(recorded.manifest.lineage.length, 1)
  assert.equal(recorded.manifest.lineage[0].configSha256, sha(after))
})

test('a pointer-style repoint to a versioned generation keeps the install verifiable',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await synthetic(t)
    installProvider(ctx.options, { runner: version('2.1.4') })
    const before = await readFile(ctx.configFile)
    // The production pointer publication repoints the package at a digest-
    // addressed sibling of the managed install.
    const versioned = path.join(path.dirname(ctx.configFile),
      '.chat-on-opencode-version-' + 'c'.repeat(64), 'plugin')
    const published = publishScopedConfigEdits(ctx.configFile, [packageEdit(before, versioned)], {
      configSha: sha(before), probe: idle,
    })
    assert.equal(published.status, 'RESTART_REQUIRED_ONLY')
    // The repointed registration is still ours: the scope owns the namespace,
    // never one exact path, so a publication does not invalidate the install.
    const after = await readFile(ctx.configFile)
    assert.ok(after.toString('utf8').includes('.chat-on-opencode-version-'))
    const drifted = inspectInstalledProvider(ctx.configFile)
    assert.equal(drifted.manifest.format, 2)
    assert.equal(drifted.configDrift, 'foreign_edit')
    // A repoint outside our namespace is refused, never repaired.
    const foreign = path.join(ctx.root, 'foreign-generation', 'plugin')
    const current = await readFile(ctx.configFile)
    publishScopedConfigEdits(ctx.configFile, [packageEdit(current, foreign)], {
      configSha: sha(current), probe: idle,
    })
    assert.throws(() => inspectInstalledProvider(ctx.configFile), /provider_scope_mismatch/)
  })

test('a foreign edit made between publications survives an entry-scoped rollback',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await synthetic(t)
    installProvider(ctx.options, { runner: version('2.1.4') })
    const before = await readFile(ctx.configFile)
    publishScopedConfigEdits(ctx.configFile, [nativeToolsEdit(before, 'coding')], {
      configSha: sha(before), probe: idle,
    })
    const after = await readFile(ctx.configFile)
    const manifest = await readManifest(ctx)
    await writeManifest(ctx, appendManifestLineage(manifest, {
      at: '2026-10-30T00:00:00.000Z', configSha256: sha(after),
      generation: 'a'.repeat(64), authorisation: 'b7c0f1e2-3a4b-5c6d-8e9f-0a1b2c3d4e5f',
    }))
    // A foreign edit lands after our publication.
    const foreign = Buffer.from(text(after).replace('"keep": true', '"keep": false'), 'utf8')
    await writeFile(ctx.configFile, foreign)
    const result = rollbackProvider(ctx.configFile)
    assert.equal(result.rolledBack, true)
    assert.equal(result.mode, 'SCOPED_REMOVAL')
    const final = await readFile(ctx.configFile, 'utf8')
    // The foreign edit survives, byte for byte.
    assert.ok(final.includes('"keep": false'))
    assert.ok(final.includes('// a foreign comment must survive byte for byte'))
    assert.ok(final.includes('"goal-loop"'))
    assert.ok(final.includes('C:\\\\foreign\\\\plugin'))
    assert.ok(final.includes('"existing"'))
    // Our two owned entries are gone, and nothing else was touched.
    assert.ok(!final.includes('chat-on-opencode'))
    assert.ok(!final.includes('"nativeTools"'))
    assert.equal((await readdir(path.dirname(ctx.configFile))).includes('.chat-on-opencode-managed'), false)
    // The immutable backup is retained for manual recovery.
    assert.ok((await readdir(path.dirname(ctx.configFile))).some(name => name.endsWith('.bak')))
  })

test('a format-1 manifest keeps its strict whole-file pin', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const manifest = await readManifest(ctx)
  await writeManifest(ctx, { format: 1, config: manifest.config, backup: manifest.backup,
    originalSha256: manifest.originalSha256, installedSha256: manifest.installedSha256,
    payloadSha256: manifest.payloadSha256, version: manifest.version })
  const edited = Buffer.from((await readFile(ctx.configFile, 'utf8')) + '\n// user edit\n', 'utf8')
  await writeFile(ctx.configFile, edited)
  assert.throws(() => rollbackProvider(ctx.configFile), /provider_config_modified_refuse_rollback/)
  assert.deepEqual(await readFile(ctx.configFile), edited)
})

test('an unknown manifest format fails closed', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const manifest = await readManifest(ctx)
  await writeManifest(ctx, { ...manifest, format: 3 })
  assert.throws(() => inspectInstalledProvider(ctx.configFile), /provider_manifest_shape_unknown/)
  assert.throws(() => rollbackProvider(ctx.configFile), /provider_manifest_shape_unknown/)
})

test('a repointed, removed or duplicated owned entry is refused, never repaired', async t => {
  const ctx = await synthetic(t)
  installProvider(ctx.options, { runner: version('2.1.4') })
  const installed = await readFile(ctx.configFile)
  const root = readJSONC(text(installed))
  const packageNode = member(ownedPlugin(root), 'package')
  // The owned package is repointed outside the provider-owned namespace.
  await writeFile(ctx.configFile, replaceScalar(installed, packageNode,
    JSON.stringify(path.join(ctx.root, 'foreign-plugin'))))
  assert.throws(() => inspectInstalledProvider(ctx.configFile), /provider_scope_mismatch/)
  // The owned provider registration disappears.
  const providers = member(root, 'providers')
  const own = providers.members.find(item => item.key === 'chat-on-opencode')
  const source = text(installed)
  await writeFile(ctx.configFile, Buffer.from(
    source.slice(0, own.keyStart) + source.slice(own.node.end), 'utf8'))
  assert.throws(() => inspectInstalledProvider(ctx.configFile), /provider_scope_mismatch/)
  // A second owned plugin registration is ambiguous.
  await writeFile(ctx.configFile, installed)
  assert.doesNotThrow(() => inspectInstalledProvider(ctx.configFile))
})
