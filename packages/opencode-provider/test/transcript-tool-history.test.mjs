import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainMessages, completedTranscriptAnchor } from '../src/transcript-handoff.mjs'
import { bridgeRequestText } from '../src/gateway.mjs'

// The second message of a coding session carries the first turn's tool exchange.
const followUp = [
  { role: 'system', content: 'You are the build agent.' },
  { role: 'user', content: 'Read sum.js.' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"sum.js"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'return a - b' },
  { role: 'assistant', content: 'sum.js subtracts its arguments.' },
  { role: 'user', content: 'Now fix it.' },
]

test('a follow-up after a coding turn is accepted and sends only the new user request', () => {
  const plain = plainMessages(followUp)
  assert.deepEqual(plain.map(part => part.role), ['system', 'user', 'tool', 'tool', 'assistant', 'user'])
  assert.match(plain[2].content, /"name":"read"/)
  assert.equal(plain[3].content, 'return a - b')
  assert.equal(bridgeRequestText(followUp, false), 'Task to carry out:\nNow fix it.')
})

test('the first-turn task keeps only the user and assistant text, never tool records', () => {
  const text = bridgeRequestText(followUp, true)
  assert.ok(!text.includes('return a - b'))
  assert.ok(text.includes('[assistant]\nsum.js subtracts its arguments.\n[/assistant]'))
})

test('the completed transcript anchor is still taken from the final user request', () => {
  const anchor = completedTranscriptAnchor(followUp, 'Fixed.')
  assert.ok(anchor && /^[a-f0-9]{64}$/.test(anchor.questionSha256))
})

test('an unknown role or a non-text user message is still refused', () => {
  assert.throws(() => plainMessages([{ role: 'function', content: 'x' }]), /unsupported_chat_content/)
  assert.throws(() => plainMessages([{ role: 'user', content: [{ type: 'image', image: 'x' }] }]), /unsupported_chat_content/)
})
