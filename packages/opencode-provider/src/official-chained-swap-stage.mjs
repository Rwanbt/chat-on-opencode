import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { planChainedManagedSwap } from './official-chained-swap-plan.mjs'
import { candidateDigest } from './official-upgrade.mjs'
import { payloadDigest } from './official-install.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const STAGED = '.chat-on-opencode-chain-next'
const JOURNAL = '.chat-on-opencode-chain-prepare.json'
const ACTIVE = '.chat-on-opencode-managed'
const PARKED = '.chat-on-opencode-chain-active-previous'
const LOCK = '.chat-on-opencode-chain-transition.lock'
function locked(root, work) {
  const file = path.join(root, LOCK)
  const fd = openSync(file, 'wx', 0o600)
  try {
    const journal = path.join(root, '.chat-on-opencode-directory-switch.json')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, journalSha256: sha(readFileSync(journal)) }))
    fsyncSync(fd)
    return work()
  }
  finally { closeSync(fd); rmSync(file) }
}
/** Stale locks are intentionally never stolen by another process. This proof is read-only. */
export function inspectChainedTransitionLock(config, { ownerAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
} } = {}) {
  const root = path.dirname(path.resolve(config)), file = path.join(root, LOCK)
  if (!existsSync(file)) return { locked: false, recoverable: false }
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw Error('chained_swap_lock_unsafe')
  let record
  try { record = JSON.parse(readFileSync(file, 'utf8')) } catch { throw Error('chained_swap_lock_invalid') }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !/^[a-f0-9]{64}$/.test(record.journalSha256 ?? '')) throw Error('chained_swap_lock_invalid')
  if (ownerAlive(record.pid)) return { locked: true, recoverable: false, reason: 'owner_alive_or_unknown' }
  if (sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== record.journalSha256) {
    throw Error('chained_swap_lock_cas_changed')
  }
  return { locked: true, recoverable: false, reason: 'dead_owner_manual_reconciliation_required' }
}
/** Proof for explicit stale-lock reconciliation. Never unlinks or takes over the lock. */
export function proveDeadChainedLock(config, digest, { ownerAlive } = {}) {
  const state = inspectChainedTransitionLock(config, { ownerAlive })
  if (!state.locked || state.reason !== 'dead_owner_manual_reconciliation_required') {
    throw Error('chained_swap_lock_owner_unproven')
  }
  const root = path.dirname(path.resolve(config))
  const receipt = JSON.parse(readFileSync(path.join(root, JOURNAL), 'utf8'))
  const v1 = JSON.parse(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'), 'utf8'))
  if (receipt.candidateSha256 !== digest ||
      receipt.journalSha256 !== sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) ||
      receipt.configSha256 !== sha(readFileSync(config)) ||
      receipt.previousPayloadSha256 !== v1.oldPayload ||
      receipt.activePayloadSha256 !== v1.newPayload) throw Error('chained_swap_lock_receipt_cas_changed')
  const old = path.join(root, '.chat-on-opencode-directory-previous')
  const active = path.join(root, ACTIVE), parked = path.join(root, PARKED), staged = path.join(root, STAGED)
  if (payloadDigest(old) !== receipt.previousPayloadSha256) throw Error('chained_swap_lock_original_changed')
  const matches = (dir, expected) => existsSync(dir) && payloadDigest(dir) === expected
  const before = matches(active, receipt.activePayloadSha256) && !existsSync(parked) &&
    matches(staged, digest)
  const parkedBeforeActivation = !existsSync(active) &&
    matches(parked, receipt.activePayloadSha256) && matches(staged, digest)
  const after = matches(active, digest) && matches(parked, receipt.activePayloadSha256) &&
    !existsSync(staged)
  const rollbackInterrupted = !existsSync(active) && matches(parked, receipt.activePayloadSha256) &&
    matches(staged, digest)
  if (!(before || parkedBeforeActivation || after || rollbackInterrupted)) {
    throw Error('chained_swap_lock_generation_unproven')
  }
  return { verified: true, lockRetained: true, originalRetained: true,
    phase: before ? 'prepared' : after ? 'promoted' : 'interrupted_rename',
    mutationAuthorized: false }
}
function syncDirectory(root) {
  // Directory handles are not fsync-capable on every Windows filesystem.
  try { const fd = openSync(root, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
  catch (error) { if (!['EPERM', 'EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error.code)) throw error }
}
function offline(probe = spawnSync) {
  if (process.platform !== 'win32') throw Error('chained_swap_windows_only')
  const result = probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '@([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode-cli") }).Count'],
  { encoding: 'utf8', windowsHide: true, shell: false, timeout: 7000 })
  if (result.status !== 0 || !/^0\s*$/.test(result.stdout ?? '')) throw Error('chained_swap_processes_active_or_unknown')
}

/** Prepare a third immutable generation. Promotion remains deliberately unsupported. */
export function prepareChainedGeneration(config, candidate, expectedDigest, { fault } = {}) {
  const evidence = planChainedManagedSwap(config, candidate, expectedDigest)
  const root = path.dirname(path.resolve(config))
  const stage = path.join(root, STAGED), receipt = path.join(root, JOURNAL)
  if (existsSync(stage) || existsSync(receipt)) throw Error('chained_swap_already_prepared')
  const originalJournal = path.join(root, '.chat-on-opencode-directory-switch.json')
  const journalHash = sha(readFileSync(originalJournal))
  const verify = () => {
    if (sha(readFileSync(originalJournal)) !== journalHash ||
        sha(readFileSync(config)) !== evidence.configSha256 ||
        planChainedManagedSwap(config, candidate, expectedDigest).activePayloadSha256 !== evidence.activePayloadSha256) {
      throw Error('chained_swap_cas_changed')
    }
  }
  let ownsStage = false
  try {
    mkdirSync(stage)
    ownsStage = true
    fault?.('after_mkdir')
    for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(candidate, name), path.join(stage, name), { recursive: true, errorOnExist: true })
    for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      if (existsSync(path.join(candidate, name))) cpSync(path.join(candidate, name), path.join(stage, name), { errorOnExist: true })
    }
    fault?.('after_copy')
    if (candidateDigest(stage) !== expectedDigest) throw Error('chained_swap_staged_digest_mismatch')
    const activeManifest = JSON.parse(readFileSync(path.join(root, ACTIVE, 'install-manifest.json'), 'utf8'))
    const fdManifest = openSync(path.join(stage, 'install-manifest.json'), 'wx', 0o600)
    try {
      writeFileSync(fdManifest, JSON.stringify({ ...activeManifest, payloadSha256: expectedDigest }))
      fsyncSync(fdManifest)
    } finally { closeSync(fdManifest) }
    verify()
    fault?.('before_receipt')
    verify()
    const fd = openSync(receipt, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, configSha256: evidence.configSha256,
        journalSha256: journalHash, previousPayloadSha256: evidence.previousPayloadSha256,
        activePayloadSha256: evidence.activePayloadSha256, candidateSha256: expectedDigest }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    return { prepared: true, promotionAllowed: false, candidateSha256: expectedDigest }
  } catch (error) {
    // Never remove an existing receipt; concurrent ownership must be inspected first.
    if (ownsStage && !existsSync(receipt)) rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

/** Inspect a prepared third generation after process interruption. Never mutate the v1 chain. */
export function recoverPreparedChainedGeneration(config, candidate, expectedDigest) {
  const root = path.dirname(path.resolve(config))
  const stage = path.join(root, STAGED), receipt = path.join(root, JOURNAL)
  if (!existsSync(receipt) || !existsSync(stage)) throw Error('chained_swap_prepare_incomplete')
  if (lstatSync(receipt).isSymbolicLink() || lstatSync(stage).isSymbolicLink() ||
      !lstatSync(stage).isDirectory()) throw Error('chained_swap_prepare_unsafe')
  let record
  try { record = JSON.parse(readFileSync(receipt, 'utf8')) }
  catch { throw Error('chained_swap_prepare_receipt_invalid') }
  const keys = ['version', 'configSha256', 'journalSha256', 'previousPayloadSha256',
    'activePayloadSha256', 'candidateSha256']
  if (!record || Object.keys(record).sort().join() !== keys.sort().join() || record.version !== 1 ||
      record.candidateSha256 !== expectedDigest) throw Error('chained_swap_prepare_receipt_invalid')
  const evidence = planChainedManagedSwap(config, candidate, expectedDigest)
  if (sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== record.journalSha256 ||
      evidence.configSha256 !== record.configSha256 ||
      evidence.previousPayloadSha256 !== record.previousPayloadSha256 ||
      evidence.activePayloadSha256 !== record.activePayloadSha256 ||
      candidateDigest(stage) !== expectedDigest) throw Error('chained_swap_prepare_cas_changed')
  return { recovered: true, candidateSha256: expectedDigest, promotionAllowed: false,
    originalRetained: true, activeRetained: true }
}

/** Read-only direct A/B -> E gate: all retained generations and the prepared
 * receipt must match, and Windows must have no OpenCode processes. An observed
 * safe snapshot is NOT authorization to perform a future mutation. */
export function inspectDirectChainedPromotion(config, candidate, digest, { probe } = {}) {
  offline(probe)
  const root = path.dirname(path.resolve(config))
  if (existsSync(path.join(root, LOCK)) || existsSync(path.join(root, PARKED))) {
    throw Error('chained_swap_direct_transition_occupied')
  }
  const state = recoverPreparedChainedGeneration(config, candidate, digest)
  offline(probe)
  return { status: 'READY_FOR_EXPLICIT_OFFLINE_TRANSITION',
    promotionAllowed: false, activationAuthorized: false,
    candidateSha256: state.candidateSha256,
    originalRetained: state.originalRetained, activeRetained: state.activeRetained,
    requiresHumanReview: true, requiresFreshCASOnTransition: true }
}

/** Offline promotion; the V1 original and its journal remain untouched. */
export function transitionChainedGeneration(config, candidate, digest, { fault, probe } = {}) {
  offline(probe)
  const root = path.dirname(path.resolve(config))
  return locked(root, () => {
  const stage = path.join(root, STAGED), parked = path.join(root, PARKED)
  const active = path.join(root, ACTIVE)
  const evidence = recoverPreparedChainedGeneration(config, candidate, digest)
  if (!evidence.recovered || existsSync(parked)) throw Error('chained_swap_transition_occupied')
  recoverPreparedChainedGeneration(config, candidate, digest)
  offline(probe)
  fault?.('before_park')
  recoverPreparedChainedGeneration(config, candidate, digest)
  renameSync(active, parked)
  syncDirectory(root)
  fault?.('after_park')
  offline(probe)
  const receipt = JSON.parse(readFileSync(path.join(root, JOURNAL), 'utf8'))
  if (sha(readFileSync(config)) !== receipt.configSha256 ||
      sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== receipt.journalSha256 ||
      payloadDigest(parked) !== receipt.activePayloadSha256 ||
      candidateDigest(stage) !== digest) throw Error('chained_swap_transition_cas_changed')
  fault?.('before_activate')
  renameSync(stage, active)
  syncDirectory(root)
  fault?.('after_activate')
  return { activated: true, originalRetained: true, priorActiveRetained: true }
  })
}

/** Reconcile an interrupted transition without overwriting retained V1 history. */
function recoverChainedTransitionLocked(config, candidate, digest, { fault } = {}) {
  const root = path.dirname(path.resolve(config))
  const active = path.join(root, ACTIVE), parked = path.join(root, PARKED), stage = path.join(root, STAGED)
  const receipt = JSON.parse(readFileSync(path.join(root, JOURNAL), 'utf8'))
  const oldJournal = JSON.parse(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'), 'utf8'))
  if (sha(readFileSync(config)) !== receipt.configSha256 ||
      sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== receipt.journalSha256 ||
      receipt.activePayloadSha256 !== oldJournal.newPayload || receipt.previousPayloadSha256 !== oldJournal.oldPayload ||
      receipt.candidateSha256 !== digest) throw Error('chained_swap_transition_cas_changed')
  const previous = path.join(root, '.chat-on-opencode-directory-previous')
  if (payloadDigest(previous) !== receipt.previousPayloadSha256) throw Error('chained_swap_original_changed')
  if (!existsSync(parked)) return recoverPreparedChainedGeneration(config, candidate, digest)
  if (payloadDigest(parked) !== receipt.activePayloadSha256) throw Error('chained_swap_parked_changed')
  if (!existsSync(active) && existsSync(stage)) {
    if (candidateDigest(stage) !== digest) throw Error('chained_swap_staged_digest_mismatch')
    fault?.('before_recover_activate')
    renameSync(stage, active)
    syncDirectory(root)
    fault?.('after_recover_activate')
  }
  // Interrupted rollback: C is staged, B is parked, active path is empty.
  if (!existsSync(active) && !existsSync(stage) && existsSync(parked)) throw Error('chained_swap_transition_incomplete')
  if (!existsSync(active) || payloadDigest(active) !== digest) throw Error('chained_swap_active_changed')
  return { activated: true, originalRetained: true, priorActiveRetained: true }
}
export function recoverChainedTransition(config, candidate, digest, { probe, fault } = {}) {
  offline(probe)
  return locked(path.dirname(path.resolve(config)), () => recoverChainedTransitionLocked(config, candidate, digest, { fault }))
}

export function rollbackChainedTransition(config, candidate, digest, options = {}) {
  offline(options.probe)
  const root = path.dirname(path.resolve(config))
  return locked(root, () => {
  const active = path.join(root, ACTIVE), parked = path.join(root, PARKED), stage = path.join(root, STAGED)
  // Rollback interrupted after C was parked: finish restoring B.
  if (!existsSync(active) && existsSync(stage) && existsSync(parked)) {
    const receipt = JSON.parse(readFileSync(path.join(root, JOURNAL), 'utf8'))
    if (sha(readFileSync(config)) !== receipt.configSha256 ||
        sha(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== receipt.journalSha256 ||
        payloadDigest(path.join(root, '.chat-on-opencode-directory-previous')) !== receipt.previousPayloadSha256 ||
        payloadDigest(parked) !== receipt.activePayloadSha256) throw Error('chained_swap_transition_cas_changed')
    if (candidateDigest(stage) !== digest) throw Error('chained_swap_staged_digest_mismatch')
    renameSync(parked, active)
    syncDirectory(root)
    return { rolledBack: true, originalRetained: true, candidateRetained: true }
  }
  const state = recoverChainedTransitionLocked(config, candidate, digest)
  if (existsSync(stage)) throw Error('chained_swap_rollback_occupied')
  offline(options.probe)
  options.fault?.('before_rollback_park')
  renameSync(active, stage)
  syncDirectory(root)
  options.fault?.('after_rollback_park')
  offline(options.probe)
  if (payloadDigest(parked) !== JSON.parse(readFileSync(path.join(root, JOURNAL), 'utf8')).activePayloadSha256 ||
      candidateDigest(stage) !== digest) throw Error('chained_swap_transition_cas_changed')
  options.fault?.('before_rollback_restore')
  renameSync(parked, active)
  syncDirectory(root)
  return { rolledBack: true, originalRetained: state.originalRetained, candidateRetained: true }
  })
}
