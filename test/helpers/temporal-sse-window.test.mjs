import assert from 'node:assert/strict'
import { test } from 'node:test'
import { temporalSseWindow } from './temporal-sse-window.mjs'

test('temporal SSE metrics exclude earlier frames and never imply turn attribution', () => {
  const before = { frames:18, responses:1, lastAt:1000 }
  const after = { frames:31, responses:1, lastAt:1900 }
  assert.deepEqual(temporalSseWindow(before, after), {
    correlation:'temporal_uncorrelated', frames:13, responses:0, elapsedMs:900,
  })
})

test('zero frames have zero elapsed time, even if a previous stream remains open', () => {
  assert.deepEqual(temporalSseWindow(
    { frames:31, responses:1, lastAt:1900 },
    { frames:31, responses:1, lastAt:1900 },
  ), { correlation:'temporal_uncorrelated', frames:0, responses:0, elapsedMs:0 })
})
