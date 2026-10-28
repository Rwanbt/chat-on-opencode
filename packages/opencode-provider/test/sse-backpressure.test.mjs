import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { writeSSE } from '../src/sse-backpressure.mjs'

test('slow native renderer backpressure resolves on drain, not before', async () => {
  const output = new PassThrough({ highWaterMark: 1 })
  let settled = false
  const pending = writeSSE(output, 'data: first\\n\\n').then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false)
  assert.equal(output.read()?.toString(), 'data: first\\n\\n')
  await pending
  assert.equal(settled, true)
  assert.equal(output.listenerCount('close'), 0)
  assert.equal(output.listenerCount('error'), 0)
  output.destroy()
})

test('native renderer abort frees backpressured write and listeners', async () => {
  const output = new PassThrough({ highWaterMark: 1 })
  const controller = new AbortController()
  const pending = writeSSE(output, 'data: large\\n\\n', controller.signal)
  controller.abort()
  await assert.rejects(pending, /opencode_turn_cancelled/)
  assert.equal(output.listenerCount('drain'), 0)
  assert.equal(output.listenerCount('close'), 0)
  assert.equal(output.listenerCount('error'), 0)
  output.destroy()
})

test('closed native reader refuses another delta', async () => {
  const output = new PassThrough({ highWaterMark: 1 })
  output.destroy()
  await assert.rejects(writeSSE(output, 'data: late\\n\\n'), /opencode_turn_cancelled/)
})
