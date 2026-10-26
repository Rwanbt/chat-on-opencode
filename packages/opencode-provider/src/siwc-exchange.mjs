import { createPublicKey, verify } from 'node:crypto'

const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token'
const JWKS = 'https://auth.openai.com/.well-known/jwks.json'
const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const CLIENT = /^oaiapp_[A-Za-z0-9_-]{5,256}$/
const VALUE = /^[\x21-\x7e]{8,8192}$/
const LIMIT = 128 * 1024
const REQUIRED = ['resource.invoke', 'chatgpt.tokens.use.direct']

export class SIWCExchangeError extends Error {
  constructor(code) { super(code); this.name = 'SIWCExchangeError'; this.code = code }
}
const fail = code => { throw new SIWCExchangeError(code) }
const isString = (v, limit = 8192) => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\x00-\x1f\x7f]/.test(v)
function decodeBase64Json(part) {
  if (typeof part !== 'string' || part.length > LIMIT || !/^[A-Za-z0-9_-]+$/.test(part)) fail('siwc_identity_invalid')
  try {
    const raw = Buffer.from(part, 'base64url')
    if (raw.toString('base64url') !== part) fail('siwc_identity_invalid')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch { fail('siwc_identity_invalid') }
}
async function boundedJSON(response, code) {
  if (response?.status !== 200 || !/^application\/json(?:\s*;|\s*$)/i.test(response.headers?.get?.('content-type') ?? '')) fail(code)
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail(code)
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array) || (size += chunk.byteLength) > LIMIT) fail(code)
      chunks.push(chunk)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))
  } catch { fail(code) }
}
function verifyIdentity(idToken, jwks, { clientID, nonce, clock }) {
  const parts = idToken.split('.')
  if (parts.length !== 3 || parts.some(p => !p || p.length > LIMIT)) fail('siwc_identity_invalid')
  const header = decodeBase64Json(parts[0]), claims = decodeBase64Json(parts[1])
  if (!header || !['RS256','ES256'].includes(header.alg) || !isString(header.kid, 200) || !claims ||
    !Array.isArray(jwks?.keys) || jwks.keys.length > 32) fail('siwc_identity_invalid')
  const key = jwks.keys.find(k => k?.kid === header.kid && k.use !== 'enc' &&
    k.alg !== 'none' && (k.alg === undefined || k.alg === header.alg) &&
    (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256'))
  if (!key) fail('siwc_identity_key_unknown')
  let valid = false
  try {
    const pub = createPublicKey({ key, format: 'jwk' })
    valid = verify(header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256',
      Buffer.from(parts[0] + '.' + parts[1]),
      header.alg === 'RS256' ? pub : { key: pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'))
  } catch { fail('siwc_identity_invalid') }
  if (!valid) fail('siwc_identity_signature_invalid')
  const at = Math.floor(clock() / 1000)
  if (claims.iss !== ISSUER || claims.aud !== clientID || claims.nonce !== nonce ||
    !isString(claims.sub, 512) || !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) || claims.exp <= at - 5 || claims.iat > at + 5 ||
    (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > at + 5))) {
    fail('siwc_identity_claims_invalid')
  }
  return { issuer: claims.iss, subject: claims.sub, email: isString(claims.email, 320) ? claims.email : undefined }
}

/** Exchange the one-shot SIWC callback, verify issuer/JWKS/identity/consent before
 * returning an in-memory grant. No secret is logged, persisted or placed in URLs.
 * Does not mutate OpenCode authentication state. */
export async function exchangeSIWCCode({ callback, fetchImpl = fetch, clock = Date.now,
  signal, selectedSubject } = {}) {
  if (!callback || !CLIENT.test(callback.clientID ?? '') || !VALUE.test(callback.code ?? '') ||
    !VALUE.test(callback.verifier ?? '') || !isString(callback.nonce, 256) ||
    typeof callback.redirectURI !== 'string' || typeof fetchImpl !== 'function' ||
    (callback.resource !== undefined && callback.resource !== RESOURCE) ||
    (selectedSubject !== undefined && !isString(selectedSubject, 512))) fail('siwc_exchange_options_invalid')
  let redirect
  try { redirect = new URL(callback.redirectURI) } catch { fail('siwc_exchange_options_invalid') }
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' ||
    !Number(redirect.port) || redirect.pathname !== '/auth/callback' ||
    redirect.username || redirect.password || redirect.search || redirect.hash) fail('siwc_exchange_options_invalid')
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: callback.code,
    client_id: callback.clientID, code_verifier: callback.verifier,
    redirect_uri: callback.redirectURI, resource: RESOURCE })
  let raw
  try {
    raw = await boundedJSON(await fetchImpl(TOKEN, { method: 'POST', redirect: 'error',
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString() }), 'siwc_token_exchange_refused')
  } catch (e) { if (e instanceof SIWCExchangeError) throw e; fail('siwc_token_exchange_unavailable') }
  if (!raw || raw.token_type !== 'Bearer' ||
    !isString(raw.access_token) || !isString(raw.refresh_token) ||
    !isString(raw.id_token, 20_000) || !Number.isInteger(raw.expires_in) ||
    raw.expires_in <= 0 || raw.expires_in > 86400 || typeof raw.scope !== 'string' ||
    raw.scope.length > 2048) fail('siwc_token_response_invalid')
  let jwks
  try { jwks = await boundedJSON(await fetchImpl(JWKS, { method: 'GET', redirect: 'error',
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json' } }), 'siwc_jwks_unavailable') }
  catch (e) { if (e instanceof SIWCExchangeError) throw e; fail('siwc_jwks_unavailable') }
  const identity = verifyIdentity(raw.id_token, jwks, { clientID: callback.clientID,
    nonce: callback.nonce, clock })
  if (selectedSubject && selectedSubject !== identity.subject) fail('siwc_account_mismatch')
  const scopes = [...new Set(raw.scope.split(/\s+/).filter(Boolean))]
  const canUsePlan = REQUIRED.every(s => scopes.includes(s))
  return { ...identity, clientID: callback.clientID, scopes, canUsePlan,
    accessToken: raw.access_token, refreshToken: raw.refresh_token, idToken: raw.id_token,
    expiresAt: clock() + raw.expires_in * 1000 }
}
