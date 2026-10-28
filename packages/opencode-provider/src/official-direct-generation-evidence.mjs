import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { planChainedManagedSwap } from './official-chained-swap-plan.mjs'
import { recoverPreparedChainedGeneration } from './official-chained-swap-stage.mjs'
import { verifyHumanDraftAttestation } from './human-draft-attestation.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function requireIdle(probe) {
  if (process.platform !== 'win32') throw Error('chained_swap_windows_only')
  const result = probe('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; @([Diagnostics.Process]::GetProcesses() | Where-Object { $_.ProcessName -in @("OpenCode","opencode","opencode-cli","Chat On OpenCode Provider") }).Count'],
  { encoding: 'utf8', windowsHide: true, shell: false, timeout: 7000 })
  if (result.status !== 0 || !/^0\s*$/.test(result.stdout ?? '')) throw Error('chained_swap_processes_active_or_unknown')
}

/** Read-only attestation+prepared CAS checkpoint. This is NOT an activation API.
 * Two rename operations cannot provide atomic visibility or automatic rollback.
 */
export function inspectAttestedDirectGeneration(config, candidate, digest,
  { probe = spawnSync, challenge, input, now = Date.now() } = {}) {
  requireIdle(probe)
  const root = path.dirname(path.resolve(config))
  if (existsSync(path.join(root, '.chat-on-opencode-chain-transition.lock')) ||
      existsSync(path.join(root, '.chat-on-opencode-chain-active-previous'))) {
    throw Error('chained_swap_transition_occupied')
  }
  recoverPreparedChainedGeneration(config, candidate, digest)
  const plan = planChainedManagedSwap(config, candidate, digest)
  const snapshot = {
    config: plan.configSha256,
    journal: hash(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))),
    originalA: plan.previousPayloadSha256,
    activeB: plan.activePayloadSha256,
    candidateC: plan.newCandidateSha256,
  }
  requireIdle(probe)
  recoverPreparedChainedGeneration(config, candidate, digest)
  const check = planChainedManagedSwap(config, candidate, digest)
  if (check.configSha256 !== snapshot.config || check.previousPayloadSha256 !== snapshot.originalA ||
      check.activePayloadSha256 !== snapshot.activeB || check.newCandidateSha256 !== snapshot.candidateC ||
      hash(readFileSync(path.join(root, '.chat-on-opencode-directory-switch.json'))) !== snapshot.journal) {
    throw Error('chained_swap_attestation_cas_changed')
  }
  if (!challenge || !input) return { status: 'NO_GO', promotionAllowed: false,
    activationAuthorized: false, reason: 'attestation_human_review_missing', snapshot }
  const review = verifyHumanDraftAttestation(challenge, input, snapshot, { now, processIdle: true })
  return { ...review, promotionAllowed: false, activationAuthorized: false, snapshot }
}
