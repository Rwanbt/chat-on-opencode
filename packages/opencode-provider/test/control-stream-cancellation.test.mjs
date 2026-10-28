import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { CoSControl } from '../src/control.mjs'

test('cancelling an established silent SSE stream releases its reader promptly', async () => {
  const abort = new AbortController()
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const control = new CoSControl({ directory: path.resolve('unused-isolated-control'),
    fetcher: async () => new Response(body, { status: 200 }) })
  control.base = 'http://127.0.0.1:1'
  control.token = 'nonsecret-test-token'
  const stream = control.events('00000000-0000-5000-8000-000000000001', { signal: abort.signal })
  const pending = stream.next()
  await new Promise(resolve => setTimeout(resolve, 20))
  abort.abort()
  const result = await Promise.race([
    pending.then(() => 'resolved', error => error.code ?? error.message),
    new Promise(resolve => setTimeout(() => resolve('hung'), 300)),
  ])
  assert.notEqual(result, 'hung', 'a disconnected turn must never hold a silent SSE reader')
  assert.equal(cancelled, true, 'cancel must release the upstream reader')
})
