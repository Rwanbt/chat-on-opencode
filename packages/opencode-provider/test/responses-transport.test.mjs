import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { sendResponses } from '../src/responses-transport.mjs'

const MODEL = 'gpt-test-authorized'
const TOKEN = 'synthetic-test-token-never-log'
const request = extra => ({ model: 'chatgpt-default', stream: true,
  messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Bonjour' }], ...extra })
const options = extra => ({ sessionID: 'session-123', messageID: 'message-456', model: MODEL,
  getToken: async () => ({ token: TOKEN, model: MODEL }), ...extra })
const frame = (type, data) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`
const success = (text = 'Bonjour') => frame('response.completed', { response: { status: 'completed', model: MODEL,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }) + 'data: [DONE]\r\n\r\n'

async function localServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/responses`
  try { return await fn(endpoint) } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('actual offline HTTP POST uses only bearer, strict body and terminal SSE completion', async () => {
  let count = 0
  await localServer(async (req, res) => {
    count++
    assert.equal(req.url, '/v1/responses')
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(req.headers.accept, 'text/event-stream')
    assert.equal(req.headers['cache-control'], 'no-store')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.deepEqual(body, { model: MODEL, input: [{ role: 'user', content: 'Bonjour' }],
      store: false, stream: true, instructions: 'Be precise' })
    assert.ok(!JSON.stringify(body).includes(TOKEN))
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    for (const byte of Buffer.from(frame('response.output_text.delta', { delta: 'Bon' }) +
      frame('response.output_text.delta', { delta: 'jour' }) + success(), 'utf8')) res.write(Buffer.from([byte]))
    res.end()
  }, async endpoint => {
    const result = await sendResponses(request(), options({ endpoint, allowLoopbackTest: true }))
    assert.deepEqual(result, { content: 'Bonjour', tool_calls: [], finish_reason: 'stop',
      sessionID: 'session-123', messageID: 'message-456', model: MODEL })
  })
  assert.equal(count, 1)
})

test('unauthorized tool suggestions and history stop before fetching a token or posting', async () => {
  let requests = 0
  const getToken = () => { requests++; throw new Error('must never execute') }
  const tool = { type: 'function', function: { name: 'read', parameters: { type: 'object' } } }
  await assert.rejects(sendResponses(request({ tools: [tool] }), options({ getToken })), /native_tool_approval_unavailable/)
  const history = [{ role: 'user', content: 'read' }, { role: 'assistant', content: null,
    tool_calls: [{ id: 'call_001', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_001', content: 'result' }]
  await assert.rejects(sendResponses(request({ messages: history }), options({ getToken })), /native_tool_approval_unavailable/)
  assert.equal(requests, 0)
})

test('real localhost rejects unauthorized output, wrong model, premature EOF and non-SSE', async () => {
  for (const body of [
    frame('response.completed', { response: { status: 'completed', model: MODEL, output: [
      { type: 'function_call', id: 'fc_01', call_id: 'call_01', name: 'read', arguments: '{}' }] } }),
    frame('response.completed', { response: { status: 'completed', model: 'wrong-model', output: [] } }),
    frame('response.output_text.delta', { delta: 'unverified' }),
  ]) {
    await localServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body) },
      async endpoint => assert.rejects(sendResponses(request(), options({ endpoint, allowLoopbackTest: true })),
        /unsupported_output_item|response_model_mismatch|response_missing_completion/))
  }
  await localServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"token":"hidden"}') },
    async endpoint => assert.rejects(sendResponses(request(), options({ endpoint, allowLoopbackTest: true })), /responses_content_type_invalid/))
})

test('redirects, failed statuses, invalid credentials and exceptions never leak token or body', async () => {
  for (const status of [302, 401, 429, 500]) {
    await localServer((_req, res) => { res.writeHead(status, { location: 'https://unauthorized.test/' }); res.end(`SECRET ${TOKEN}`) },
      async endpoint => {
        let error
        try { await sendResponses(request(), options({ endpoint, allowLoopbackTest: true })) } catch (e) { error = e }
        assert.ok(error)
        assert.ok(!String(error).includes(TOKEN))
        assert.ok(!String(error).includes('unauthorized.test'))
      })
  }
  await assert.rejects(sendResponses(request(), options({ getToken: async () => ({ token: TOKEN, model: 'unlicensed' }) })),
    /token_model_not_authorized/)
  await assert.rejects(sendResponses(request(), options({ getToken: async () => { throw new Error(TOKEN) } })),
    e => e.message === 'responses_transport_failed' && !String(e).includes(TOKEN))
  await assert.rejects(sendResponses(request(), options({ fetchImpl: async () => { throw new Error(TOKEN) } })),
    e => e.message === 'responses_network_failed' && !String(e).includes(TOKEN))
})

test('hard endpoint SSRF guard refuses non-official and non-loopback hosts without token access', async () => {
  let called = 0
  const getToken = () => { called++; return { token: TOKEN, model: MODEL } }
  for (const endpoint of ['http://127.0.0.1:3214/v1/responses', 'http://localhost:3214/v1/responses',
    'http://127.0.0.2:3214/v1/responses', 'http://127.0.0.1:3214/other',
    'https://api.openai.com.evil.test/v1/responses', 'http://127.0.0.1:3214/v1/responses?x=1',
    'file:///tmp/token', 'http://127.0.0.1:3214@evil.test/v1/responses']) {
    await assert.rejects(sendResponses(request(), options({ getToken, endpoint })), /endpoint_not_allowed/)
  }
  assert.equal(called, 0)
})

test('abort rejects before token or network and duplicate live turn identity is denied', async () => {
  const preAborted = new AbortController()
  preAborted.abort()
  let calls = 0
  await assert.rejects(sendResponses(request(), options({ signal: preAborted.signal,
    getToken: () => { calls++; return { token: TOKEN, model: MODEL } } })), /response_aborted/)
  assert.equal(calls, 0)
  const active = new AbortController()
  const never = () => new Promise(() => {})
  const pending = sendResponses(request(), options({ signal: active.signal, getToken: never }))
  await assert.rejects(sendResponses(request(), options()), /turn_already_active/)
  await assert.rejects(sendResponses(request(), options({ model: 'another-model' })), /turn_already_active/)
  active.abort()
  await assert.rejects(pending, /response_aborted/)
  await assert.rejects(sendResponses(request(), options({ timeoutMs: 1, getToken: never })), /response_aborted/)
  assert.equal((await sendResponses(request(), options({ fetchImpl: async () => new Response(success(),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }) }))).content, 'Bonjour')
})

test('real HTTP cancellation after unverified delta yields no partial result', async () => {
  let notify
  const reached = new Promise(resolve => { notify = resolve })
  await localServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame('response.output_text.delta', { delta: 'not final' }))
    notify()
  }, async endpoint => {
    const controller = new AbortController()
    const pending = sendResponses(request(), options({ endpoint, allowLoopbackTest: true,
      signal: controller.signal }))
    await reached
    controller.abort()
    await assert.rejects(pending, /response_aborted/)
  })
})

test('invalid provenance cannot obtain any token or start a network request', async () => {
  let calls = 0
  for (const bad of [{ sessionID: '' }, { sessionID: 'x\r\nAuthorization:Bearer' },
    { messageID: '../x' }, { messageID: 'x' }, { timeoutMs: 120001 }]) {
    await assert.rejects(sendResponses(request(), options({ ...bad, getToken: () => { calls++; return { token: TOKEN, model: MODEL } } })),
      /transport_identity_required|invalid_timeout/)
  }
  assert.equal(calls, 0)
})
