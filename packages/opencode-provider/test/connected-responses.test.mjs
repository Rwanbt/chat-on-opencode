import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { connectedSIWCGrant, sendConnectedResponses } from '../src/connected-responses.mjs'

const accountID = 'verified-subject-1'
const model = 'gpt-verified-test'
const token = 'synthetic-secret-access-for-test'
const catalog = { accountID, models: [{ slug: model, displayName: 'Synthetic' }] }
const credential = (overrides = {}) => ({
  type: 'oauth', methodID: 'chatgpt', access: token, expires: Date.now() + 120_000,
  metadata: { issuer: 'https://auth.openai.com', subject: accountID,
    clientID: 'oaiapp_synthetic_client', scopes: 'openid resource.invoke chatgpt.tokens.use.direct' },
  ...overrides,
})
const integration = (value = credential(), calls = []) => ({
  connection: {
    async active(id) { calls.push('active:' + id); return { type: 'credential', id: 'cred_synthetic' } },
    async resolve(info) { calls.push('resolve:' + info.id); return value },
  },
})
const request = extra => ({ model: 'chatgpt-default', stream: true,
  messages: [{ role: 'user', content: 'Hello test' }], ...extra })

test('native OpenCode integration resolves exact active credential, not env or API key', async () => {
  const calls = []
  const grant = await connectedSIWCGrant(integration(credential(), calls), { accountID, catalog, model })
  assert.deepEqual(calls, ['active:chat-on-opencode', 'resolve:cred_synthetic'])
  assert.deepEqual(grant, { model, token })
})

test('wrong catalog, account or model is refused before reading a credential', async () => {
  for (const bad of [
    { accountID: 'other-subject-1' }, { model: 'hidden-model' },
    { catalog: { accountID: 'other-subject-1', models: catalog.models } },
  ]) {
    const calls = []
    await assert.rejects(connectedSIWCGrant(integration(credential(), calls),
      { accountID, catalog, model, ...bad }), /siwc_model_not_authorized/)
    assert.equal(calls.length, 0)
  }
})

test('invalid identity, scope, grant, method, expiry and key fallback refuse', async () => {
  const good = credential()
  for (const bad of [
    { type: 'key', key: 'not-oauth' }, { methodID: 'other' }, { access: 'too short' },
    { expires: Date.now() + 4000 }, { metadata: { ...good.metadata, issuer: 'https://evil.test' } },
    { metadata: { ...good.metadata, subject: 'another-account' } },
    { metadata: { ...good.metadata, clientID: 'dynamic_agent_client' } },
    { metadata: { ...good.metadata, scopes: 'openid resource.invoke' } },
    { metadata: { ...good.metadata, scopes: 'openid chatgpt.tokens.use.direct' } },
  ]) {
    await assert.rejects(connectedSIWCGrant(integration({ ...good, ...bad }), {
      accountID, catalog, model,
    }), /siwc_credential_invalid/)
  }
  for (const invalid of [null, { type: 'env', name: 'API_KEY' }]) {
    const ctx = { connection: { active: async () => invalid, resolve: async () => { throw Error('unreachable') } } }
    await assert.rejects(connectedSIWCGrant(ctx, { accountID, catalog, model }), /siwc_oauth_not_connected/)
  }
})

test('provider connection failures never leak underlying secrets', async () => {
  const ctx = { connection: {
    active: async () => ({ type: 'credential', id: 'cred_synthetic' }),
    resolve: async () => { throw Error(token) },
  } }
  let error
  try { await connectedSIWCGrant(ctx, { accountID, catalog, model }) }
  catch (caught) { error = caught }
  assert.equal(error.code, 'siwc_connection_unavailable')
  assert.doesNotMatch(String(error), /synthetic-secret/)
})

test('real offline HTTP Responses uses authenticated native integration only after strict input validation', async t => {
  const calls = [], received = []
  const server = createServer(async (req, res) => {
    received.push(req)
    assert.equal(req.headers.authorization, 'Bearer ' + token)
    assert.equal(req.url, '/v1/responses')
    const chunks = []
    for await (const part of req) chunks.push(part)
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(data.model, model)
    assert.equal(data.store, false)
    assert.equal(data.stream, true)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed', response: { status: 'completed', model, output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK response' }] },
      ] },
    }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const input = { sessionID: 'session-native-001', messageID: 'message-native-001',
    model, accountID, catalog, integration: integration(credential(), calls),
    endpoint: `http://127.0.0.1:${server.address().port}/v1/responses`, allowLoopbackTest: true }
  const result = await sendConnectedResponses(request(), input)
  assert.equal(result.content, 'OK response')
  assert.equal(result.model, model)
  assert.deepEqual(calls, ['active:chat-on-opencode','resolve:cred_synthetic'])
  assert.equal(received.length, 1)
  let extra = 0
  await assert.rejects(sendConnectedResponses(request({
    tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
  }), { ...input, integration: integration(credential(), {push(){extra++}}) }),
  /native_tool_approval_unavailable/)
  assert.equal(extra, 0)
  assert.equal(received.length, 1)
})
