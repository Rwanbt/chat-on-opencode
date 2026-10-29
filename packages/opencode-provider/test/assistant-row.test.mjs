import assert from 'node:assert/strict'
import test from 'node:test'
import { isContentReferenceMarker } from '../src/assistant-row.mjs'

test("ChatGPT's inline citation directive alone is a product marker", () => {
  // The exact row a live run recorded, before the model's own answer.
  assert.equal(isContentReferenceMarker(
    '::chatgpt-content-reference{index="0" source_message_id="cb3b21bb-5bc5-4815-81f5-8265743ba6e4"}'), true)
  assert.equal(isContentReferenceMarker(':chatgpt-content-reference{index="0"}'), true)
  assert.equal(isContentReferenceMarker('  ::chatgpt-content-reference{index="0"}  '), true)
})

test('an answer that only trails the directive is still an answer', () => {
  // CoS's own renderer knows this shape as an inline citation at the end of
  // a reply. The whole row is the model's text and must be kept whole.
  assert.equal(isContentReferenceMarker(
    'La fonction est corrigée.\n::chatgpt-content-reference{index="0"}'), false)
})

test('an ordinary answer is not a marker', () => {
  for (const text of [
    'Le test passe.',
    '<opencode-tool>{"name":"read","arguments":{}}</opencode-tool>',
    '',
    '   ',
  ]) assert.equal(isContentReferenceMarker(text), false, JSON.stringify(text))
  assert.equal(isContentReferenceMarker(null), false)
  assert.equal(isContentReferenceMarker(undefined), false)
  assert.equal(isContentReferenceMarker(42), false)
})
