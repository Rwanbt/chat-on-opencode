import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runPromotionTransition } from '../src/promotion-transition.mjs'

const snapshotOf = dir => readdirSync(dir).sort().map(name => [name, readFileSync(path.join(dir, name), 'utf8')])

test('the transition refuses while promotionAllowed is false, machine-readably', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'promotion-transition-'))
  writeFileSync(path.join(dir, 'receipt.json'), '{"kept":true}')
  const before = snapshotOf(dir)
  const result = runPromotionTransition({ authorisationDir: dir, receipt: { receiptId: 'x' } })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'promotion_not_allowed')
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.changed, false)
  assert.deepEqual(snapshotOf(dir), before)
})

test('the transition refuses with the same result when no receipt is given', () => {
  const result = runPromotionTransition({})
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'promotion_not_allowed')
  assert.equal(result.changed, false)
})

test('the transition refuses when its gate is injected as anything but true', () => {
  const result = runPromotionTransition({ promotionAllowed: 'true' })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'promotion_not_allowed')
  assert.equal(result.changed, false)
})
