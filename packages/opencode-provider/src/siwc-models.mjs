// SIWC catalog boundary: no token discovery, token storage, OAuth or inference.
// A separately authenticated account custodian must attest the selected identity and scopes.
const OFFICIAL = 'https://api.openai.com/v1/models'
const REQUIRED = ['resource.invoke', 'chatgpt.tokens.use.direct']
const ID = /^[A-Za-z0-9._:@-]{3,256}$/
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LIMIT = 1024 * 1024

export class SIWCModelsError extends Error {
  constructor(code) { super(code); this.name = 'SIWCModelsError'; this.code = code }
}
const fail = code => { throw new SIWCModelsError(code) }

function catalogURL(endpoint, allowLoopbackTest) {
  if (endpoint === OFFICIAL) return OFFICIAL
  if (!allowLoopbackTest || typeof endpoint !== 'string' || endpoint.length > 128) fail('catalog_endpoint_forbidden')
  let url
  try { url = new URL(endpoint) } catch { fail('catalog_endpoint_forbidden') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      !url.port || +url.port < 1 || +url.port > 65535 || url.pathname !== '/v1/models' || url.username ||
      url.password || url.search || url.hash) fail('catalog_endpoint_forbidden')
  return url.href
}

function parseCatalog(raw) {
  let data
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
  catch { fail('catalog_response_invalid') }
  if (!data || !Array.isArray(data.models) || data.models.length > 1024) fail('catalog_response_invalid')
  const seen = new Set()
  const visible = []
  for (const candidate of data.models) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
        typeof candidate.visibility !== 'string') fail('catalog_model_invalid')
    if (candidate.visibility !== 'list') continue
    if (typeof candidate.slug !== 'string' || !SLUG.test(candidate.slug) ||
        typeof candidate.display_name !== 'string' ||
        candidate.display_name.length < 1 || candidate.display_name.length > 128 ||
        /[\x00-\x1f\x7f]/.test(candidate.display_name) || seen.has(candidate.slug)) fail('catalog_model_invalid')
    seen.add(candidate.slug)
    visible.push(Object.freeze({ slug: candidate.slug, displayName: candidate.display_name }))
  }
  if (!visible.length) fail('catalog_no_available_models')
  return Object.freeze(visible)
}

// API token and identity are never derived from OpenCode's config, browser cookies, or environment.
export async function listSIWCModels({
  accountID, getToken, fetchImpl = globalThis.fetch, signal,
  timeoutMs = 15_000, endpoint = OFFICIAL, allowLoopbackTest = false,
} = {}) {
  if (typeof accountID !== 'string' || !ID.test(accountID) ||
      typeof getToken !== 'function' || typeof fetchImpl !== 'function') fail('catalog_account_required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('catalog_timeout_invalid')
  const url = catalogURL(endpoint, allowLoopbackTest)
  // Unlike AbortSignal.timeout, a regular bounded timer keeps an unresolved
  // credential supplier from leaving this operation pending as the process exits.
  const timed = new AbortController()
  const deadline = setTimeout(() => timed.abort(), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timed.signal]) : timed.signal
  let response
  try {
    if (combined.aborted) fail('catalog_aborted')
    const pending = Promise.resolve().then(() => getToken({ accountID, signal: combined }))
    let onAbort
    const aborted = new Promise((_, reject) => { onAbort = () => reject(new SIWCModelsError('catalog_aborted')) })
    combined.addEventListener('abort', onAbort, { once: true })
    let grant
    try { grant = await Promise.race([pending, aborted]) }
    finally { combined.removeEventListener('abort', onAbort) }
    if (combined.aborted) fail('catalog_aborted')
    if (!grant || grant.accountID !== accountID || !Array.isArray(grant.scopes) ||
        !REQUIRED.every(scope => grant.scopes.includes(scope)) ||
        !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() + 5000 ||
        typeof grant.token !== 'string' || grant.token.length < 8 || grant.token.length > 4096 ||
        /\s|[\x00-\x1f\x7f]/.test(grant.token)) fail('catalog_grant_invalid')
    try {
      response = await fetchImpl(url, {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${grant.token}`, Accept: 'application/json', 'Cache-Control': 'no-store' },
        signal: combined,
      })
    } catch { fail(combined.aborted ? 'catalog_aborted' : 'catalog_network_failed') }
    if (response?.status !== 200) fail('catalog_http_rejected')
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers?.get?.('content-type') ?? '')) fail('catalog_content_type_invalid')
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail('catalog_stream_invalid')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      if (combined.aborted) fail('catalog_aborted')
      if (!(chunk instanceof Uint8Array) || (size += chunk.byteLength) > LIMIT) fail('catalog_response_too_large')
      chunks.push(chunk)
    }
    if (combined.aborted) fail('catalog_aborted')
    const raw = new Uint8Array(size)
    let index = 0
    for (const chunk of chunks) { raw.set(chunk, index); index += chunk.byteLength }
    return { accountID, models: parseCatalog(raw) }
  } catch (error) {
    if (combined.aborted) fail('catalog_aborted')
    if (error instanceof SIWCModelsError) throw error
    fail('catalog_unavailable')
  } finally {
    clearTimeout(deadline)
    try { await response?.body?.cancel?.() } catch { /* already consumed or locked */ }
  }
}

export function requireSIWCModel(catalog, accountID, slug) {
  if (!catalog || catalog.accountID !== accountID || !Array.isArray(catalog.models) ||
      !SLUG.test(slug ?? '') || !catalog.models.some(model => model.slug === slug)) fail('catalog_model_not_authorized')
  return slug
}
