import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  writeFileSync, existsSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { additiveSourceDigest, additiveStatus, installAdditive, removeAdditive } from '../src/context-overlay/additive-install.mjs'

const bundle = fileURLToPath(new URL('..', import.meta.url))
const sourceSha = additiveSourceDigest(bundle)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const idle = () => {}
const rootFor = fn => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-additive-test-'))
  const config = path.join(root, 'opencode.jsonc')
  writeFileSync(config, '{ "plugins": [], "Goal": true, "Loop": true }')
  const original = readFileSync(config)
  try { return fn({ root, config, sha: hash(original), original }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

test('pinned additive pair installs, verifies and removes without mutating JSONC', () => {
  rootFor(({ root, config, sha, original }) => {
    assert.deepEqual(additiveStatus(config, bundle), { state: 'absent' })
    assert.deepEqual(installAdditive(config, bundle, sha, sourceSha, { idle }),
      { installed: true, configUnchanged: true, sourceSha256: sourceSha })
    assert.equal(additiveStatus(config, bundle).state, 'installed')
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(path.join(root, 'plugins', 'chat-on-opencode-context-overlay', 'index.ts')), true)
    assert.equal(existsSync(path.join(root, 'agents', 'chat-on-opencode-text.md')), true)
    assert.throws(() => installAdditive(config, bundle, sha, sourceSha, { idle }), /additive_existing_install_or_journal/)
    assert.equal(removeAdditive(config, bundle, { idle }).removed, true)
    assert.equal(additiveStatus(config, bundle).state, 'absent')
    assert.deepEqual(readFileSync(config), original)
  })
})

test('never mutates profile when a process is active, digest differs or name collides', () => {
  rootFor(({ root, config, sha, original }) => {
    assert.throws(() => installAdditive(config, bundle, sha, sourceSha, {
      idle: () => { throw Error('process_busy') },
    }), /process_busy/)
    assert.throws(() => installAdditive(config, bundle, sha, '0'.repeat(64), { idle }), /additive_pin_mismatch/)
    mkdirSync(path.join(root, 'agents'))
    const reserved = path.join(root, 'agents', 'chat-on-opencode-text.md')
    writeFileSync(reserved, 'PERSONAL AGENT')
    assert.throws(() => installAdditive(config, bundle, sha, sourceSha, { idle }), /additive_existing_install_or_journal/)
    assert.equal(readFileSync(reserved, 'utf8'), 'PERSONAL AGENT')
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(path.join(root, '.chat-on-opencode-context-overlay.pending.json')), false)
  })
})

test('recovery refuses tampered content and never removes a modified user file', () => {
  rootFor(({ root, config, sha }) => {
    installAdditive(config, bundle, sha, sourceSha, { idle })
    const agent = path.join(root, 'agents', 'chat-on-opencode-text.md')
    writeFileSync(agent, 'USER MODIFICATION')
    assert.throws(() => removeAdditive(config, bundle, { idle }), /additive_agent_modified/)
    assert.equal(readFileSync(agent, 'utf8'), 'USER MODIFICATION')
    assert.equal(existsSync(path.join(root, 'plugins', 'chat-on-opencode-context-overlay', 'index.ts')), true)
  })
})

test('crash before receipt publication leaves detectable journal and reversible owned pair', () => {
  rootFor(({ root, config, sha }) => {
    installAdditive(config, bundle, sha, sourceSha, { idle })
    const receipt = path.join(root, '.chat-on-opencode-context-overlay.receipt.json')
    const journal = path.join(root, '.chat-on-opencode-context-overlay.pending.json')
    renameSync(receipt, journal)
    assert.deepEqual(additiveStatus(config, bundle), { state: 'pending_recovery' })
    assert.deepEqual(removeAdditive(config, bundle, { idle }), {
      removed: true, recoveredPending: true, configUnchanged: true,
    })
    assert.equal(additiveStatus(config, bundle).state, 'absent')
  })
})

test('only the exact pinned configuration may remove an installed pair', () => {
  rootFor(({ config, sha }) => {
    installAdditive(config, bundle, sha, sourceSha, { idle })
    writeFileSync(config, '{}')
    assert.throws(() => removeAdditive(config, bundle, { idle }), /additive_source_or_configuration_changed/)
  })
})

test('race: OpenCode starts during staging, publishing is refused and pending files recover', () => {
  rootFor(({ root, config, sha, original }) => {
    let probes = 0
    assert.throws(() => installAdditive(config, bundle, sha, sourceSha, {
      idle: () => { if (++probes === 2) throw Error('late_opencode_started') },
    }), /late_opencode_started/)
    assert.equal(probes, 2)
    assert.equal(additiveStatus(config, bundle).state, 'pending_recovery')
    assert.equal(existsSync(path.join(root, 'agents', 'chat-on-opencode-text.md')), false)
    assert.equal(existsSync(path.join(root, 'plugins', 'chat-on-opencode-context-overlay')), false)
    assert.equal(removeAdditive(config, bundle, { idle }).recoveredPending, true)
    assert.equal(additiveStatus(config, bundle).state, 'absent')
    assert.deepEqual(readFileSync(config), original)
  })
})

test('half-staged journal recovery does not require omitted files to exist', () => {
  rootFor(({ root, config, sha }) => {
    installAdditive(config, bundle, sha, sourceSha, { idle })
    const receipt = path.join(root, '.chat-on-opencode-context-overlay.receipt.json')
    const record = JSON.parse(readFileSync(receipt, 'utf8'))
    const journal = path.join(root, '.chat-on-opencode-context-overlay.pending.json')
    renameSync(receipt, journal)
    const from = path.join(root, 'plugins', 'chat-on-opencode-context-overlay')
    const staged = path.join(root, 'plugins',
      '.chat-on-opencode-context-overlay.' + record.nonce + '.stage')
    renameSync(from, staged)
    unlinkSync(path.join(staged, 'overlay.mjs'))
    assert.equal(removeAdditive(config, bundle, { idle }).recoveredPending, true)
    assert.equal(additiveStatus(config, bundle).state, 'absent')
  })
})

test('CLI parses digest and status independently of live Windows mutation', () => {
  rootFor(({ config }) => {
    const cli = fileURLToPath(new URL('../bin/additive-context.mjs', import.meta.url))
    const digest = spawnSync(process.execPath, [cli, '--digest', '--bundle', bundle], {
      encoding: 'utf8', timeout: 5000 })
    assert.equal(digest.status, 0, digest.stderr)
    assert.equal(JSON.parse(digest.stdout).sourceSha256, sourceSha)
    const status = spawnSync(process.execPath, [cli, '--status', '--config', config, '--bundle', bundle], {
      encoding: 'utf8', timeout: 5000 })
    assert.equal(status.status, 0, status.stderr)
    assert.equal(JSON.parse(status.stdout).state, 'absent')
    const invalid = spawnSync(process.execPath, [cli, '--digest', '--status'], {
      encoding: 'utf8', timeout: 5000 })
    assert.notEqual(invalid.status, 0)
  })
})

test('interrupted removal recovers verified retired plugin with a missing file', () => {
  rootFor(({ root, config, sha, original }) => {
    installAdditive(config, bundle, sha, sourceSha, { idle })
    const receipt = JSON.parse(readFileSync(
      path.join(root, '.chat-on-opencode-context-overlay.receipt.json'), 'utf8'))
    const plugin = path.join(root, 'plugins', 'chat-on-opencode-context-overlay')
    const retired = path.join(root, 'plugins',
      '.chat-on-opencode-context-overlay.' + receipt.nonce + '.retired')
    renameSync(plugin, retired)
    unlinkSync(path.join(retired, 'overlay.mjs')) // crash midway through recursive removal
    assert.equal(additiveStatus(config, bundle).state, 'partial_removal')
    assert.equal(removeAdditive(config, bundle, { idle }).removed, true)
    assert.equal(additiveStatus(config, bundle).state, 'absent')
    assert.deepEqual(readFileSync(config), original)
  })
})
