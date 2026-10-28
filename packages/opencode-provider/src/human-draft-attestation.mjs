import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const SHA = /^[a-f0-9]{64}$/
const sha = text => createHash('sha256').update(text).digest('hex')
const required = ['config', 'journal', 'originalA', 'activeB', 'candidateC']

/** Deliberately not an activation API. Does not read drafts or user files. */
export function createDraftAttestationChallenge(snapshot, { now = Date.now(), ttlMs = 120_000 } = {}) {
  if (!Number.isSafeInteger(now) || ttlMs > 120_000 || ttlMs < 1_000) throw Error('attestation_window_invalid')
  if (required.some(key => !SHA.test(snapshot?.[key] ?? ''))) throw Error('attestation_cas_missing')
  const nonce = randomBytes(24).toString('hex')
  return Object.freeze({ nonceHash: sha(nonce), snapshot: Object.freeze({ ...Object.fromEntries(required.map(k => [k, snapshot[k]])) }),
    expiresAt: now + ttlMs, challenge: nonce })
}

/** Caller must obtain a fresh all-composers-reviewed human assertion via explicit UI action.
 * Returns review evidence ONLY; never authorizes or performs a staged transition.
 */
export function verifyHumanDraftAttestation(challenge, { nonce, reviewedAllComposers, draftsSavedOrDiscarded },
  current, { now = Date.now(), processIdle = false } = {}) {
  const fail = reason => ({ status: 'NO_GO', activationAuthorized: false, reason })
  if (!challenge || now > challenge.expiresAt || now < challenge.expiresAt - 120_000) return fail('attestation_expired')
  if (typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce)) return fail('attestation_challenge_invalid')
  if (!timingSafeEqual(Buffer.from(sha(nonce)), Buffer.from(challenge.nonceHash))) return fail('attestation_challenge_invalid')
  if (reviewedAllComposers !== true || draftsSavedOrDiscarded !== true) return fail('attestation_human_review_missing')
  if (processIdle !== true) return fail('attestation_process_not_idle')
  if (required.some(key => !SHA.test(current?.[key] ?? '') || current[key] !== challenge.snapshot[key])) {
    return fail('attestation_cas_changed')
  }
  return { status: 'REVIEW_ATTESTED_ONLY', activationAuthorized: false, reason: 'separate_preflight_and_transition_required', expiresAt: challenge.expiresAt }
}
