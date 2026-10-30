// Acceptance test for the fixture. It fails against the current sum.js.
import assert from 'node:assert/strict'
import { sum } from './sum.js'

assert.equal(sum(2, 3), 5, 'sum(2, 3) must be 5')
assert.equal(sum(0, 0), 0, 'sum(0, 0) must be 0')
assert.equal(sum(-4, 9), 5, 'sum(-4, 9) must be 5')

console.log('sum.test.js: all assertions passed')
