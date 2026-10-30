import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provideExtractiveCompaction } from '../plugin/compaction.mjs'

const model = { providerID: 'chat-on-opencode' }

test('a coding transcript with tool calls and results is checkpointed verbatim, not refused', () => {
  const event = {
    model,
    messages: [
      { role: 'user', content: 'fix sum.js' },
      { role: 'assistant', content: [{ type: 'tool-call', toolName: 'read', args: { path: 'sum.js' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolName: 'read', result: 'return a - b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  }
  assert.equal(provideExtractiveCompaction(event), true)
  assert.match(event.result.summary, /\[user\]\nfix sum\.js/)
  assert.match(event.result.summary, /tool-call/)
  assert.match(event.result.summary, /"toolName":"read"/)
  assert.match(event.result.summary, /tool-result/)
  assert.match(event.result.summary, /return a - b/)
  assert.match(event.result.summary, /Extractive checkpoint, not a model-generated summary/)
})

test('an unknown content part still refuses without pretending to summarise', () => {
  const event = {
    model,
    messages: [{ role: 'user', content: [{ type: 'image', image: 'x' }] }],
  }
  assert.throws(() => provideExtractiveCompaction(event), /compaction_unsupported_content/)
  assert.equal(event.result, undefined)
})
