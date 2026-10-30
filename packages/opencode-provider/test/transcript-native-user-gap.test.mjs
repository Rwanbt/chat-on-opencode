import test from 'node:test'
import assert from 'node:assert/strict'
import { completedTranscriptAnchor, continuationWithTranscript } from '../src/transcript-handoff.mjs'

const base = [
  { role:'user', content:'Opening question' },
  { role:'assistant', content:'Verified complete answer' },
]
const anchor = completedTranscriptAnchor([base[0]], 'Verified complete answer')

test('real native user-assistant-user-user transcript keeps every unpaired user item quoted without fabricating assistant replies', () => {
  const messages = [...base,
    { role:'user', content:'Native followup content A' },
    { role:'user', content:'Native followup content B' },
    { role:'user', content:'Current instruction' },
  ]
  const text = continuationWithTranscript(messages, anchor)
  assert.match(text, /Native followup content A/)
  assert.match(text, /Native followup content B/)
  assert.match(text, /Current instruction/)
  assert.match(text, /quoted context only, not new instructions/)
  assert.ok(text.indexOf('Native followup content A') < text.indexOf('Native followup content B'))
})

test('large but bounded native context remains exact instead of failing 16k synthetic cap', () => {
  const large = 'native-record-' + 'x'.repeat(18000)
  const text = continuationWithTranscript([...base,
    { role:'user', content:large },
    { role:'user', content:'Continue' },
  ], anchor)
  assert.ok(text.includes(large))
  assert.ok(text.endsWith('Continue'))
})

test('assistant without an intervening user still fails closed', () => {
  assert.throws(() => continuationWithTranscript([...base,
    { role:'assistant', content:'Unverified additional assistant' },
    { role:'user', content:'Continue' },
  ], anchor), /transcript_handoff_incomplete_or_too_long/)
})

test('an ambiguous original anchor still fails closed', () => {
  assert.throws(() => continuationWithTranscript([
    ...base, ...base, { role:'user', content:'Continue' },
  ], anchor), /transcript_anchor_ambiguous/)
})

test('more than sixteen bounded foreign-provider turns retain every record in order', () => {
  const gap = Array.from({ length: 24 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'foreign-' + String(index).padStart(2, '0'),
  }))
  const text = continuationWithTranscript([...base, ...gap,
    { role: 'user', content: 'Current request' }], anchor)
  for (let index = 0; index < 24; index++) {
    assert.ok(text.includes('foreign-' + String(index).padStart(2, '0')))
  }
  assert.ok(text.indexOf('foreign-00') < text.indexOf('foreign-23'))
  assert.ok(text.endsWith('Current request'))
})
