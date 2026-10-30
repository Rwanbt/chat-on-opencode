import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  createAuthorisationChallenge, issueAuthorisationReceipt, consumeAuthorisationReceipt,
} from '../src/promotion-authorisation.mjs'

const sha = seed => Buffer.alloc(32, seed.charCodeAt(0)).toString('hex')

const SNAPSHOT = Object.freeze({
  config: sha('c'), scope: sha('s'), activeGeneration: sha('a'), candidateGeneration: sha('d'),
})

const HUMAN = Object.freeze({ reviewedAllComposers: true, draftsSavedOrDiscarded: true })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-authorisation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const authorisationDir = path.join(root, 'authorisations')
  await mkdir(authorisationDir)
  return { root, authorisationDir }
}

const receiptsIn = async dir => (await readdir(dir)).filter(name => name.endsWith('.receipt.json'))

function challenge(snapshot, { now = 1_000_000, ttlMs = 120_000, authorisationDir } = {}) {
  return createAuthorisationChallenge(snapshot, { now, ttlMs, authorisationDir })
}

function issue(theChallenge, { current = SNAPSHOT, now = 1_000_000, processIdle = true,
  human = HUMAN, authorisationDir } = {}) {
  return issueAuthorisationReceipt(theChallenge, human, current,
    { now, processIdle, authorisationDir })
}

test('a challenge is fresh, bound to the pinned snapshot, and expires within 120 seconds', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  assert.equal(minted.expiresAt, 1_120_000)
  assert.deepEqual(minted.snapshot, SNAPSHOT)
  assert.equal(typeof minted.challenge, 'string')
  assert.equal(typeof minted.challengeId, 'string')
  // The challenge must not outlive the contract window.
  assert.throws(() => challenge(SNAPSHOT, { ttlMs: 120_001, authorisationDir }),
    /authorisation_window_invalid/)
  assert.throws(() => challenge(SNAPSHOT, { ttlMs: 999, authorisationDir }),
    /authorisation_window_invalid/)
  // Every pinned value must be a digest, or the binding is meaningless.
  assert.throws(() => challenge({ ...SNAPSHOT, config: 'not-a-digest' }, { authorisationDir }),
    /authorisation_snapshot_invalid/)
  assert.throws(() => challenge({ ...SNAPSHOT, candidateGeneration: undefined }, { authorisationDir }),
    /authorisation_snapshot_invalid/)
  // The challenge is recorded: only the issuing process can mint one.
  const files = await readdir(authorisationDir)
  assert.equal(files.length, 1)
  assert.ok(files[0].endsWith('.challenge.json'))
  const recorded = JSON.parse(await readFile(path.join(authorisationDir, files[0]), 'utf8'))
  assert.equal(recorded.challengeId, minted.challengeId)
  assert.deepEqual(recorded.snapshot, SNAPSHOT)
  // A second challenge for the same snapshot is a different, fresh challenge.
  const other = challenge(SNAPSHOT, { authorisationDir })
  assert.notEqual(other.challengeId, minted.challengeId)
})

test('an expired challenge refuses and yields no receipt', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const refused = issue(minted, { now: minted.expiresAt + 1, authorisationDir })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.activationAuthorized, false)
  assert.equal(refused.reason, 'authorisation_challenge_expired')
  assert.deepEqual(await receiptsIn(authorisationDir), [])
})

test('a live process refuses', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const refused = issue(minted, { processIdle: false, authorisationDir })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.reason, 'authorisation_process_not_idle')
  assert.deepEqual(await receiptsIn(authorisationDir), [])
})

test('a missing human review refuses', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const refused = issue(minted, {
    human: { reviewedAllComposers: false, draftsSavedOrDiscarded: true }, authorisationDir,
  })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.reason, 'authorisation_human_review_missing')
  assert.deepEqual(await receiptsIn(authorisationDir), [])
})

test('a hand-made challenge is unknown and yields no receipt', async t => {
  const { authorisationDir } = await fixture(t)
  // A well-formed challenge the directory never recorded was never minted here.
  const forged = { ...challenge(SNAPSHOT, { authorisationDir }),
    challengeId: '00000000-0000-4000-8000-000000000000' }
  const refused = issue(forged, { authorisationDir })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.reason, 'authorisation_challenge_unknown')
  // A malformed challenge is refused even earlier.
  const malformed = issue({ challengeId: 'forged' }, { authorisationDir })
  assert.equal(malformed.status, 'NO_GO')
  assert.equal(malformed.reason, 'authorisation_challenge_invalid')
  assert.deepEqual(await receiptsIn(authorisationDir), [])
})

test('a moved snapshot refuses, at issuance and at consumption', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const moved = { ...SNAPSHOT, scope: sha('x') }
  const refused = issue(minted, { current: moved, authorisationDir })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.reason, 'authorisation_snapshot_moved')
  const receipt = issue(minted, { authorisationDir })
  assert.equal(receipt.status, 'ACTIVATION_AUTHORISED')
  const late = consumeAuthorisationReceipt(receipt, moved, { now: 1_000_001, authorisationDir })
  assert.equal(late.status, 'NO_GO')
  assert.equal(late.reason, 'authorisation_snapshot_moved')
})

test('a receipt authorises a transition and never performs one', async t => {
  const { root, authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const receipt = issue(minted, { authorisationDir })
  assert.equal(receipt.status, 'ACTIVATION_AUTHORISED')
  assert.equal(receipt.activationAuthorized, false)
  assert.equal(receipt.authorisationId.length > 0, true)
  assert.equal(receipt.expiresAt, minted.expiresAt)
  assert.deepEqual(receipt.snapshot, SNAPSHOT)
  // The receipt authorises; it does not promote, and it never claims promotion.
  assert.equal(receipt.promotionAllowed, undefined)
  assert.equal(receipt.published, undefined)
  // Nothing outside the authorisation directory was touched.
  assert.deepEqual(await readdir(root), ['authorisations'])
})

test('a receipt cannot be replayed for a second publication', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const receipt = issue(minted, { authorisationDir })
  const first = consumeAuthorisationReceipt(receipt, SNAPSHOT, { now: 1_000_001, authorisationDir })
  assert.equal(first.status, 'AUTHORISATION_CONSUMED')
  assert.equal(first.authorisationId, receipt.authorisationId)
  const second = consumeAuthorisationReceipt(receipt, SNAPSHOT, { now: 1_000_002, authorisationDir })
  assert.equal(second.status, 'NO_GO')
  assert.equal(second.activationAuthorized, false)
  assert.equal(second.reason, 'authorisation_receipt_consumed')
})

test('one challenge yields at most one receipt', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const receipt = issue(minted, { authorisationDir })
  assert.equal(receipt.status, 'ACTIVATION_AUTHORISED')
  const replay = issue(minted, { now: 1_000_001, authorisationDir })
  assert.equal(replay.status, 'NO_GO')
  assert.equal(replay.reason, 'authorisation_challenge_consumed')
})

test('an unknown or tampered receipt refuses', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { authorisationDir })
  const receipt = issue(minted, { authorisationDir })
  // A receipt that the issuing directory never wrote is not an authorisation.
  const forged = { ...receipt, authorisationId: '00000000-0000-4000-8000-000000000000' }
  const unknown = consumeAuthorisationReceipt(forged, SNAPSHOT, { now: 1_000_001, authorisationDir })
  assert.equal(unknown.status, 'NO_GO')
  assert.equal(unknown.reason, 'authorisation_receipt_unknown')
  // A receipt whose recorded bytes were edited refuses.
  const file = path.join(authorisationDir, receipt.authorisationId + '.receipt.json')
  const stored = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...stored, snapshot: { ...stored.snapshot, scope: sha('x') } }))
  const tampered = consumeAuthorisationReceipt(receipt, SNAPSHOT, { now: 1_000_001, authorisationDir })
  assert.equal(tampered.status, 'NO_GO')
  assert.equal(tampered.reason, 'authorisation_receipt_tampered')
})

test('an expired receipt refuses at consumption', async t => {
  const { authorisationDir } = await fixture(t)
  const minted = challenge(SNAPSHOT, { ttlMs: 1_000, authorisationDir })
  const receipt = issue(minted, { authorisationDir })
  const refused = consumeAuthorisationReceipt(receipt, SNAPSHOT,
    { now: minted.expiresAt + 1, authorisationDir })
  assert.equal(refused.status, 'NO_GO')
  assert.equal(refused.reason, 'authorisation_receipt_expired')
})
