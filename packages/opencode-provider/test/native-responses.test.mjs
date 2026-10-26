import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { nativeResponsesLanguage, registerNativeResponses } from '../plugin/native-responses.mjs'

const accountID = 'synthetic-subject-1'
const modelID = 'synthetic-gpt-model'
const bearer = 'synthetic-oauth-access-12345'
const catalog = { accountID, models: [{ slug: modelID, displayName: 'Test' }] }
const integration = (events = []) => ({ connection: {
  async active(id) { events.push('active:' + id); return { type: 'credential', id: 'synthetic-credential' } },
  async resolve() { events.push('resolve'); return { type: 'oauth', methodID: 'chatgpt',
    access: bearer, expires: Date.now() + 180_000,
    metadata: { subject: accountID, issuer: 'https://auth.openai.com',
      clientID: 'oaiapp_synthetic_client', scopes: 'resource.invoke chatgpt.tokens.use.direct' } } },
} })
const prompt = () => [
  { role: 'system', content: 'Do not execute tools' },
  { role: 'user', content: [{ type: 'text', text: 'Bonjour' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Salut' }] },
  { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
]
const options = (other = {}) => ({ prompt: prompt(), tools: [],
  toolChoice: { type: 'none' }, ...other })
const identity = async () => ({ sessionID: 'session-native-0001', messageID: 'message-native-0002' })

async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}/v1/responses`
}
const success = (content = 'Réponse synthétique', kind = 'response.completed') =>
  `event: ${kind}\ndata: ${JSON.stringify({ type: kind, response: { status: 'completed', model: modelID,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] } })}\n\ndata: [DONE]\n\n`

test('V2 native AI SDK language doStream makes real authorized no-store HTTP and releases verified text only', async t => {
  const events = [], requests = []
  const endpoint = await serverFor(t, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    assert.equal(req.url, '/v1/responses')
    assert.equal(req.headers.authorization, 'Bearer ' + bearer)
    assert.equal(body.model, modelID)
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    assert.ok(!Object.hasOwn(body, 'max_output_tokens'))
    assert.ok(!Object.hasOwn(body, 'temperature'))
    assert.equal(body.input.length, 3) // system text moved to instructions
    assert.equal(body.instructions, 'Do not execute tools')
    assert.equal(body.input[2].content, 'Continue')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(success())
  })
  const ctx = { integration: integration(events), aisdk: { async language(cb) { this.cb = cb } } }
  await registerNativeResponses(ctx, { accountID, catalog, identity, endpoint, allowLoopbackTest: true })
  const evt = { model: { providerID: 'chat-on-opencode', id: modelID,
    api: { id: modelID } }, options: {}, sdk: { languageModel: () => { throw Error('unsafe default SDK') } } }
  ctx.aisdk.cb(evt)
  assert.equal(evt.language.specificationVersion, 'v3')
  const stream = (await evt.language.doStream(options({ temperature: 0.7, maxOutputTokens: 200 }))).stream
  const parts = []
  for await (const part of stream) parts.push(part)
  assert.deepEqual(parts.map(p => p.type), ['stream-start','text-start','text-delta','text-end','finish'])
  assert.equal(parts[2].delta, 'Réponse synthétique')
  assert.equal(parts[4].finishReason.unified, 'stop')
  assert.deepEqual(events, ['active:chat-on-opencode', 'resolve'])
  assert.equal(requests.length, 1)
})

test('native unsupported tools/media and missing identity fail before OAuth and network', async () => {
  const events = []
  const model = nativeResponsesLanguage({ modelID, accountID, catalog,
    integration: integration(events), identity: async () => null })
  for (const input of [options({ tools: [{ type: 'function', name: 'shell' }] }),
    options({ prompt: [{ role: 'user', content: [{ type: 'file', data: 'private' }] }] }),
    options({ responseFormat: { type: 'json' } })]) {
    await assert.rejects(model.doStream(input), /native_text_only_required|native_unsupported_context/)
  }
  await assert.rejects(model.doStream(options()), /native_turn_identity_unavailable/)
  assert.deepEqual(events, [])
})

test('unknown native model/account, forged identity and malformed host callback fail closed', async () => {
  assert.throws(() => nativeResponsesLanguage({ modelID:'unauthorized', accountID, catalog,
    integration: integration(), identity }), /native_model_not_authorized/)
  assert.throws(() => nativeResponsesLanguage({ modelID, accountID, catalog,
    integration: integration() }), /native_host_authority_missing/)
  const ctx = { integration: integration(), aisdk: { language: async () => {} } }
  await assert.rejects(registerNativeResponses(ctx, { accountID, catalog }), /native_host_authority_missing/)
  const native = nativeResponsesLanguage({ modelID, accountID, catalog,
    integration: integration(), identity: () => ({ sessionID:'wrong', messageID:'invalid' }) })
  await assert.rejects(native.doStream(options()), /transport_identity_required/)
})

test('SSE response.failure after a delta does not deliver any user-visible AI SDK stream', async t => {
  const endpoint = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"SECRET_UNVERIFIED"}\n\n' +
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n')
  })
  const model = nativeResponsesLanguage({ modelID, accountID, catalog, identity,
    integration: integration(), endpoint, allowLoopbackTest: true })
  await assert.rejects(model.doStream(options()), /response_not_completed/)
})

test('native doGenerate supplies text only after completed SSE', async t => {
  const endpoint = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(success('Full reply'))
  })
  const model = nativeResponsesLanguage({ modelID, accountID, catalog, identity,
    integration: integration(), endpoint, allowLoopbackTest: true })
  const result = await model.doGenerate(options())
  assert.deepEqual(result.content, [{ type: 'text', text: 'Full reply' }])
})
