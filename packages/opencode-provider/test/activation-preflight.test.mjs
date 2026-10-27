import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectActivation } from '../src/context-overlay/activation-preflight.mjs'

const bundle = fileURLToPath(new URL('..', import.meta.url))
const h = bytes => createHash('sha256').update(bytes).digest('hex')
const observed = n => () => ({
  state: 'observed', activeOpenCode: n, port8765: 1, port8766: 0,
})
function fixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-activation-preflight-'))
  const config = path.join(root, 'opencode.jsonc')
  writeFileSync(config, '{ // deliberately not valid JSON: inspection must never parse or rewrite this\n}')
  const dirs = ['Goal', 'Loop', 'Daemon', 'Scheduler']
  const originals = new Map([[config, readFileSync(config)]])
  const plugins = path.join(root, 'plugins')
  mkdirSync(plugins)
  for (const name of dirs) {
    const dir = path.join(plugins, name)
    mkdirSync(dir)
    const filename = path.join(dir, 'index.ts')
    writeFileSync(filename, 'export const userPlugin = ' + JSON.stringify(name) + '\n')
    originals.set(filename, readFileSync(filename))
  }
  const journal = path.join(root, '.chat-on-opencode-directory-switch.json')
  writeFileSync(journal, '{"phase":"active","olderGenerationsRetained":true}')
  originals.set(journal, readFileSync(journal))
  const previous = path.join(root, '.chat-on-opencode-directory-previous')
  mkdirSync(previous)
  const previousFile = path.join(previous, 'old-plugin.mjs')
  writeFileSync(previousFile, 'ORIGINAL OLD GENERATION')
  originals.set(previousFile, readFileSync(previousFile))
  const backups = path.join(root, 'prior-config-backup.jsonc')
  writeFileSync(backups, readFileSync(config))
  originals.set(backups, readFileSync(backups))
  try { return run({ root, config, originals }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}
test('all live processes and prior multi-generation swaps produce NO_GO without modifying a byte', () => {
  fixture(({ config, originals }) => {
    const report = inspectActivation({ config, bundle, observe: observed(7) })
    assert.equal(report.status, 'NO_GO')
    assert.equal(report.activationAuthorized, false)
    assert.equal(report.processAndPorts.port8765, 1)
    assert.equal(report.processAndPorts.port8766, 0)
    assert.equal(report.swap.journal, true)
    assert.equal(report.swap.previousGeneration, true)
    assert.equal(report.overlayState, 'absent')
    assert.equal(report.configSha256, h(originals.get(config)))
    assert.ok(report.reasons.includes('existing_swap_requires_reconciliation'))
    assert.ok(report.reasons.includes('opencode_processes_running'))
    assert.ok(report.reasons.includes('unsent_gui_drafts_not_proven_durable'))
    assert.equal(Object.keys(report.preservedPlugins).length, 4)
    assert.equal(report.preservedTrees.plugins.state, 'hashed')
    assert.equal(report.preservedTrees.plugins.files, 4)
    assert.equal(report.preservedTrees.agents.state, 'absent')
    assert.equal(report.preservedTrees.previousGeneration.files, 1)
    assert.equal(inspectActivation({ config, bundle, observe: observed(7) })
      .preservedTrees.plugins.sha256, report.preservedTrees.plugins.sha256)
    for (const [file, bytes] of originals) assert.deepEqual(readFileSync(file), bytes)
    const serialized = JSON.stringify(report)
    assert.ok(!serialized.includes('ORIGINAL OLD GENERATION'))
    assert.ok(!serialized.includes('deliberately not valid JSON'))
    assert.ok(!serialized.includes(config))
  })
})
test('even apparently idle/fully reachable services can never prove unsent composers safe', () => {
  fixture(({ root, config }) => {
    rmSync(path.join(root, '.chat-on-opencode-directory-switch.json'))
    rmSync(path.join(root, '.chat-on-opencode-directory-previous'), { recursive: true })
    const report = inspectActivation({ config, bundle, observe: observed(0) })
    assert.deepEqual(report.reasons, ['unsent_gui_drafts_not_proven_durable'])
    assert.equal(report.activationAuthorized, false)
    assert.equal(report.status, 'NO_GO')
  })
})
test('process/port probe failure and foreign plugin symlinks are classified as not safe', () => {
  fixture(({ root, config }) => {
    const file = path.join(root, 'plugins', 'Goal', 'index.ts')
    rmSync(file)
    // Symlink creation on CI Windows is privilege-dependent; a directory at the
    // expected file path is equally invalid and exercises the same fail-closed gate.
    if (process.platform === 'win32') mkdirSync(file)
    else symlinkSync(config, file)
    const report = inspectActivation({
      config, bundle, observe: () => ({ state: 'unknown' }),
    })
    assert.ok(report.reasons.includes('process_and_port_state_unknown'))
    assert.ok(report.reasons.includes('foreign_plugin_unreadable'))
    assert.equal(report.preservedPlugins.Goal.state, 'unsafe_or_unreadable')
    assert.equal(report.preservedTrees.plugins.state, 'unsafe_or_unreadable')
    assert.ok(report.reasons.includes('foreign_tree_unreadable'))
    assert.equal(report.activationAuthorized, false)
  })
})
test('read-only CLI exits nonzero and never prints config or foreign plugin content', () => {
  fixture(({ config, originals }) => {
    const cli = fileURLToPath(new URL('../bin/activation-preflight.mjs', import.meta.url))
    const child = spawnSync(process.execPath,
      [cli, '--config', config, '--bundle', bundle], { encoding: 'utf8', timeout: 12000 })
    assert.equal(child.status, 3, child.stderr)
    const report = JSON.parse(child.stdout)
    assert.equal(report.status, 'NO_GO')
    assert.equal(report.activationAuthorized, false)
    assert.equal(child.stdout.includes('userPlugin'), false)
    assert.equal(child.stdout.includes('ORIGINAL OLD GENERATION'), false)
    for (const [filename, bytes] of originals) assert.deepEqual(readFileSync(filename), bytes)
  })
})
