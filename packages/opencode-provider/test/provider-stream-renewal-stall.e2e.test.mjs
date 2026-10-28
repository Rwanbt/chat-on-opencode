import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { CoSControl } from '../src/control.mjs'
import { createGateway, stableUUID } from '../src/gateway.mjs'

test('Windows loopback renews a stalled CoS SSE stream and finishes a later native turn without re-sending input',
  { timeout: 5500 }, async t => {
    const session = 'native-renewal-session'
    const bearer = 'r'.repeat(48)
    const inputs = []
    const requested = []
    const cancelled = []
    const encoder = new TextEncoder()
    const frame = event => 'event: ' + event.kind + '\ndata: ' + JSON.stringify(event) + '\n\n'
    const initial = [
      { seq: 1, kind: 'user_message', inputId: stableUUID('session:' + session) },
      { seq: 2, kind: 'turn_start', turnId: 'cos-turn-1' },
      { seq: 3, kind: 'assistant_message', turnId: 'cos-turn-1', message: { text: 'Hello' } },
    ]
    const resumed = [
      { seq: 4, kind: 'assistant_message', turnId: 'cos-turn-1', message: { text: 'Hello after SSE renewal' } },
      { seq: 5, kind: 'turn_end', turnId: 'cos-turn-1', outcome: 'completed' },
    ]
    const followup = [
      { seq: 6, kind: 'user_message', inputId: stableUUID('turn:' + session + ':native-msg-002') },
      { seq: 7, kind: 'turn_start', turnId: 'cos-turn-2' },
      { seq: 8, kind: 'assistant_message', turnId: 'cos-turn-2', message: { text: 'Next answer' } },
      { seq: 9, kind: 'turn_end', turnId: 'cos-turn-2', outcome: 'completed' },
    ]
    const control = new CoSControl({ directory: process.cwd(), fetcher: async url => {
      const cursor = Number(new URL(url).searchParams.get('from'))
      requested.push(cursor)
      const payload = inputs.length === 1
        ? cursor === 0
          ? initial.map(frame).join('') + 'event: end\ndata: {"reason":"max_duration"}\n\n'
          : resumed.map(frame).join('')
        : [...initial, ...resumed, ...followup].map(frame).join('')
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(payload)) },
        // An upstream stream may stop emitting after a valid rotation or
        // completed turn, while its custom cancellation promise never settles.
        cancel() { cancelled.push(cursor); return new Promise(() => {}) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    } })
    control.base = 'http://127.0.0.1:1'
    control.token = 't'.repeat(40)
    control.hasSession = async () => inputs.length > 0
    control.readiness = async () => ({ sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true })
    control.assertReady = async () => {}
    control.send = async input => { inputs.push(input); return { delivery: 'sent' } }

    const server = createGateway({ control, key: bearer })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => { server.closeAllConnections(); server.close() })
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions'
    const streamedText = body => body.split('\n\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)).choices[0].delta.content ?? '').join('')
    async function send(message, prompt) {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json',
          'x-opencode-session-id': session, 'x-opencode-message-id': message },
        body: JSON.stringify({ model: 'chatgpt-default', stream: true, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(650),
      })
      return { status: response.status, body: await response.text() }
    }
    const first = await send('native-msg-001', 'first').catch(error => {
      assert.fail('first turn timeout: ' + error.message + ', cursors=' + requested.join(',') +
        ', cancels=' + cancelled.join(',') + ', inputs=' + inputs.length)
    })
    assert.equal(first.status, 200)
    assert.equal(streamedText(first.body), 'Hello after SSE renewal')
    assert.match(first.body, /\[DONE\]/)
    assert.deepEqual(requested, [0, 4], 'journal cursor resumes without reopening the original events')
    assert.equal(inputs.length, 1, 'stream renewal must not repeat a CoS model input')

    const second = await send('native-msg-002', 'second')
    assert.equal(second.status, 200)
    assert.equal(streamedText(second.body), 'Next answer', 'earlier turn must not contaminate second answer')
    assert.equal(inputs.length, 2)
    assert.equal(inputs[1].sessionId, stableUUID('session:' + session))
    assert.ok(cancelled.includes(0) && cancelled.includes(4),
      'stream cleanup was requested even though upstream cancellation did not settle')
  })
