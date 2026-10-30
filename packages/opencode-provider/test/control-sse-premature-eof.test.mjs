import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { CoSControl } from '../src/control.mjs'

const encoder = new TextEncoder()
const stream = text => new ReadableStream({
  start(controller) { controller.enqueue(encoder.encode(text)); controller.close() },
})
const frame = event => 'event: event\ndata: ' + JSON.stringify(event) + '\n\n'

test('premature upstream SSE EOF resumes verified cursor, no POST or duplicated journal', async () => {
  const paths = []
  const batches = [
    [ { seq: 1, kind: 'user_message', inputId: 'input-1' },
      { seq: 2, kind: 'turn_start', turnId: 'turn-1', inputId: 'input-1' } ],
    [ { seq: 3, kind: 'assistant_message', turnId: 'turn-1', message: { text: 'partial' } },
      { seq: 4, kind: 'turn_end', turnId: 'turn-1', outcome: 'completed' } ],
  ]
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (url, options) => {
    assert.equal(options.method, 'GET')
    paths.push(url)
    const batch = batches.shift()
    return { ok: true, body: stream(batch.map(frame).join('')) }
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  const observed = []
  for await (const event of client.events('session-1')) {
    observed.push(event.seq)
    if (event.kind === 'turn_end') break
  }
  assert.deepEqual(observed, [1,2,3,4])
  assert.equal(paths.length, 2)
  assert.match(paths[0], /from=0&full=1/)
  assert.match(paths[1], /from=3&full=1/)
})

test('repeated premature SSE EOF without progress fails closed', async () => {
  let reads = 0
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (_, options) => {
    assert.equal(options.method, 'GET')
    reads++
    return { ok: true, body: stream('') }
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  await assert.rejects(async () => {
    for await (const _ of client.events('session-2')) { /* no terminal */ }
  }, /cos_stream_ended_without_terminal/)
  assert.equal(reads, 3)
})

test('transient SSE GET connection failures retry same cursor without POST', async () => {
  let attempts = 0
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (_, options) => {
    assert.equal(options.method, 'GET')
    attempts++
    if (attempts < 3) throw Error('connection reset before headers')
    return { ok: true, body: stream([
      { seq: 1, kind: 'user_message', inputId: 'input-1' },
      { seq: 2, kind: 'turn_end', turnId: 'turn-1', outcome: 'completed' },
    ].map(frame).join('')) }
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  const received = []
  for await (const event of client.events('session-1')) {
    received.push(event.seq)
    if (event.kind === 'turn_end') break
  }
  assert.deepEqual(received, [1, 2])
  assert.equal(attempts, 3)
})

test('transient SSE GET failures stop after bounded retries', async () => {
  let attempts = 0
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (_, options) => {
    assert.equal(options.method, 'GET')
    attempts++
    throw Error('unavailable')
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  await assert.rejects(async () => {
    for await (const _ of client.events('session-1')) {}
  }, /cos_transport_unavailable/)
  assert.equal(attempts, 3)
})

test('mid-stream reader reset resumes partial answer from exact next event', async () => {
  let opens = 0
  const client = new CoSControl({ directory:path.resolve('isolated-test'), fetcher:async (url, options) => {
    assert.equal(options.method, 'GET')
    opens++
    if (opens === 1) {
      assert.match(url, /from=0&full=1/)
      let n = 0
      return { ok:true, body:new ReadableStream({
        pull(controller) {
          if (n++ === 0) controller.enqueue(encoder.encode([
            { seq:1, kind:'user_message', inputId:'input-1' },
            { seq:2, kind:'turn_start', turnId:'turn-1', inputId:'input-1' },
            { seq:3, kind:'assistant_message', turnId:'turn-1', message:{text:'partial'} },
          ].map(frame).join('')))
          else controller.error(Error('connection reset during stream'))
        },
      }) }
    }
    assert.match(url, /from=4&full=1/)
    return { ok:true, body:stream([
      { seq:4, kind:'assistant_message', turnId:'turn-1', message:{text:'partial completed'} },
      { seq:5, kind:'turn_end', turnId:'turn-1', outcome:'completed' },
    ].map(frame).join('')) }
  } })
  client.base='http://127.0.0.1:50001'; client.token='test-only'
  const observed=[]
  for await (const event of client.events('session-1')) {
    observed.push(event.seq)
    if (event.kind === 'turn_end') break
  }
  assert.deepEqual(observed,[1,2,3,4,5])
  assert.equal(opens,2)
})

test('canonical superseded SSE revision is backfilled read-only, without accepting a missing visible event', async () => {
  const paths = []
  const frames = [
    { seq: 1, kind: 'user_message', inputId: 'first' },
    { seq: 4, kind: 'assistant_message', turnId: 'first-turn', message: { text: 'complete revision' } },
    { seq: 5, kind: 'turn_end', turnId: 'first-turn', outcome: 'completed' },
  ]
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (url, options) => {
    assert.equal(options.method, 'GET')
    paths.push(url)
    if (url.includes('/events?from=2&limit=100')) return {
      ok: true, json: async () => ({ events: frames.slice(1) }),
    }
    if (url.includes('/events/stream')) return { ok: true, body: stream(frames.map(frame).join('')) }
    throw Error('unexpected_read')
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  const observed = []
  for await (const event of client.events('session-1')) {
    observed.push(event.seq)
    if (event.kind === 'turn_end') break
  }
  assert.deepEqual(observed, [1, 4, 5])
  assert.equal(paths.filter(url => url.includes('/events?')).length, 1)
  assert.equal(paths.filter(url => url.includes('/events/stream')).length, 1)
})

test('SSE gap refuses to skip a still-visible canonical event', async () => {
  const frames = [
    { seq: 1, kind: 'user_message', inputId: 'first' },
    { seq: 4, kind: 'turn_end', turnId: 'first-turn', outcome: 'completed' },
  ]
  const client = new CoSControl({ directory: path.resolve('isolated-test'), fetcher: async (url, options) => {
    assert.equal(options.method, 'GET')
    if (url.includes('/events?from=2&limit=100')) return {
      ok: true, json: async () => ({ events: [{ seq: 3, kind: 'assistant_message' }, frames[1]] }),
    }
    return { ok: true, body: stream(frames.map(frame).join('')) }
  } })
  client.base = 'http://127.0.0.1:50001'
  client.token = 'test-only'
  await assert.rejects(async () => {
    for await (const _event of client.events('session-1')) { /* fail closed */ }
  }, /cos_event_sequence_gap/)
})
