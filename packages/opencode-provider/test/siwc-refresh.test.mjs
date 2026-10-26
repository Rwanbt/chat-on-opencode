import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { refreshSIWCGrant } from '../src/siwc-exchange.mjs'

const now = Date.UTC(2026, 9, 26)
const clientID = 'oaiapp_synthetic_refresh_client'
const oldToken = 'synthetic_refresh_token_old'
const newerToken = 'synthetic_refresh_token_rotated'
const prior = () => ({ clientID, issuer: 'https://auth.openai.com',
  subject: 'synthetic-subject', refreshToken: oldToken,
  scopes: ['resource.invoke', 'chatgpt.tokens.use.direct', 'offline_access'] })
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-refresh-key', alg: 'RS256' }
const enc = x => Buffer.from(JSON.stringify(x)).toString('base64url')
function jwt(claims = {}, signature = privateKey) {
  const header = enc({ alg: 'RS256', kid: jwk.kid })
  const content = enc({ iss: 'https://auth.openai.com', aud: clientID,
    sub: 'synthetic-subject', iat: Math.floor(now / 1000) - 2,
    exp: Math.floor(now / 1000) + 3600, ...claims })
  return [header, content, sign('RSA-SHA256', Buffer.from(header + '.' + content), signature).toString('base64url')].join('.')
}
const response = (object, status = 200) => ({ status,
  headers: { get: () => 'application/json' },
  body: { async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(object)) } },
})
const payload = (extras = {}) => ({ token_type: 'Bearer',
  access_token: 'synthetic_access_token_new', refresh_token: newerToken,
  id_token: jwt(), expires_in: 3600,
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', ...extras })
function fixture(fields = {}, { status = 200, jwks = { keys: [jwk] } } = {}) {
  const calls = []
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/oauth/token')) return response(payload(fields), status)
    if (url.endsWith('/jwks.json')) return response(jwks)
    throw Error('unexpected_remote_url')
  } }
}
const refresh = (f, record = prior(), signal) => refreshSIWCGrant({
  prior: record, fetchImpl: f.fetchImpl, clock: () => now, signal,
})

test('rotation uses exact issued client, no scope/secret and validates signed account', async () => {
  const f = fixture()
  const result = await refresh(f)
  assert.equal(result.subject, prior().subject)
  assert.equal(result.refreshToken, newerToken)
  assert.equal(result.canUsePlan, true)
  assert.equal(result.expiresAt, now + 3600_000)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].url, 'https://auth.openai.com/api/accounts/oauth/token')
  const body = new URLSearchParams(f.calls[0].init.body)
  assert.deepEqual(Object.fromEntries(body), { grant_type: 'refresh_token',
    client_id: clientID, refresh_token: oldToken, resource: 'https://api.openai.com/v1' })
  assert.equal(f.calls[0].init.redirect, 'error')
  assert.equal(f.calls[0].init.credentials, 'omit')
  assert.equal(f.calls[1].url, 'https://auth.openai.com/.well-known/jwks.json')
})

test('missing issuer/identity/plan scopes/refresher fails without a network request', async () => {
  for (const changed of [{ clientID: 'dynamic_agent_client' }, { subject: '' },
    { issuer: 'https://attacker.test' }, { refreshToken: '' },
    { scopes: ['resource.invoke'] }]) {
    const f = fixture()
    await assert.rejects(refresh(f, { ...prior(), ...changed }), /siwc_refresh_options_invalid/)
    assert.equal(f.calls.length, 0)
  }
})

test('bad signature, audience, subject, expiry and unknown key refuse rotation', async () => {
  const forgedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  for (const [data, opts] of [
    [{ id_token: jwt({}, forgedKey) }, {}],
    [{ id_token: jwt({ aud: 'some-other-client' }) }, {}],
    [{ id_token: jwt({ sub: 'different-account' }) }, {}],
    [{ id_token: jwt({ exp: Math.floor(now / 1000) - 10 }) }, {}],
    [{}, { jwks: { keys: [] } }],
  ]) await assert.rejects(refresh(fixture(data, opts)), /siwc_identity_|siwc_refresh_account_changed/)
})

test('scope downgrades, reused refresh token and missing signed ID token fail closed', async () => {
  for (const data of [
    { scope: 'resource.invoke offline_access' },
    { scope: 'resource.invoke chatgpt.tokens.use.direct' },
    { refresh_token: oldToken },
    { id_token: '' },
  ]) {
    const f = fixture(data)
    await assert.rejects(refresh(f), /siwc_refresh_scope_lost|siwc_refresh_response_invalid/)
  }
})

test('401 and injected transport errors do not include provider response or secrets', async () => {
  await assert.rejects(refresh(fixture({}, { status: 401 })),
    e => e.code === 'siwc_refresh_refused' && !String(e).includes(oldToken))
  const unsafe = { fetchImpl: async () => { throw Error('secret:' + oldToken) } }
  await assert.rejects(refresh(unsafe),
    e => e.code === 'siwc_refresh_unavailable' && !String(e).includes(oldToken))
})

test('two refresh attempts for one registration never consume the same rotating token', async () => {
  let deliver
  let reached
  const waiting = new Promise(resolve => { deliver = resolve })
  const started = new Promise(resolve => { reached = resolve })
  const f = { fetchImpl: async (url, init) => {
    if (url.endsWith('/oauth/token')) {
      reached()
      await waiting
      return response(payload())
    }
    return response({ keys: [jwk] })
  } }
  const first = refresh(f)
  await started
  await assert.rejects(refresh(f), /siwc_refresh_already_running/)
  deliver()
  assert.equal((await first).refreshToken, newerToken)
})
