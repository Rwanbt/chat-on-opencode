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
  const submitted = []
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  })
  const fetcher = async (url, init) => {
    const { pathname } = new URL(url)
    if (pathname === '/v1/provider/readiness') return json({
      sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true,
    })
    if (pathname.startsWith('/v1/sessions/') && !pathname.endsWith('/stream')) {
      return inputs ? json({ ok: true }) : json({ error: 'not_found' }, 404)
    }
    if (pathname === '/v1/inputs') {
      assert.equal(init.method, 'POST')
      const payload = JSON.parse(init.body)
      inputID = payload.id
      submitted.push(payload)
      inputs++
      return json({ input: { delivery: 'pending' } })
    }
    if (pathname.endsWith('/events/stream')) {
      assert.ok(inputID, 'event journal opened before sending an input')
      const revisions = inputs === 1 ? ['Hello', 'Hello world'] : ['Again', 'Again now']
      const startSeq = inputs === 1 ? 1 : 6
      const turnId = inputs === 1 ? 'turn-exact-1' : 'turn-exact-2'
      const frames = [
        { seq: startSeq, kind: 'user_message', inputId: inputID },
        { seq: startSeq + 1, kind: 'turn_start', turnId },
        { seq: startSeq + 2, kind: 'assistant_message', turnId, message: { text: revisions[0] } },
        { seq: startSeq + 3, kind: 'assistant_message', turnId, message: { text: revisions[1] } },
        { seq: startSeq + 4, kind: 'turn_end', turnId, outcome: 'complete' },
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
    async function nativeTurn(messageID, messages) {
      const response = await fetch('http://127.0.0.1:' + port + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'content-type': 'application/json',
          'x-opencode-session-id': 'session_transport_123',
          'x-opencode-message-id': messageID,
        },
        body: JSON.stringify({ model: 'chatgpt-default', stream: true, messages }),
        signal: AbortSignal.timeout(8000),
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const raw = await response.text()
      assert.match(raw, /data: \[DONE\]/)
      return raw.split(/\r?\n/).filter(line => line.startsWith('data: '))
        .map(line => line.slice(6)).filter(line => line !== '[DONE]')
        .map(line => JSON.parse(line).choices?.[0]?.delta?.content ?? '')
        .filter(Boolean)
    }
    assert.deepEqual(await nativeTurn('message_transport_123',
      [{ role: 'user', content: 'first turn fixture only' }]), ['Hello', ' world'])
    assert.deepEqual(await nativeTurn('message_transport_456', [
      { role: 'user', content: 'first turn fixture only' },
      { role: 'assistant', content: 'Hello world' },
      { role: 'user', content: 'second turn fixture only' },
    ]), ['Again', ' now'])
    assert.equal(inputs, 2, 'exactly one admission per distinct OpenCode message ID')
    assert.ok(!('sessionId' in submitted[0]), 'initial turn creates CoS session')
    assert.equal(submitted[1].sessionId, submitted[0].id,
      'continued OpenCode session must retain its original CoS identity')
    assert.notEqual(submitted[1].id, submitted[0].id,
      'follow-up requires a distinct transport input ID')
    assert.equal(submitted[1].text, 'second turn fixture only',
      'follow-up must not replay OpenCode history after initial CoS admission')
  } finally {
    await new Promise(resolve => gateway.close(resolve))
  }
})
