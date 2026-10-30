import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSseDataFieldCounter } from './helpers/sse-framing.mjs'

test('counts split SSE fields without retaining payload text', () => {
  let now = 0
  const counter = createSseDataFieldCounter(() => ++now * 100)
  const document = 'id: 1\r\nevent: event\r\ndata: {"text":"private"}\r\ndata: continuation\r\n\r\n: ping\n' +
    'event: event\ndata: {"text":"private2"}\n\n'
  for (const byte of new TextEncoder().encode(document)) counter.push(Uint8Array.of(byte))
  assert.deepEqual(counter.snapshot(), { fields:3, firstAt:100, lastAt:300, elapsedMs:200 })
  assert.equal(JSON.stringify(counter.snapshot()).includes('private'), false)
})

test('ignores inline data substrings and heartbeat lines', () => {
  const counter = createSseDataFieldCounter()
  counter.push('data: first\ndata: second data: inline\n: keepalive\nevent: stop\n')
  assert.equal(counter.snapshot().fields, 2)
})
