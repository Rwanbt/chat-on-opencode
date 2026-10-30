/** A single-use authorisation receipt for a live promotion.
 *
 * This is deliberately a **separate artefact** from `human-draft-attestation.mjs`.
 * That module produces review evidence and its status literally says
 * `REVIEW_ATTESTED_ONLY`; it never authorises a transition. This module produces
 * the authorisation itself - and it still performs nothing: the receipt
 * authorises *a* transition, it never runs one, and it never sets
 * `activationAuthorized`.
 *
 * The trust boundary is the authorisation directory, a reserved path owned by
 * the provider. Only the process that owns that directory can mint a challenge
 * or record a receipt, so a hand-made challenge or receipt is "unknown" rather
 * than accepted. Every claim in that directory is made with an exclusive
 * create, so "at most one receipt per challenge" and "at most one publication
 * per receipt" hold even when two processes race.
 *
 * The receipt is not a signature: its authenticity comes from the recorded
 * bytes in that directory, and the outer `promotionAllowed` gate still refuses
 * every transition until a human authorises it separately (ADR-0003).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SHA = /^[a-f0-9]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The pinned values a publication is authorised against. */
export const AUTHORISATION_SNAPSHOT_FIELDS =
  Object.freeze(['config', 'scope', 'activeGeneration', 'candidateGeneration'])

const MAX_TTL_MS = 120_000
const MIN_TTL_MS = 1_000
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = reason => ({ status: 'NO_GO', activationAuthorized: false, reason })

/** Deterministic JSON: the recorded bytes are compared byte for byte. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}

function snapshotOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw Error('authorisation_snapshot_invalid')
  const picked = {}
  for (const key of AUTHORISATION_SNAPSHOT_FIELDS) {
    if (!SHA.test(snapshot[key] ?? '')) throw Error('authorisation_snapshot_invalid')
    picked[key] = snapshot[key]
  }
  return picked
}

function sameSnapshot(left, right) {
  return AUTHORISATION_SNAPSHOT_FIELDS.every(key => left[key] === right[key])
}

/** The authorisation directory must exist and be a real directory, never a link. */
function authorisationDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw Error('authorisation_directory_invalid')
  }
  const resolved = path.resolve(directory)
  const details = lstatSync(resolved, { throwIfNoEntry: false })
  if (!details || !details.isDirectory() || details.isSymbolicLink()) {
    throw Error('authorisation_directory_invalid')
  }
  return resolved
}

/** Exclusive create: the atomic primitive behind every single-use guarantee. */
function claim(file, content) {
  let handle
  try { handle = openSync(file, 'wx', 0o600) }
  catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try { writeFileSync(handle, content); fsyncSync(handle) } finally { closeSync(handle) }
  return true
}

function recorded(directory, name) {
  try { return readFileSync(path.join(directory, name), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Mint a challenge bound to the pinned snapshot. It expires within the window. */
export function createAuthorisationChallenge(snapshot, { now = Date.now(), ttlMs = MAX_TTL_MS,
  authorisationDir } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) ||
      ttlMs > MAX_TTL_MS || ttlMs < MIN_TTL_MS) throw Error('authorisation_window_invalid')
  const pinned = snapshotOf(snapshot)
  const directory = authorisationDirectory(authorisationDir)
  const nonce = randomBytes(24).toString('hex')
  const challenge = Object.freeze({
    challengeId: randomUUID(), challenge: nonce, nonceHash: sha(nonce),
    snapshot: Object.freeze(pinned), expiresAt: now + ttlMs,
  })
  if (!claim(path.join(directory, challenge.challengeId + '.challenge.json'), canonical(challenge))) {
    throw Error('authorisation_challenge_unwritable')
  }
  return challenge
}

/** Turn a recorded challenge and an explicit human action into a receipt.
 *
 * The receipt authorises a transition; it never performs one and never sets
 * `activationAuthorized`. Every refusal is machine-readable.
 */
export function issueAuthorisationReceipt(challenge, assertions, current, { now = Date.now(),
  processIdle = false, authorisationDir } = {}) {
  if (!challenge || typeof challenge !== 'object') return fail('authorisation_challenge_invalid')
  if (!Number.isSafeInteger(now)) return fail('authorisation_window_invalid')
  if (!UUID.test(challenge.challengeId ?? '')) return fail('authorisation_challenge_invalid')
  if (typeof challenge.challenge !== 'string' || !/^[a-f0-9]{48}$/.test(challenge.challenge) ||
      !/^[a-f0-9]{64}$/.test(challenge.nonceHash ?? '') ||
      !timingSafeEqual(Buffer.from(challenge.nonceHash, 'hex'), Buffer.from(sha(challenge.challenge), 'hex'))) {
    return fail('authorisation_challenge_invalid')
  }
  if (now > challenge.expiresAt) return fail('authorisation_challenge_expired')
  let pinned
  try { pinned = snapshotOf(challenge.snapshot) } catch { return fail('authorisation_challenge_invalid') }
  if (assertions?.reviewedAllComposers !== true || assertions?.draftsSavedOrDiscarded !== true) {
    return fail('authorisation_human_review_missing')
  }
  if (processIdle !== true) return fail('authorisation_process_not_idle')
  let observed
  try { observed = snapshotOf(current) } catch { return fail('authorisation_snapshot_invalid') }
  if (!sameSnapshot(observed, pinned)) return fail('authorisation_snapshot_moved')
  let directory
  try { directory = authorisationDirectory(authorisationDir) } catch { return fail('authorisation_directory_invalid') }
  // Only the challenge the directory recorded can produce a receipt.
  const stored = recorded(directory, challenge.challengeId + '.challenge.json')
  if (stored === null) return fail('authorisation_challenge_unknown')
  if (stored !== canonical(challenge)) return fail('authorisation_challenge_tampered')
  // At most one receipt per challenge, even under a concurrent race.
  if (!claim(path.join(directory, challenge.challengeId + '.issued'), '')) {
    return fail('authorisation_challenge_consumed')
  }
  const receipt = {
    status: 'ACTIVATION_AUTHORISED', authorisationId: randomUUID(),
    challengeId: challenge.challengeId, expiresAt: challenge.expiresAt,
    snapshot: pinned, assertions: { reviewedAllComposers: true, draftsSavedOrDiscarded: true },
    processIdle: true, activationAuthorized: false,
  }
  if (!claim(path.join(directory, receipt.authorisationId + '.receipt.json'), canonical(receipt))) {
    return fail('authorisation_receipt_unwritable')
  }
  return receipt
}

/** Consume a receipt for one publication. It is consumed exactly once.
 *
 * A receipt whose recorded bytes changed, whose snapshot moved, or that was
 * already consumed is refused. A receipt whose snapshot moved is also voided,
 * so it can never be used later.
 */
export function consumeAuthorisationReceipt(receipt, current, { now = Date.now(),
  authorisationDir } = {}) {
  if (!receipt || typeof receipt !== 'object') return fail('authorisation_receipt_invalid')
  if (!Number.isSafeInteger(now)) return fail('authorisation_window_invalid')
  if (receipt.status !== 'ACTIVATION_AUTHORISED' || !UUID.test(receipt.authorisationId ?? '')) {
    return fail('authorisation_receipt_invalid')
  }
  if (now > receipt.expiresAt) return fail('authorisation_receipt_expired')
  let pinned
  try { pinned = snapshotOf(receipt.snapshot) } catch { return fail('authorisation_receipt_invalid') }
  let observed
  try { observed = snapshotOf(current) } catch { return fail('authorisation_snapshot_invalid') }
  let directory
  try { directory = authorisationDirectory(authorisationDir) } catch { return fail('authorisation_directory_invalid') }
  const stored = recorded(directory, receipt.authorisationId + '.receipt.json')
  if (stored === null) return fail('authorisation_receipt_unknown')
  if (stored !== canonical(receipt)) return fail('authorisation_receipt_tampered')
  const consumed = path.join(directory, receipt.authorisationId + '.consumed')
  if (!sameSnapshot(observed, pinned)) {
    // The authorisation is void once the snapshot moved: burn it.
    claim(consumed, '')
    return fail('authorisation_snapshot_moved')
  }
  // At most one publication per receipt, even under a concurrent race.
  if (!claim(consumed, '')) return fail('authorisation_receipt_consumed')
  return { status: 'AUTHORISATION_CONSUMED', authorisationId: receipt.authorisationId,
    expiresAt: receipt.expiresAt }
}
