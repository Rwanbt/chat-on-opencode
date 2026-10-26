import assert from 'node:assert/strict'
import { test } from 'node:test'
import { provideExtractiveCompaction } from '../plugin/compaction.mjs'

test('fresh session compaction is satisfied locally without a model or borrowed message ID', () => {
  const event = { model: { providerID: 'chat-on-opencode' }, messages: [] }
  assert.equal(provideExtractiveCompaction(event), true)
  assert.match(event.result.summary, /no prior conversation/i)
})

test('compaction uses an explicitly extractive, exact recent text transcript', () => {
  const event = { model: { providerID: 'chat-on-opencode' }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Keep this detail exactly: Étagère 🍀' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Confirmed.' }] },
  ] }
  assert.equal(provideExtractiveCompaction(event), true)
  assert.match(event.result.summary, /Étagère 🍀/)
  assert.match(event.result.summary, /Confirmed\./)
  assert.match(event.result.summary, /extractive/i)
})

test('another provider and existing result are not overwritten', () => {
  const other = { model: { providerID: 'anthropic' }, messages: [] }
  assert.equal(provideExtractiveCompaction(other), false)
  assert.equal(other.result, undefined)
  const ours = { model: { providerID: 'chat-on-opencode' }, messages: [], result: { summary: 'custom' } }
  assert.equal(provideExtractiveCompaction(ours), true)
  assert.equal(ours.result.summary, 'custom')
})

test('non-text content and invalid transcript refuse without pretending to summarize', () => {
  for (const messages of [undefined, [{ role: 'user', content: [{ type: 'image', url: 'file://x' }] }]]) {
    assert.throws(() => provideExtractiveCompaction({ model: { providerID: 'chat-on-opencode' }, messages }),
      /chat_on_opencode_compaction_unsupported_content/)
  }
})

test('long messages keep bounded recent literal text with explicit omission notice', () => {
  const event = { model: { providerID: 'chat-on-opencode' }, messages: [
    { role: 'user', content: 'OLDER'.repeat(60) },
    { role: 'assistant', content: 'NEWEST' },
  ] }
  assert.equal(provideExtractiveCompaction(event, { maxChars: 256 }), true)
  assert.doesNotMatch(event.result.summary, /OLDER/)
  assert.match(event.result.summary, /NEWEST/)
  assert.match(event.result.summary, /omitted/i)
})
