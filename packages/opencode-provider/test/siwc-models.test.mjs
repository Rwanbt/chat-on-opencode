import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { listSIWCModels, requireSIWCModel, SIWCModelsError } from '../src/siwc-models.mjs'

const accountID = 'account-a'
const token = 'synthetic-bearer-value'
const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct', 'openid']
const grant = (extra = {}) => ({ accountID, token, scopes, expiresAt: Date.now() + 60000, ...extra })
const catalog = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol', visibility: 'list' },
  { slug: 'another-model', display_name: 'Another', visibility: 'list' },
  { slug: 'hidden-internal', display_name: 'Do not show', visibility: 'hidden' },
] }
const json = (data, options = {}) => new Response(JSON.stringify(data), {
  status: options.status ?? 200, headers: { 'content-type': 'application/json' },
})
const setup = (options = {}) => ({
  accountID, getToken: async () => grant(), fetchImpl: async () => json(catalog), ...options,
})
async function denies(code, fn) {
  await assert.rejects(fn, error => {
    assert.equal(error instanceof SIWCModelsError, true)
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.doesNotMatch(error.stack ?? '', /synthetic-bearer-value/)
    return true
  })
}

test('official URL receives only explicitly attested selected-account token and returns ordered visible slugs', async () => {
  let calls = 0
  const found = await listSIWCModels(setup({
    getToken: async input => {
      assert.equal(input.accountID, accountID)
      calls++
      return grant()
    },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/models')
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'omit')
      assert.equal(init.headers.Authorization, 'Bearer ' + token)
      assert.equal(init.cache, 'no-store')
      assert.equal(init.referrerPolicy, 'no-referrer')
      calls++
      return json(catalog)
    },
  }))
  assert.equal(calls, 2)
  assert.deepEqual(found.models, [
    { slug: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' },
    { slug: 'another-model', displayName: 'Another' },
  ])
  assert.equal(requireSIWCModel(found, accountID, 'gpt-6.1-sol'), 'gpt-6.1-sol')
  assert.throws(() => requireSIWCModel(found, 'another-account', 'gpt-6.1-sol'), /catalog_model_not_authorized/)
  assert.throws(() => requireSIWCModel(found, accountID, 'hidden-internal'), /catalog_model_not_authorized/)
  assert.throws(() => requireSIWCModel(found, accountID, 'gpt-6.1-sol-not-granted'), /catalog_model_not_authorized/)
})

test('malicious endpoint cannot request the account token or invoke network', async () => {
  for (const endpoint of ['http://localhost:4242/v1/models', 'https://api.openai.com.evil/v1/models',
    'file:///etc/passwd', 'http://127.0.0.1:4242/v1/models#fragment',
    'http://127.0.0.1:4242/v1/models?token=1', 'http://127.0.0.1:4242/v1/other']) {
    await denies('catalog_endpoint_forbidden', () => listSIWCModels(setup({
      endpoint, getToken: () => { throw Error('token supplier must not run') },
    })))
  }
})

test('missing or unauthorized credential never performs HTTP', async () => {
  for (const bad of [
    { accountID: 'other-account' }, { scopes: ['openid'] }, { scopes: ['chatgpt.tokens.use.direct'] },
    { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 10 }, { token: 'a b\r\nSecret' },
    { token: 'short' }, { scopes: 'resource.invoke chatgpt.tokens.use.direct' },
  ]) {
    await denies('catalog_grant_invalid', () => listSIWCModels(setup({
      getToken: async () => grant(bad),
      fetchImpl: () => { throw Error('network must not start') },
    })))
  }
  await denies('catalog_account_required', () => listSIWCModels(setup({ accountID: '../wrong' })))
})

test('real loopback HTTP fixture is opt-in and disallows redirects and non-200 bodies', async t => {
  const hits = []
  const server = createServer((req, res) => {
    hits.push({ path: req.url, auth: req.headers.authorization })
    if (req.url === '/v1/models' && hits.length === 1) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(catalog))
    } else {
      res.statusCode = 302
      res.setHeader('location', 'https://example.invalid/')
      res.end('do not follow')
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/models`
  await denies('catalog_endpoint_forbidden', () => listSIWCModels(setup({ endpoint })))
  const response = await listSIWCModels(setup({ endpoint, allowLoopbackTest: true, fetchImpl: globalThis.fetch }))
  assert.equal(response.models.length, 2)
  await denies('catalog_network_failed', () => listSIWCModels(setup({ endpoint, allowLoopbackTest: true, fetchImpl: globalThis.fetch })))
  assert.equal(hits.length, 2, 'redirect was not followed')
  assert.deepEqual(hits[0], { path: '/v1/models', auth: 'Bearer ' + token })
})

test('damaged and ambiguous catalogs fail closed without choosing a model', async () => {
  for (const body of [
    {}, { models: [] }, { models: null },
    { models: [catalog.models[0], catalog.models[0]] },
    { models: [{ slug: '../escape', display_name: 'bad', visibility: 'list' }] },
    { models: [{ slug: 'ok', display_name: 'bad\nname', visibility: 'list' }] },
    { models: [null] }, { models: [{ slug: 'x', display_name: 'x' }] },
    { models: [{ slug: 'hidden', display_name: 'X', visibility: 'hidden' }] },
  ]) {
    await assert.rejects(() => listSIWCModels(setup({ fetchImpl: async () => json(body) })),
      SIWCModelsError)
  }
  await denies('catalog_response_invalid', () => listSIWCModels(setup({
    fetchImpl: async () => new Response(Uint8Array.from([0xc3, 0x28]), {
      headers: { 'content-type': 'application/json' },
    }),
  })))
  await denies('catalog_response_too_large', () => listSIWCModels(setup({
    fetchImpl: async () => new Response(' '.repeat(1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }),
  })))
})

test('HTTP errors, JSON content type, network errors and cancellation are sanitized', async () => {
  await denies('catalog_http_rejected', () => listSIWCModels(setup({
    fetchImpl: async () => new Response('SECRET_UPSTREAM_BODY', { status: 401 }),
  })))
  await denies('catalog_content_type_invalid', () => listSIWCModels(setup({
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
  })))
  await denies('catalog_network_failed', () => listSIWCModels(setup({
    fetchImpl: async () => { throw new Error('PRIVATE_TOKEN_SHOULD_NOT_LEAK') },
  })))
  const controller = new AbortController()
  controller.abort()
  await denies('catalog_aborted', () => listSIWCModels(setup({
    signal: controller.signal, getToken: () => { throw Error('must not run') },
  })))
  await denies('catalog_aborted', () => listSIWCModels(setup({
    timeoutMs: 15, getToken: () => new Promise(() => {}),
  })))
})
