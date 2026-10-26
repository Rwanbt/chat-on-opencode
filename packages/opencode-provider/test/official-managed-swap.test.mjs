import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installProvider, inspectInstalledProvider } from '../src/official-install.mjs'
import { stageManagedSwap, activateManagedSwap, rollbackManagedSwap, managedSwapStatus } from '../bin/official-managed-swap.mjs'

const bundle = fileURLToPath(new URL('..', import.meta.url))
const quiet = { probe: () => ({ stdout: '0\r\n', status: 0 }) }
const busy = { probe: () => ({ stdout: '2\r\n', status: 0 }) }

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'coo-managed-switch-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const settings = path.join(dir, 'opencode')
  const profile = path.join(dir, 'provider')
  const copy = path.join(dir, 'candidate')
  await Promise.all([mkdir(settings), mkdir(profile), mkdir(copy)])
  const config = path.join(settings, 'opencode.jsonc')
  const original = '{\n// keep Goal and Loop intact\n"plugins":[],"providers":{},"goal":"enabled","loop":"enabled","daemon":true\n}'
  writeFileSync(config, original)
  const cli = path.join(dir, 'opencode-cli.exe')
  const electron = path.join(dir, 'runtime.exe')
  writeFileSync(cli, 'synthetic fake CLI')
  writeFileSync(electron, 'synthetic fake runtime')
  writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const runner = () => ({ status: 0, stdout: 'opencode v2.1.4\n' })
  installProvider({ configFile: config, officialCli: cli, bundleDir: bundle,
    runtimeExecutable: electron, runtimeData: profile, nodeExecutable: process.execPath }, { runner })
  const info = inspectInstalledProvider(config)
  for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(bundle, name), path.join(copy, name), { recursive: true })
  for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
    cpSync(path.join(bundle, name), path.join(copy, name))
  }
  // Same layout but changed bytes so the actual switch can be observed.
  writeFileSync(path.join(copy, 'plugin', 'swap-marker.txt'), 'verified isolated candidate')
  return { dir, config, originalConfig: readFileSync(config), originalPayload: readFileSync(path.join(info.managed, 'plugin', 'index.ts')),
    managed: info.managed, copy, info }
}

test('format-1 plugin can be swapped and rolled back WITHOUT editing user config', { skip: process.platform !== 'win32' }, async t => {
  const v = await fixture(t)
  const prepared = stageManagedSwap(v.config, v.copy)
  assert.equal(prepared.prepared, true)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
  assert.throws(() => activateManagedSwap(v.config, busy), /managed_switch_official_processes_active_or_unknown/)
  assert.equal(existsSync(path.join(v.managed, 'plugin', 'swap-marker.txt')), false)
  const switched = activateManagedSwap(v.config, quiet)
  assert.equal(switched.activated, true)
  assert.equal(switched.reversible, true)
  assert.equal(managedSwapStatus(v.config).activeCandidate, true)
  assert.equal(existsSync(path.join(v.managed, 'plugin', 'swap-marker.txt')), true)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
  inspectInstalledProvider(v.config)
  assert.throws(() => rollbackManagedSwap(v.config, busy), /managed_switch_official_processes_active_or_unknown/)
  const undone = rollbackManagedSwap(v.config, quiet)
  assert.equal(undone.rolledBack, true)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
  assert.deepEqual(readFileSync(path.join(v.managed, 'plugin', 'index.ts')), v.originalPayload)
  assert.equal(existsSync(path.join(v.managed, 'plugin', 'swap-marker.txt')), false)
  inspectInstalledProvider(v.config)
})

test('tampered config or retained old bytes refuse replacement/rollback', async t => {
  const v = await fixture(t)
  stageManagedSwap(v.config, v.copy)
  writeFileSync(v.config, readFileSync(v.config, 'utf8') + ' ')
  assert.throws(() => activateManagedSwap(v.config, quiet), /managed_switch_journal_invalid/)
  // Deliberately leave test-only directory untouched; cleanup is scoped to temp.
})

test('failed second rename leaves journal and old directory restorable', { skip: process.platform !== 'win32' }, async t => {
  const v = await fixture(t)
  stageManagedSwap(v.config, v.copy)
  const next = path.join(path.dirname(v.config), '.chat-on-opencode-directory-next')
  const previous = path.join(path.dirname(v.config), '.chat-on-opencode-directory-previous')
  const { renameSync } = await import('node:fs')
  renameSync(v.managed, previous)
  assert.equal(existsSync(v.managed), false)
  assert.equal(existsSync(next), true)
  const outcome = rollbackManagedSwap(v.config, quiet)
  assert.equal(outcome.rolledBack, true)
  inspectInstalledProvider(v.config)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
})

test('retained original plugin cannot be silently rolled back if its bytes changed', { skip: process.platform !== 'win32' }, async t => {
  const v = await fixture(t)
  stageManagedSwap(v.config, v.copy)
  activateManagedSwap(v.config, quiet)
  const original = path.join(path.dirname(v.config), '.chat-on-opencode-directory-previous', 'plugin', 'index.ts')
  writeFileSync(original, 'tampered old plugin')
  assert.throws(() => rollbackManagedSwap(v.config, quiet), /managed_switch_previous_changed/)
  assert.equal(managedSwapStatus(v.config).activeCandidate, true)
})

test('a second staged upgrade must refuse existing journal without changing the current plugin', async t => {
  const v = await fixture(t)
  stageManagedSwap(v.config, v.copy)
  assert.throws(() => stageManagedSwap(v.config, v.copy), /managed_switch_path_in_use/)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
  inspectInstalledProvider(v.config)
})

test('non-Windows runtime refuses active upgrade even if an injected probe says quiet', {
  skip: process.platform === 'win32',
}, async t => {
  const v = await fixture(t)
  stageManagedSwap(v.config, v.copy)
  assert.throws(() => activateManagedSwap(v.config, quiet), /managed_switch_windows_only/)
  inspectInstalledProvider(v.config)
  assert.deepEqual(readFileSync(v.config), v.originalConfig)
})
