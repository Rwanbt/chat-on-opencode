import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, renameSync, symlinkSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledProvider, installProvider } from '../src/official-install.mjs'
import { inspectUpgrade, stageUpgrade, publishVersionedCandidate, inspectPublishedCandidate, recoverStagedUpgrade } from '../src/official-upgrade.mjs'

const rootBundle = fileURLToPath(new URL('..', import.meta.url))
const runner = () => ({ status: 0, stdout: 'opencode v2.1.4\n' })
const sha = data => createHash('sha256').update(data).digest('hex')
const managedFor = file => path.join(path.dirname(file), '.chat-on-opencode-managed')
const jobFor = file => path.join(path.dirname(file), '.chat-on-opencode-upgrade')

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-upgrade-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = path.join(root, 'opencode'), runtimeData = path.join(root, 'runtime-data')
  const bundleDir = path.join(root, 'next-plugin')
  await mkdir(configDir)
  await mkdir(runtimeData)
  await mkdir(bundleDir)
  await writeFile(path.join(runtimeData, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const configFile = path.join(configDir, 'opencode.jsonc')
  await writeFile(configFile, '{\r\n  // preserve byte-for-byte\r\n  "plugins":[{"package":"Goal"},"Loop"],\r\n  "daemon":{"enabled":true},\r\n  "providers":{"other":true}\r\n}\r\n')
  const officialCli = path.join(root, 'opencode.exe'), runtimeExecutable = path.join(root, 'provider.exe')
  await writeFile(officialCli, 'synthetic official executable')
  await writeFile(runtimeExecutable, 'synthetic fork executable')
  const install = { configFile, officialCli, bundleDir: rootBundle, runtimeExecutable,
    runtimeData, nodeExecutable: process.execPath }
  installProvider(install, { runner })
  for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(rootBundle, name), path.join(bundleDir, name), { recursive: true })
  for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
    cpSync(path.join(rootBundle, name), path.join(bundleDir, name))
  }
  await writeFile(path.join(bundleDir, 'README.md'), '\nSynthetic next release without account data.\n')
  return { root, configFile, bundleDir, officialCli, options: { configFile, officialCli, bundleDir } }
}
async function bytes(folder) {
  const entries = []
  const walk = async (dir, prefix = '') => {
    for (const name of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + name.name, file = path.join(dir, name.name)
      if (name.isDirectory()) { entries.push(relative + '/'); await walk(file, relative + '/') }
      else { assert.ok(name.isFile()); entries.push(relative + ':' + sha(await readFile(file))) }
    }
  }
  await walk(folder)
  return entries
}
async function snapshot(configFile) {
  const active = inspectInstalledProvider(configFile)
  return { config: await readFile(configFile), backup: await readFile(active.manifest.backup),
    managed: await bytes(active.managed), manifest: await readFile(path.join(active.managed, 'install-manifest.json')) }
}
const unchanged = (before, after) => {
  assert.deepEqual(after.config, before.config)
  assert.deepEqual(after.backup, before.backup)
  assert.deepEqual(after.manifest, before.manifest)
  assert.deepEqual(after.managed, before.managed)
}

test('read-only preflight requires exact original format-1 hashes, version and owned config entry', async t => {
  const c = await setup(t)
  const prior = await snapshot(c.configFile)
  const plan = inspectUpgrade(c.options, { runner })
  assert.equal(plan.status, 'NO_GO_ATOMIC_PROMOTION_UNPROVEN')
  assert.equal(plan.cliVersion, '2.1.4')
  assert.equal(plan.candidateVersion, '0.1.0')
  assert.equal((await readdir(path.dirname(c.configFile))).includes('.chat-on-opencode-upgrade'), false)
  unchanged(prior, await snapshot(c.configFile))
  assert.throws(() => inspectUpgrade(c.options, { runner: () => ({ status: 0, stdout: 'opencode v2.2.0' }) }),
    /upgrade_official_cli_unqualified/)
  assert.throws(() => inspectUpgrade({ ...c.options, bundleDir: managedFor(c.configFile) }, { runner }),
    /upgrade_bundle_overlaps_managed/)
})

test('staged update validates exact copied digest and recovery retains original bytes', async t => {
  const c = await setup(t), prior = await snapshot(c.configFile)
  const result = stageUpgrade(c.options, { runner })
  assert.equal(result.readyForOfflineReview, true)
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.status, 'NO_GO_ATOMIC_PROMOTION_UNPROVEN')
  assert.equal((await readdir(jobFor(c.configFile))).includes('validated.json'), true)
  assert.throws(() => stageUpgrade(c.options, { runner }), /upgrade_pending_recovery_required/)
  unchanged(prior, await snapshot(c.configFile))
  assert.deepEqual(recoverStagedUpgrade(c.configFile), {
    recovered: true, originalInstallUnchanged: true, promotionAllowed: false,
  })
  assert.equal((await readdir(path.dirname(c.configFile))).includes('.chat-on-opencode-upgrade'), false)
  unchanged(prior, await snapshot(c.configFile))
  assert.throws(() => recoverStagedUpgrade(c.configFile), /upgrade_unsafe_path/)
})

test('simulated process crash at every persisted/copy stage always restores exact originals', async t => {
  const c = await setup(t), prior = await snapshot(c.configFile)
  for (const point of ['reservation_created', 'journal_durable', 'candidate_created', 'copied_bin', 'copied_plugin',
    'copied_src', 'candidate_copied', 'validated_durable']) {
    assert.throws(() => stageUpgrade(c.options, { runner, checkpoint(at) {
      if (at === point) throw new Error('synthetic_crash_' + point)
    } }), /synthetic_crash_/)
    assert.throws(() => inspectUpgrade(c.options, { runner }), /upgrade_pending_recovery_required/)
    unchanged(prior, await snapshot(c.configFile))
    assert.equal(recoverStagedUpgrade(c.configFile).originalInstallUnchanged, true)
    unchanged(prior, await snapshot(c.configFile))
  }
})

test('tampered installed config, backup, payload and changed staging block recovery safely', async t => {
  const c = await setup(t)
  const old = await snapshot(c.configFile)
  stageUpgrade(c.options, { runner })
  await writeFile(c.configFile, Buffer.concat([old.config, Buffer.from('\n// outside user edit')]))
  assert.throws(() => recoverStagedUpgrade(c.configFile), /provider_config_modified_refuse_rollback/)
  await writeFile(c.configFile, old.config)
  const active = inspectInstalledProvider(c.configFile)
  await writeFile(active.manifest.backup, 'bad backup')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /provider_backup_modified/)
  await writeFile(active.manifest.backup, old.backup)
  const plugin = path.join(active.managed, 'src', 'server.mjs')
  const original = await readFile(plugin)
  await writeFile(plugin, 'changed payload')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /provider_payload_modified_refuse_delete/)
  await writeFile(plugin, original)
  const candidate = path.join(jobFor(c.configFile), 'candidate', 'src', 'server.mjs')
  await writeFile(candidate, 'tampered stage')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /upgrade_recovery_staged_modified/)
  assert.deepEqual((await snapshot(c.configFile)).config, old.config)
  // The explicit recovery owner must refuse tampered staging rather than deleting unknown data.
  assert.equal((await readdir(path.dirname(c.configFile))).includes('.chat-on-opencode-upgrade'), true)
})

test('symlink/junction on source, managed child or candidate refuses read/delete', async t => {
  const c = await setup(t)
  const alias = path.join(c.root, 'linked-bundle')
  symlinkSync(c.bundleDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => inspectUpgrade({ ...c.options, bundleDir: alias }, { runner }), /upgrade_unsafe_path/)
  stageUpgrade(c.options, { runner })
  const stagedReadme = path.join(jobFor(c.configFile), 'candidate', 'README.md')
  await rm(stagedReadme)
  symlinkSync(path.join(c.bundleDir, 'README.md'), stagedReadme, 'file')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /upgrade_unsafe_entry|upgrade_unsafe_path/)
  await rm(stagedReadme)
  cpSync(path.join(c.bundleDir, 'README.md'), stagedReadme)
  assert.equal(recoverStagedUpgrade(c.configFile).originalInstallUnchanged, true)
})

test('CLI recovery reports no private paths; altered journal fails closed', async t => {
  const c = await setup(t)
  stageUpgrade(c.options, { runner })
  const cli = fileURLToPath(new URL('../bin/official-upgrade.mjs', import.meta.url))
  const invoke = args => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000,
  })
  const invalid = invoke(['--recover', '--config', c.configFile, '--unknown'])
  assert.equal(invalid.status, 2)
  assert.equal(invalid.stderr.includes(c.root), false)
  const journal = path.join(jobFor(c.configFile), 'journal.json')
  const prior = await readFile(journal)
  await writeFile(journal, JSON.stringify({ format: 1, config: c.configFile, backup: 'wrong' }))
  assert.equal(invoke(['--recover', '--config', c.configFile]).status, 2)
  assert.equal((await readdir(jobFor(c.configFile))).includes('candidate'), true)
  await writeFile(journal, prior)
  const publication = invoke(['--publish-candidate', '--config', c.configFile])
  assert.equal(publication.status, 0, publication.stderr)
  assert.equal(JSON.parse(publication.stdout).promotionAllowed, false)
  assert.equal(publication.stdout.includes(c.root), false)
  const ok = invoke(['--recover', '--config', c.configFile])
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(ok.stdout), {
    recovered: true, originalInstallUnchanged: true, promotionAllowed: false,
  })
  assert.equal(ok.stdout.includes(c.root), false)
})

test('config drift after staging refuses immutable publication without overwriting edits', async t => {
  const c = await setup(t)
  stageUpgrade(c.options, { runner })
  const changed = Buffer.concat([await readFile(c.configFile), Buffer.from('\n// external edit')])
  await writeFile(c.configFile, changed)
  assert.throws(() => publishVersionedCandidate(c.configFile), /provider_config_modified_refuse_rollback/)
  assert.deepEqual(await readFile(c.configFile), changed)
  assert.ok((await readdir(jobFor(c.configFile))).includes('candidate'))
})

test('versioned candidate publication keeps exact config, original managed and backup bytes', async t => {
  const c = await setup(t), prior = await snapshot(c.configFile)
  const { stagedDigest } = stageUpgrade(c.options, { runner })
  const result = publishVersionedCandidate(c.configFile)
  assert.deepEqual(result, { publishedForOfflineReview: true, promotionAllowed: false,
    status: 'NO_GO_CONFIG_CAS_UNPROVEN', publishedSha256: stagedDigest })
  const target = path.join(path.dirname(c.configFile), '.chat-on-opencode-version-' + stagedDigest)
  assert.ok((await readdir(target)).includes('plugin'))
  assert.ok((await readdir(target)).includes('src'))
  unchanged(prior, await snapshot(c.configFile))
  assert.throws(() => publishVersionedCandidate(c.configFile), /upgrade_candidate_not_ready_to_publish/)
  assert.throws(() => stageUpgrade(c.options, { runner }), /upgrade_pending_recovery_required/)
  assert.equal(recoverStagedUpgrade(c.configFile).originalInstallUnchanged, true)
  unchanged(prior, await snapshot(c.configFile))
  assert.equal((await readdir(path.dirname(c.configFile))).includes(path.basename(target)), true)
  assert.equal((await readdir(path.dirname(c.configFile))).includes('.chat-on-opencode-upgrade'), false)
  assert.deepEqual(inspectPublishedCandidate(c.configFile, stagedDigest), {
    publishedSha256: stagedDigest, candidateAvailable: true, promotionAllowed: false,
  })
  assert.throws(() => inspectPublishedCandidate(c.configFile, '../escape'), /upgrade_published_digest_invalid/)
})

test('crash at publication boundary recovers only owned staging and never changes old config', async t => {
  for (const point of ['publication_intent_durable', 'before_publish_rename', 'published_directory', 'published_verified']) {
    const c = await setup(t), prior = await snapshot(c.configFile)
    const { stagedDigest } = stageUpgrade(c.options, { runner })
    assert.throws(() => publishVersionedCandidate(c.configFile, { checkpoint(at) {
      if (at === point) throw new Error('synthetic_crash_' + point)
    } }), /synthetic_crash_/)
    unchanged(prior, await snapshot(c.configFile))
    assert.equal(recoverStagedUpgrade(c.configFile).originalInstallUnchanged, true)
    unchanged(prior, await snapshot(c.configFile))
    const target = path.join(path.dirname(c.configFile), '.chat-on-opencode-version-' + stagedDigest)
    assert.equal((await readdir(path.dirname(c.configFile))).includes(path.basename(target)),
      ['published_directory', 'published_verified'].includes(point))
  }
})

test('published candidate mutation and symlink block recovery; never delete versioned data', async t => {
  const c = await setup(t), old = await snapshot(c.configFile)
  const { stagedDigest } = stageUpgrade(c.options, { runner })
  publishVersionedCandidate(c.configFile)
  const target = path.join(path.dirname(c.configFile), '.chat-on-opencode-version-' + stagedDigest)
  const artifact = path.join(target, 'plugin', 'index.ts')
  const original = await readFile(artifact)
  await writeFile(artifact, 'corrupted')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /upgrade_published_candidate_invalid/)
  assert.throws(() => inspectPublishedCandidate(c.configFile, stagedDigest), /upgrade_published_candidate_invalid/)
  unchanged(old, await snapshot(c.configFile))
  await writeFile(artifact, original)
  const link = path.join(target, 'linked')
  symlinkSync(c.bundleDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => recoverStagedUpgrade(c.configFile), /upgrade_unsafe_entry|upgrade_unsafe_path/)
  await rm(link)
  assert.equal(recoverStagedUpgrade(c.configFile).originalInstallUnchanged, true)
  assert.ok((await readdir(target)).includes('plugin'))
})

test('native rename is not a CAS: stale hash can overwrite intervening config edits', async t => {
  const c = await setup(t)
  const folder = path.join(c.root, 'rename-proof')
  await mkdir(folder)
  const active = path.join(folder, 'opencode.jsonc'), incoming = path.join(folder, 'new.jsonc')
  await writeFile(active, '{"goal":true}')
  const stale = sha(await readFile(active))
  await writeFile(incoming, '{"new":true}')
  await writeFile(active, '{"goal":true,"externalConcurrentEdit":true}')
  assert.notEqual(sha(await readFile(active)), stale)
  // This demonstrates why an unconditional fs.rename cannot be exposed as --promote.
  renameSync(incoming, active)
  assert.equal((await readFile(active, 'utf8')), '{"new":true}')
})
