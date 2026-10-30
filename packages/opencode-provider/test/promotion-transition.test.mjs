import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runPromotionTransition, PROMOTION_ALLOWED } from '../src/promotion-transition.mjs'

const snapshotOf = dir => readdirSync(dir).sort().map(name => [name, readFileSync(path.join(dir, name), 'utf8')])

test('the gate is open: the entry point is the authorised transition', () => {
  assert.equal(PROMOTION_ALLOWED, true)
})

test('the transition refuses without a receipt, machine-readably, and changes no byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promotion-transition-'))
  writeFileSync(path.join(dir, 'receipt.json'), '{"kept":true}')
  const before = snapshotOf(dir)
  const result = runPromotionTransition({ authorisationDir: dir, receipt: null })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'authorisation_receipt_invalid')
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.activationAuthorized, false)
  assert.equal(result.changed, false)
  assert.deepEqual(snapshotOf(dir), before)
})

test('the transition refuses with no input at all, and changes nothing', () => {
  const result = runPromotionTransition()
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.changed, false)
})
