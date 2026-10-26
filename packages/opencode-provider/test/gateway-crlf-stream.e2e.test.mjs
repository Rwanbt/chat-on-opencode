import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { CoSControl } from '../src/control.mjs'
import { createGateway } from '../src/gateway.mjs'

test('real local HTTP gateway streams progressive CoS CRLF journal frames without duplicate text', {
  timeout: 10_000,
}, async () => {
  let inputID = null
  let inputs = 0
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  })
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url)
    if (pathname === '/v1/provider/readiness') return json({
      sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true,
    })
    if (pathname.startsWith('/v1/sessions/') && !pathname.endsWith('/stream')) {
      return json({ error: 'not_found' }, 404)
    }
    if (pathname === '/v1/inputs') {
      assert.equal(init.method, 'POST')
      const payload = JSON.parse(init.body)
      inputID = payload.id
      inputs++
      return json({ input: { delivery: 'pending' } })
    }
    if (pathname.endsWith('/events/stream')) {
      assert.ok(inputID, 'event journal opened before sending an input')
      const frames = [
        { seq: 1, kind: 'user_message', inputId: inputID },
        { seq: 2, kind: 'turn_start', turnId: 'turn-exact-1' },
        { seq: 3, kind: 'assistant_message', message: { text: 'Hello' } },
        { seq: 4, kind: 'assistant_message', message: { text: 'Hello world' } },
        { seq: 5, kind: 'turn_end', outcome: 'complete' },
      ].map(item => 'event: ' + item.kind + '\r\ndata: ' + JSON.stringify(item) + '\r\n\r\n').join('')
      const bytes = new TextEncoder().encode(frames)
      return new Response(new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
          controller.close()
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw Error('unexpected_fixture_route')
  }
  const control = new CoSControl({
    directory: path.resolve('disposable-provider-e2e-control'),
    fetcher,
  })
  control.base = 'http://127.0.0.1:1'
  control.token = 'ephemeral-test-only'
  const key = 't'.repeat(64)
  const gateway = createGateway({ control, key })
  await new Promise((resolve, reject) => gateway.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = gateway.address().port
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'x-opencode-session-id': 'session_transport_123',
        'x-opencode-message-id': 'message_transport_123',
      },
      body: JSON.stringify({
        model: 'chatgpt-default', stream: true,
        messages: [{ role: 'user', content: 'fixture only' }],
      }),
      signal: AbortSignal.timeout(8000),
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const raw = await response.text()
    const deltas = raw.split(/\r?\n/).filter(line => line.startsWith('data: '))
      .map(line => line.slice(6)).filter(line => line !== '[DONE]')
      .map(line => JSON.parse(line).choices?.[0]?.delta?.content ?? '')
      .filter(Boolean)
    assert.deepEqual(deltas, ['Hello', ' world'])
    assert.match(raw, /data: \[DONE\]/)
    assert.equal(inputs, 1, 'fragmented journal never resends the admitted prompt')
  } finally {
    await new Promise(resolve => gateway.close(resolve))
  }
})
