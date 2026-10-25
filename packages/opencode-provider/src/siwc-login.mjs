// The sign-in *request* and local callback boundary. No browser is opened and
// no token is exchanged, verified, persisted or considered authorized here.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const AUTH = 'https://auth.openai.com/api/accounts/authorize'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const HOST = /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{5,256}$/
const AUTH_CODE = /^[\x21-\x7e]{8,8192}$/
const CALLBACK = '/auth/callback'

export class SIWCLoginError extends Error {
  constructor(code) { super(code); this.name = 'SIWCLoginError'; this.code = code }
}
const fail = code => { throw new SIWCLoginError(code) }
const fresh = () => randomBytes(32).toString('base64url')
const match = (actual, expected) => {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(actual, 'utf8'), b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function startSIWCLogin({
  hostID, clientID, idTokenHint, loginHint, timeoutMs = 180000, signal,
  agentName = 'Chat On OpenCode',
} = {}) {
  if (!HOST.test(hostID ?? '') || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 || timeoutMs > 300000 ||
      (clientID !== undefined && !CLIENT.test(clientID)) ||
      (clientID === undefined && (typeof agentName !== 'string' || agentName !== 'Chat On OpenCode')) ||
      (clientID === undefined && (idTokenHint !== undefined || loginHint !== undefined)) ||
      (idTokenHint !== undefined && (typeof idTokenHint !== 'string' || idTokenHint.length > 8192 ||
        /[\x00-\x1f\x7f]/.test(idTokenHint))) ||
      (loginHint !== undefined && (typeof loginHint !== 'string' || loginHint.length > 256 ||
        /[\x00-\x1f\x7f]/.test(loginHint)))) fail('siwc_login_options_invalid')
  if (signal?.aborted) fail('siwc_login_aborted')
  const verifier = fresh(), state = fresh(), nonce = fresh()
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  let settled = false, resolveResult, rejectResult, timer
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
  // Attach a rejection consumer until the caller awaits result: a cancellation
  // arriving before the browser interaction must never become unhandled.
  result.catch(() => {})
  const server = createServer((request, response) => {
    const refuse = () => { response.writeHead(400, { 'Cache-Control': 'no-store' }); response.end() }
    if (settled || request.method !== 'GET' || !request.url ||
        !request.url.startsWith(CALLBACK + '?') || request.url.length > 8192 ||
        request.headers.host !== `127.0.0.1:${server.address()?.port}`) return refuse()
    let url
    try { url = new URL(request.url, 'http://127.0.0.1') } catch { return refuse() }
    if (url.pathname !== CALLBACK || url.hash) return refuse()
    const allowed = new Set(['state', 'code', 'client_id', 'scope', 'error', 'error_description'])
    if ([...url.searchParams.keys()].some(key =>
      !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) return refuse()
    // Invalid unsolicited callbacks must not consume a legitimate sign-in.
    if (!match(url.searchParams.get('state'), state)) return refuse()
    if (url.searchParams.has('error')) {
      response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end()
      return settle(new SIWCLoginError('siwc_login_denied'))
    }
    const code = url.searchParams.get('code'), issued = url.searchParams.get('client_id')
    if (typeof code !== 'string' || !AUTH_CODE.test(code) ||
        (clientID === undefined && (!issued || !CLIENT.test(issued))) ||
        (clientID !== undefined && issued !== null && issued !== clientID)) return refuse()
    response.writeHead(204, { 'Cache-Control': 'no-store' }); response.end()
    settle(null, { code, clientID: clientID ?? issued, verifier, nonce,
      redirectURI: `http://127.0.0.1:${server.address()?.port}${CALLBACK}`,
      resource: RESOURCE })
  })
  function settle(error, value) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    server.close()
    if (error) rejectResult(error)
    else resolveResult(value)
  }
  const onAbort = () => settle(new SIWCLoginError('siwc_login_aborted'))
  server.on('error', () => settle(new SIWCLoginError('siwc_callback_unavailable')))
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
      server.listen(0, '127.0.0.1')
    })
  } catch {
    server.close()
    fail('siwc_callback_unavailable')
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
    fail('siwc_login_aborted')
  }
  if (!settled) timer = setTimeout(() => settle(new SIWCLoginError('siwc_login_timed_out')), timeoutMs)
  const redirectURI = `http://127.0.0.1:${server.address()?.port}${CALLBACK}`
  const authorize = new URL(AUTH)
  const args = {
    client_id: clientID ?? 'dynamic_agent_client',
    response_type: 'code', redirect_uri: redirectURI, resource: RESOURCE,
    scope: SCOPES, state, nonce, code_challenge_method: 'S256',
    code_challenge: challenge, ext_agent_host_id: hostID,
  }
  if (clientID === undefined) args.agent_name_hint = agentName
  else {
    if (idTokenHint) args.id_token_hint = idTokenHint
    if (loginHint) args.login_hint = loginHint
  }
  for (const [key, value] of Object.entries(args)) authorize.searchParams.set(key, value)
  return { authorizeURL: authorize.href, result, cancel: onAbort }
}
