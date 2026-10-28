import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { CoSControl } from '../src/control.mjs'

test('SSE multi-line data preserves one structured event and its correlation sequence', async () => {
  const event = { seq: 9, kind: 'turn_start', turnId: 'turn-next', inputId: 'input-next' }
  const json = JSON.stringify(event)
  const middle = json.indexOf(',') + 1
  const frame = `event: turn_start\ndata: ${json.slice(0, middle)}\ndata: ${json.slice(middle)}\n\n`
  const instance = new CoSControl({ directory: path.resolve('unused-multiline-control'),
    fetcher: async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame)); controller.close()
    } }), { status: 200 }) })
  instance.base = 'http://127.0.0.1:1'
  instance.token = 'fake-no-secret'
  const events = instance.events('00000000-0000-5000-8000-000000000001', { from: 9 })
  try { assert.deepEqual((await events.next()).value, event) }
  finally { await events.return() }
})
