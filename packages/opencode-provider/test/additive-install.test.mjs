import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  writeFileSync, existsSync } from 'node:fs'
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
