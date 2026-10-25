import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { startSIWCLogin, SIWCLoginError } from '../src/siwc-login.mjs'

const hostID = 'urn:uuid:12345678-1234-4567-8123-123456789abc'
const issued = 'oaiapp_synthetic_client_id'
const opts = { hostID, timeoutMs: 2000 }
const code = 'synthetic_safe_authorization_code'
const begin = async options => {
  const login = await startSIWCLogin({ ...opts, ...options })
  const auth = new URL(login.authorizeURL)
  const callback = auth.searchParams.get('redirect_uri')
  return { ...login, auth, callback, state: auth.searchParams.get('state') }
}
const query = (url, data) => {
  const link = new URL(url)
  for (const [key, value] of Object.entries(data)) link.searchParams.set(key, value)
  return link.href
}
const receive = async (url, init) => fetch(url, { redirect: 'manual', ...init })
async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => error instanceof SIWCLoginError &&
    error.code === code && error.message === code)
}

test('fresh dynamic-client login binds loopback URI, state, nonce, PKCE and host without opening a browser', async () => {
  const a = await begin()
  const b = await begin()
  try {
    assert.equal(a.auth.origin, 'https://auth.openai.com')
    assert.equal(a.auth.pathname, '/api/accounts/authorize')
    assert.equal(a.auth.searchParams.get('client_id'), 'dynamic_agent_client')
    assert.equal(a.auth.searchParams.get('agent_name_hint'), 'Chat On OpenCode')
    assert.equal(a.auth.searchParams.get('ext_agent_host_id'), hostID)
    assert.equal(a.auth.searchParams.get('response_type'), 'code')
    assert.equal(a.auth.searchParams.get('resource'), 'https://api.openai.com/v1')
    assert.equal(a.auth.searchParams.get('scope'),
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
    assert.equal(a.auth.searchParams.get('code_challenge_method'), 'S256')
    assert.match(a.state, /^[A-Za-z0-9_-]{43}$/)
    assert.match(a.auth.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/)
    assert.match(a.auth.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
    assert.match(a.callback, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    assert.notEqual(a.state, b.state)
    assert.notEqual(a.auth.searchParams.get('nonce'), b.auth.searchParams.get('nonce'))
  } finally {
    a.cancel()
    b.cancel()
    await rejectsCode(a.result, 'siwc_login_aborted')
    await rejectsCode(b.result, 'siwc_login_aborted')
  }
})

test('first-time callback accepts exact state and issued client, once; verifier and nonce remain private', async () => {
  const a = await begin()
  const url = query(a.callback, { code, state: a.state, client_id: issued })
  const res = await receive(url)
  assert.equal(res.status, 204)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const exchanged = await a.result
  assert.equal(exchanged.clientID, issued)
  assert.equal(exchanged.code, code)
  assert.equal(exchanged.redirectURI, a.callback)
  assert.equal(exchanged.resource, 'https://api.openai.com/v1')
  assert.match(exchanged.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(a.auth.searchParams.get('code_challenge'),
    createHash('sha256').update(exchanged.verifier).digest('base64url'))
  assert.equal(exchanged.nonce, a.auth.searchParams.get('nonce'))
  await assert.rejects(() => receive(url), TypeError)
})

test('unsolicited wrong-state, duplicate-state, invalid host, extra parameters and wrong path do not consume the attempt', async () => {
  const a = await begin()
  try {
    const wrong = await receive(query(a.callback, { state: 'wrong', code, client_id: issued }))
    assert.equal(wrong.status, 400)
    const duplicate = await receive(query(a.callback, { state: a.state, code, client_id: issued }) + '&state=again')
    assert.equal(duplicate.status, 400)
    const extra = await receive(query(a.callback, { state: a.state, code, client_id: issued, x: '1' }))
    assert.equal(extra.status, 400)
    const path = await receive(a.callback.replace('/auth/callback', '/callback') + '?state=' + a.state)
    assert.equal(path.status, 400)
    // Node's Fetch normalizes Host automatically; use the raw HTTP client for
    // the hostile authority value that an injected local callback might carry.
    const raw = new URL(query(a.callback, { state: a.state, code, client_id: issued }))
    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: raw.port,
        path: raw.pathname + raw.search, method: 'GET',
        headers: { Host: 'evil.example:1234' } }, res => {
        res.resume()
        res.once('end', () => resolve(res.statusCode))
      })
      req.once('error', reject)
      req.end()
    })
    assert.equal(hostStatus, 400)
    const good = await receive(query(a.callback, { state: a.state, code, client_id: issued }))
    assert.equal(good.status, 204)
    assert.equal((await a.result).clientID, issued)
  } finally { a.cancel() }
})

test('reauthorization reuses the verified dynamic client; never accepts a substituted client identity', async () => {
  const a = await begin({ clientID: issued, idTokenHint: 'synthetic.id.token', loginHint: 'fixture@example.invalid' })
  try {
    assert.equal(a.auth.searchParams.get('client_id'), issued)
    assert.equal(a.auth.searchParams.get('agent_name_hint'), null)
    assert.equal(a.auth.searchParams.get('id_token_hint'), 'synthetic.id.token')
    assert.equal(a.auth.searchParams.get('login_hint'), 'fixture@example.invalid')
    const wrong = await receive(query(a.callback, {
      state: a.state, code, client_id: 'oaiapp_other_client_id',
    }))
    assert.equal(wrong.status, 400)
    const res = await receive(query(a.callback, { state: a.state, code }))
    assert.equal(res.status, 204)
    assert.equal((await a.result).clientID, issued)
  } finally { a.cancel() }
})

test('explicit denial consumes only matching-state login with sanitized failure', async () => {
  const a = await begin()
  const bad = await receive(query(a.callback, { state: 'incorrect', error: 'access_denied' }))
  assert.equal(bad.status, 400)
  const valid = await receive(query(a.callback, { state: a.state, error: 'access_denied',
    error_description: 'SECRET_WE_SHOULD_NOT_EXPOSE' }))
  assert.equal(valid.status, 204)
  await rejectsCode(a.result, 'siwc_login_denied')
})

test('aborts and deadlines close callback listener and reject without cookies, secrets or account access', async () => {
  const controller = new AbortController()
  const a = await begin({ signal: controller.signal })
  controller.abort()
  await rejectsCode(a.result, 'siwc_login_aborted')
  await assert.rejects(() => receive(a.callback), TypeError)
  const b = await begin({ timeoutMs: 20 })
  await rejectsCode(b.result, 'siwc_login_timed_out')
  await assert.rejects(() => receive(b.callback), TypeError)
})

test('malformed host, client and hints are rejected before opening a callback listener', async () => {
  for (const value of [
    { hostID: 'https://attacker.invalid' },
    { clientID: 'dynamic_agent_client' },
    { idTokenHint: 'never from an arbitrary new client' },
    { loginHint: 'new@example.invalid' },
    { agentName: 'Not the actual app' },
    { timeoutMs: -10 },
    { clientID: issued, idTokenHint: 'x\nBearer\rSecret' },
  ]) {
    await rejectsCode(startSIWCLogin({ ...opts, ...value }), 'siwc_login_options_invalid')
  }
  const controller = new AbortController()
  controller.abort()
  await rejectsCode(startSIWCLogin({ ...opts, signal: controller.signal }), 'siwc_login_aborted')
})
