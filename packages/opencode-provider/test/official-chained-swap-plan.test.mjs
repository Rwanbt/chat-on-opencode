import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { installProvider, inspectInstalledProvider } from '../src/official-install.mjs'
import { stageManagedSwap, activateManagedSwap, managedSwapStatus } from '../bin/official-managed-swap.mjs'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { planChainedManagedSwap } from '../src/official-chained-swap-plan.mjs'
import { createDraftAttestationChallenge } from '../src/human-draft-attestation.mjs'
import { inspectAttestedDirectGeneration } from '../src/official-direct-generation-evidence.mjs'

test('direct G attestation never authorizes and fails closed on stale evidence', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const probe = () => ({ status: 0, stdout: '0\r\n' })
  prepareChainedGeneration(v.config, v.next, v.expected)
  const baseline = inspectAttestedDirectGeneration(v.config, v.next, v.expected, { probe })
  const challenge = createDraftAttestationChallenge(baseline.snapshot)
  const input = { nonce: challenge.challenge, reviewedAllComposers: true, draftsSavedOrDiscarded: true }
  const reviewed = inspectAttestedDirectGeneration(v.config, v.next, v.expected, { probe, challenge, input })
  assert.equal(reviewed.status, 'REVIEW_ATTESTED_ONLY')
  assert.equal(reviewed.activationAuthorized, false)
  assert.equal(reviewed.promotionAllowed, false)
  assert.equal(inspectAttestedDirectGeneration(v.config, v.next, v.expected, { probe,
    challenge, input: { ...input, nonce: '0'.repeat(48) } }).status, 'NO_GO')
  writeFileSync(v.config, '{}')
  assert.throws(() => inspectAttestedDirectGeneration(v.config, v.next, v.expected, { probe, challenge, input }), /chained_swap|provider_config_modified/)
})
import { prepareChainedGeneration, recoverPreparedChainedGeneration, transitionChainedGeneration, recoverChainedTransition, rollbackChainedTransition, inspectChainedTransitionLock, proveDeadChainedLock } from '../src/official-chained-swap-stage.mjs'
import { parseChainArgs } from '../bin/official-chained-swap-plan.mjs'

const bundle = fileURLToPath(new URL('..', import.meta.url))
const planCli = fileURLToPath(new URL('../bin/official-chained-swap-plan.mjs', import.meta.url))
const quiet = { probe: () => ({ stdout: '0\r\n', status: 0 }) }

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-chain-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['config', 'profile', 'old-candidate', 'next-candidate']) mkdirSync(path.join(root, name))
  const config = path.join(root, 'config', 'opencode.jsonc')
  const original = '{\r\n// keep Goal Loop Daemon\r\n"plugins":["goal","loop"],"providers":{"other":true},"daemon":true\r\n}\r\n'
  writeFileSync(config, original)
  const officialCli = path.join(root, 'cli.exe'), runtime = path.join(root, 'runtime.exe')
  writeFileSync(officialCli, 'synthetic official'); writeFileSync(runtime, 'synthetic runtime')
  writeFileSync(path.join(root, 'profile', 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  installProvider({ configFile: config, officialCli, runtimeExecutable: runtime,
    runtimeData: path.join(root, 'profile'), nodeExecutable: process.execPath, bundleDir: bundle },
  { runner: () => ({ stdout: 'opencode v2.1.4\n', status: 0 }) })
  const create = (dest, marker) => {
    for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(bundle, name), path.join(dest, name), { recursive: true })
    for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) cpSync(path.join(bundle, name), path.join(dest, name))
    writeFileSync(path.join(dest, 'plugin', 'fixture-marker.txt'), marker)
    return dest
  }
  const first = create(path.join(root, 'old-candidate'), 'first switch')
  const next = create(path.join(root, 'next-candidate'), 'next switch')
  const staged = stageManagedSwap(config, first)
  activateManagedSwap(config, quiet)
  assert.deepEqual(managedSwapStatus(config),
    { staged: false, oldRetained: true, activeCandidate: true, configUnchanged: true })
  return { root, config, first, next, staged, expected: candidateDigest(next),
    configBefore: readFileSync(config), activeBefore: readFileSync(path.join(root, 'config', '.chat-on-opencode-managed', 'plugin', 'fixture-marker.txt')),
    journalBefore: readFileSync(path.join(root, 'config', '.chat-on-opencode-directory-switch.json')) }
}

test('active existing switch is classified with all three immutable generations, without writes', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  assert.throws(() => stageManagedSwap(v.config, v.next), /managed_switch_path_in_use/)
  const result = planChainedManagedSwap(v.config, v.next, v.expected)
  assert.equal(result.status, 'NO_GO_CHAINED_SWAP_NOT_ATOMIC')
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.priorRollbackIntact, true)
  assert.equal(result.previousPayloadSha256.length, 64)
  assert.equal(result.activePayloadSha256, v.staged.candidateSha256)
  assert.equal(result.newCandidateSha256, v.expected)
  assert.equal(result.preparedInUserProfile, false)
  assert.equal(result.requiresOfflineTransition, true)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
  assert.deepEqual(readFileSync(path.join(v.root, 'config', '.chat-on-opencode-directory-switch.json')), v.journalBefore)
  assert.deepEqual(readFileSync(path.join(v.root, 'config', '.chat-on-opencode-managed', 'plugin', 'fixture-marker.txt')), v.activeBefore)
  inspectInstalledProvider(v.config)
})

test('hash mismatch, stale source, or modified retained old history fail closed', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  assert.throws(() => planChainedManagedSwap(v.config, v.next, '0'.repeat(64)), /chained_swap_candidate_digest_mismatch/)
  writeFileSync(path.join(v.root, 'config', '.chat-on-opencode-directory-previous', 'plugin', 'index.ts'), 'edited previous')
  assert.throws(() => planChainedManagedSwap(v.config, v.next, v.expected), /chained_swap_previous_payload_mismatch/)
})

test('journal corruption, managed tamper, foreign candidate and partial pending states are rejected', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const journal = path.join(v.root, 'config', '.chat-on-opencode-directory-switch.json')
  writeFileSync(journal, JSON.stringify({format:1,unexpected:'foreign'}))
  assert.throws(() => planChainedManagedSwap(v.config, v.next, v.expected), /chained_swap_journal_invalid/)
  writeFileSync(journal, v.journalBefore)
  writeFileSync(path.join(v.root, 'config', '.chat-on-opencode-directory-next'), 'pending partial')
  assert.throws(() => planChainedManagedSwap(v.config, v.next, v.expected), /chained_swap_pending_or_partial/)
  rmSync(path.join(v.root, 'config', '.chat-on-opencode-directory-next'))
  writeFileSync(path.join(v.root, 'config', '.chat-on-opencode-managed', 'plugin', 'fixture-marker.txt'), 'tampered')
  assert.throws(() => planChainedManagedSwap(v.config, v.next, v.expected), /provider_payload_modified_refuse_delete/)
})

test('symlinked candidate content, mixed-source path and wrong config files are refused', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  symlinkSync(v.first, path.join(v.next, 'src', 'other'), 'junction')
  assert.throws(() => planChainedManagedSwap(v.config, v.next, v.expected), /chained_swap_unsafe_(candidate|path)/)
  assert.equal(existsSync(path.join(v.root, 'config', '.chat-on-opencode-directory-next')), false)
})

test('CLI pins candidate SHA, publishes only safe metadata, refuses any stage or activate request', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const options = ['--config', v.config, '--candidate', v.next, '--expected-sha256', v.expected]
  assert.equal(parseChainArgs(['--inspect', ...options]).get('--expected-sha256'), v.expected)
  const result = spawnSync(process.execPath, [planCli, '--inspect', ...options],
    { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  const safe = JSON.parse(result.stdout)
  assert.equal(safe.promotionAllowed, false)
  assert.equal(safe.newCandidateSha256, v.expected)
  assert.equal(JSON.stringify(safe).includes(v.root), false)
  assert.equal(JSON.stringify(safe).includes('keep Goal'), false)
  const dangerous = spawnSync(process.execPath, [planCli, '--activate', ...options],
    { encoding: 'utf8', timeout: 10_000 })
  assert.equal(dangerous.status, 2)
  assert.equal(dangerous.stdout, '')
  assert.match(dangerous.stderr, /chained_swap_inspection_only/)
})

test('candidate missing OAuth bootstrap and overwritten original backup refuse inspection', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const plugin = path.join(v.next, 'plugin', 'index.ts')
  writeFileSync(plugin, readFileSync(plugin, 'utf8').replace("ctx.options.nativeOAuth !== 'off'", "ctx.options.nativeOAuth === 'preview'"))
  assert.throws(() => planChainedManagedSwap(v.config, v.next, candidateDigest(v.next)),
    /chained_swap_candidate_missing_oauth/)
  const info = inspectInstalledProvider(v.config)
  writeFileSync(info.manifest.backup, 'corrupt original backed-up bytes')
  assert.throws(() => planChainedManagedSwap(v.config, v.next, candidateDigest(v.next)),
    /provider_backup_modified/)
})

test('third generation prepares with retained original and CAS, while interrupted copy cleans only its staging', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const folder = path.dirname(v.config)
  const previous = path.join(folder, '.chat-on-opencode-directory-previous', 'plugin', 'index.ts')
  const original = readFileSync(previous)
  const stage = path.join(folder, '.chat-on-opencode-chain-next')
  assert.throws(() => prepareChainedGeneration(v.config, v.next, v.expected, {
    fault: point => { if (point === 'after_copy') throw Error('injected_crash') },
  }), /injected_crash/)
  assert.equal(existsSync(stage), false)
  assert.deepEqual(readFileSync(previous), original)
  const result = prepareChainedGeneration(v.config, v.next, v.expected)
  assert.equal(result.prepared, true)
  assert.equal(result.promotionAllowed, false)
  assert.equal(candidateDigest(stage), v.expected)
  assert.deepEqual(readFileSync(previous), original)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
  assert.throws(() => prepareChainedGeneration(v.config, v.next, v.expected), /chained_swap_already_prepared|chained_swap_pending_or_partial/)
})

test('third-generation prepare refuses journal CAS drift without publishing a receipt', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const folder = path.dirname(v.config)
  const journal = path.join(folder, '.chat-on-opencode-directory-switch.json')
  const bytes = readFileSync(journal)
  assert.throws(() => prepareChainedGeneration(v.config, v.next, v.expected, {
    fault: point => { if (point === 'before_receipt') writeFileSync(journal, Buffer.concat([bytes, Buffer.from(' ')])) },
  }), /chained_swap_cas_changed|chained_swap_journal_invalid/)
  assert.equal(existsSync(path.join(folder, '.chat-on-opencode-chain-next')), false)
  assert.equal(existsSync(path.join(folder, '.chat-on-opencode-chain-prepare.json')), false)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
})

test('restart recovery validates prepared third generation and refuses tampering', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  prepareChainedGeneration(v.config, v.next, v.expected)
  assert.equal(recoverPreparedChainedGeneration(v.config, v.next, v.expected).recovered, true)
  const stageFile = path.join(path.dirname(v.config), '.chat-on-opencode-chain-next', 'plugin', 'index.ts')
  writeFileSync(stageFile, 'tampered candidate after process exit')
  assert.throws(() => recoverPreparedChainedGeneration(v.config, v.next, v.expected), /chained_swap_prepare_cas_changed/)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
  assert.deepEqual(readFileSync(path.join(path.dirname(v.config), '.chat-on-opencode-directory-switch.json')), v.journalBefore)
})

test('offline three-generation activate, interrupted park recovery and rollback retain original', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const probe = () => ({ stdout: '0\r\n', status: 0 })
  const root = path.dirname(v.config)
  const original = readFileSync(path.join(root, '.chat-on-opencode-directory-previous', 'plugin', 'index.ts'))
  prepareChainedGeneration(v.config, v.next, v.expected)
  assert.throws(() => transitionChainedGeneration(v.config, v.next, v.expected, { probe,
    fault: step => { if (step === 'after_park') throw Error('crash_after_park') },
  }), /crash_after_park/)
  const recovered = recoverChainedTransition(v.config, v.next, v.expected, { probe })
  assert.equal(recovered.activated, true)
  assert.equal(inspectInstalledProvider(v.config).manifest.payloadSha256, v.expected)
  assert.deepEqual(readFileSync(path.join(root, '.chat-on-opencode-directory-previous', 'plugin', 'index.ts')), original)
  assert.throws(() => rollbackChainedTransition(v.config, v.next, v.expected, { probe,
    fault: step => { if (step === 'after_rollback_park') throw Error('crash_during_rollback') },
  }), /crash_during_rollback/)
  assert.equal(rollbackChainedTransition(v.config, v.next, v.expected, { probe }).rolledBack, true)
  inspectInstalledProvider(v.config)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
  assert.deepEqual(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json')), v.journalBefore)
})

test('disposable Windows full V1 to V2 promotion and rollback preserves all three payloads', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const probe = () => ({ stdout: '0\r\n', status: 0 })
  const root = path.dirname(v.config)
  const previous = path.join(root, '.chat-on-opencode-directory-previous')
  const active = path.join(root, '.chat-on-opencode-managed')
  const parked = path.join(root, '.chat-on-opencode-chain-active-previous')
  const staged = path.join(root, '.chat-on-opencode-chain-next')
  const initialJournal = readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))
  const originalSHA = candidateDigest(previous)
  const activeSHA = candidateDigest(active)
  prepareChainedGeneration(v.config, v.next, v.expected)
  assert.equal(transitionChainedGeneration(v.config, v.next, v.expected, { probe }).activated, true)
  assert.equal(inspectInstalledProvider(v.config).manifest.payloadSha256, v.expected)
  assert.equal(candidateDigest(previous), originalSHA)
  assert.equal(candidateDigest(parked), activeSHA)
  assert.equal(candidateDigest(active), v.expected)
  assert.equal(rollbackChainedTransition(v.config, v.next, v.expected, { probe }).rolledBack, true)
  assert.equal(inspectInstalledProvider(v.config).manifest.payloadSha256, activeSHA)
  assert.equal(candidateDigest(previous), originalSHA)
  assert.equal(candidateDigest(active), activeSHA)
  assert.equal(candidateDigest(staged), v.expected)
  assert.deepEqual(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json')), initialJournal)
  assert.deepEqual(readFileSync(v.config), v.configBefore)
})

test('transition lock refuses concurrent activation and preserved journal remains intact', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const root = path.dirname(v.config)
  const lock = path.join(root, '.chat-on-opencode-chain-transition.lock')
  const probe = () => ({ stdout: '0\r\n', status: 0 })
  prepareChainedGeneration(v.config, v.next, v.expected)
  writeFileSync(lock, 'other transaction')
  assert.throws(() => transitionChainedGeneration(v.config, v.next, v.expected, { probe }), /EEXIST/)
  assert.deepEqual(readFileSync(lock, 'utf8'), 'other transaction')
  assert.deepEqual(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json')), v.journalBefore)
})

test('dead lock owner requires exact journal CAS and never authorizes lock stealing', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const root = path.dirname(v.config)
  const lock = path.join(root, '.chat-on-opencode-chain-transition.lock')
  const hash = createHash('sha256').update(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))).digest('hex')
  writeFileSync(lock, JSON.stringify({ pid: 987654, journalSha256: hash }))
  assert.deepEqual(inspectChainedTransitionLock(v.config, { ownerAlive: () => false }), {
    locked: true, recoverable: false, reason: 'dead_owner_manual_reconciliation_required',
  })
  assert.equal(existsSync(lock), true)
  assert.equal(inspectChainedTransitionLock(v.config, { ownerAlive: () => true }).reason, 'owner_alive_or_unknown')
  writeFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'), '{}')
  assert.throws(() => inspectChainedTransitionLock(v.config, { ownerAlive: () => false }), /chained_swap_lock_cas_changed/)
  assert.equal(existsSync(lock), true)
})

test('dead-owner receipt and all three payloads must match; lock never removed', { skip: process.platform !== 'win32' }, t => {
  const v = fixture(t)
  const root = path.dirname(v.config)
  const journal = path.join(root, '.chat-on-opencode-directory-switch.json')
  const lock = path.join(root, '.chat-on-opencode-chain-transition.lock')
  prepareChainedGeneration(v.config, v.next, v.expected)
  writeFileSync(lock, JSON.stringify({ pid: 987654, journalSha256: createHash('sha256').update(readFileSync(journal)).digest('hex') }))
  const dead = { ownerAlive: () => false }
  assert.equal(proveDeadChainedLock(v.config, v.expected, dead).phase, 'prepared')
  assert.equal(existsSync(lock), true)
  assert.throws(() => proveDeadChainedLock(v.config, v.expected, { ownerAlive: () => true }), /owner_unproven/)
  const staged = path.join(root, '.chat-on-opencode-chain-next', 'plugin', 'index.ts')
  writeFileSync(staged, 'corrupted')
  assert.throws(() => proveDeadChainedLock(v.config, v.expected, dead), /generation_unproven/)
  assert.equal(existsSync(lock), true)
})

test('fault at both promote renames and interrupted rollback can be safely replayed', { skip: process.platform !== 'win32' }, t => {
  for (const cut of ['after_park', 'after_activate']) {
    const v = fixture(t)
    const probe = () => ({ stdout: '0\r\n', status: 0 })
    prepareChainedGeneration(v.config, v.next, v.expected)
    assert.throws(() => transitionChainedGeneration(v.config, v.next, v.expected, {
      probe, fault: point => { if (point === cut) throw Error('injected_transition_failure') },
    }), /injected_transition_failure/)
    assert.equal(recoverChainedTransition(v.config, v.next, v.expected, { probe }).activated, true)
    assert.throws(() => rollbackChainedTransition(v.config, v.next, v.expected, {
      probe, fault: point => { if (point === 'after_rollback_park') throw Error('injected_rollback_failure') },
    }), /injected_rollback_failure/)
    assert.equal(rollbackChainedTransition(v.config, v.next, v.expected, { probe }).rolledBack, true)
    assert.deepEqual(readFileSync(path.join(path.dirname(v.config), '.chat-on-opencode-directory-switch.json')), v.journalBefore)
    inspectInstalledProvider(v.config)
  }
})

test('pre-rename fault gates refuse mutation and keep original V1 journal intact', { skip: process.platform !== 'win32' }, t => {
  for (const cut of ['before_park', 'before_activate']) {
    const v = fixture(t)
    const root = path.dirname(v.config)
    const probe = () => ({ stdout: '0\r\n', status: 0 })
    prepareChainedGeneration(v.config, v.next, v.expected)
    assert.throws(() => transitionChainedGeneration(v.config, v.next, v.expected, {
      probe, fault: point => { if (point === cut) throw Error('injected_boundary') },
    }), /injected_boundary/)
    assert.deepEqual(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json')), v.journalBefore)
    assert.deepEqual(readFileSync(v.config), v.configBefore)
    if (cut === 'before_activate') assert.equal(recoverChainedTransition(v.config, v.next, v.expected, { probe }).activated, true)
    else assert.equal(recoverPreparedChainedGeneration(v.config, v.next, v.expected).recovered, true)
  }
})
