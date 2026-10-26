import assert from 'node:assert/strict'
import { test } from 'node:test'
import { provideLocalTitle, requirePrimaryKind } from '../plugin/auxiliary.mjs'

test('OpenCode V2 title request is handled locally without borrowing primary message identity', () => {
  const target = { model: { providerID: 'chat-on-opencode' }, sessionID: 'ses_123456' }
  assert.equal(provideLocalTitle(target), true)
  assert.equal(target.result, 'Chat On OpenCode')
  assert.equal('messageID' in target, false)
  assert.equal(provideLocalTitle(target), true)
  assert.equal(target.result, 'Chat On OpenCode')
})

test('other providers and prior title results are never overwritten', () => {
  const other = { model: { providerID: 'other' } }
  assert.equal(provideLocalTitle(other), false)
  assert.equal(other.result, undefined)
  const ours = { model: { providerID: 'chat-on-opencode' }, result: 'Existing title' }
  assert.equal(provideLocalTitle(ours), true)
  assert.equal(ours.result, 'Existing title')
})

test('non-primary HTTP requests never inherit the previous user message identity', () => {
  assert.doesNotThrow(() => requirePrimaryKind('primary'))
  for (const kind of ['title', 'compaction', 'generate']) {
    assert.throws(() => requirePrimaryKind(kind), new RegExp(`chat_on_opencode_${kind}_requires_separate_contract`))
  }
  assert.throws(() => requirePrimaryKind('unexpected'), /chat_on_opencode_unknown_request_kind/)
  assert.throws(() => requirePrimaryKind(undefined), /chat_on_opencode_unknown_request_kind/)
})
