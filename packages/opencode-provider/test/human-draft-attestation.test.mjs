import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDraftAttestationChallenge, verifyHumanDraftAttestation } from '../src/human-draft-attestation.mjs'

const snapshot = { config: 'a'.repeat(64), journal: 'b'.repeat(64), originalA: 'c'.repeat(64), activeB: 'd'.repeat(64), candidateC: 'e'.repeat(64) }
test('attestation requires fresh explicit all-composer review and never authorizes activation', () => {
  const challenge = createDraftAttestationChallenge(snapshot, { now: 1_000_000 })
  const input = { nonce: challenge.challenge, reviewedAllComposers: true, draftsSavedOrDiscarded: true }
  assert.equal(verifyHumanDraftAttestation(challenge, input, snapshot, { now: 1_000_001, processIdle: true }).status, 'REVIEW_ATTESTED_ONLY')
  assert.equal(verifyHumanDraftAttestation(challenge, input, snapshot, { now: 1_000_001, processIdle: true }).activationAuthorized, false)
  assert.equal(verifyHumanDraftAttestation(challenge, input, snapshot, { now: 1_120_001, processIdle: true }).reason, 'attestation_expired')
  assert.equal(verifyHumanDraftAttestation(challenge, input, snapshot, { now: 1_000_001, processIdle: false }).reason, 'attestation_process_not_idle')
  assert.equal(verifyHumanDraftAttestation(challenge, { ...input, reviewedAllComposers: false }, snapshot, { now: 1_000_001, processIdle: true }).reason, 'attestation_human_review_missing')
  assert.equal(verifyHumanDraftAttestation(challenge, { ...input, nonce: 'f'.repeat(48) }, snapshot, { now: 1_000_001, processIdle: true }).reason, 'attestation_challenge_invalid')
  assert.equal(verifyHumanDraftAttestation(challenge, input, { ...snapshot, journal: 'f'.repeat(64) }, { now: 1_000_001, processIdle: true }).reason, 'attestation_cas_changed')
})
test('incomplete candidate or missing digest refuses challenge', () => {
  assert.throws(() => createDraftAttestationChallenge({ ...snapshot, candidateC: '' }), /attestation_cas_missing/)
})
