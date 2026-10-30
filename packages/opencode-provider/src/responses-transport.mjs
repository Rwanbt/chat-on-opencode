// Transport boundary only. No OAuth, discovery, account access or OpenCode tool execution.
import { createResponsesRequest, collectResponsesSSE, ResponsesContractError } from './responses-adapter.mjs'

export class ResponsesTransportError extends Error {
  constructor(code) { super(code); this.name = 'ResponsesTransportError'; this.code = code }
}
const fail = code => { throw new ResponsesTransportError(code) }
const ID = /^[A-Za-z0-9_.:-]{6,256}$/
const OFFICIAL = 'https://api.openai.com/v1/responses'
const active = new Set()

function target(endpoint, allowLoopbackTest) {
  if (endpoint === OFFICIAL) return endpoint
  // Deliberate test-only escape hatch: no DNS, wildcard interface, arbitrary path or redirect.
  if (!allowLoopbackTest || typeof endpoint !== 'string' || endpoint.length > 128) fail('endpoint_not_allowed')
  let url
  try { url = new URL(endpoint) } catch { fail('endpoint_not_allowed') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) ||
      +url.port < 1 || +url.port > 65535 || url.pathname !== '/v1/responses' ||
      url.username || url.password || url.search || url.hash) fail('endpoint_not_allowed')
  return url.href
}

// Provenance belongs to the caller; a token supplier must attest the *exact* model it authorized.
// This is not proof that an account owns that model or that OAuth permission was granted.
export async function sendResponses(request, {
  sessionID, messageID, model, getToken, fetchImpl = globalThis.fetch,
  endpoint = OFFICIAL, allowLoopbackTest = false, signal, timeoutMs = 60_000,
} = {}) {
  if (!ID.test(sessionID ?? '') || !ID.test(messageID ?? '') ||
      typeof getToken !== 'function' || typeof fetchImpl !== 'function') fail('transport_identity_required')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) fail('invalid_timeout')
  const url = target(endpoint, allowLoopbackTest)
  const { body, allowedTools } = createResponsesRequest(request, { model })
  // Until a real OpenCode tool approval/result bridge exists, do not advertise or accept tools.
  if (allowedTools.size || body.input.some(item => item.type === 'additional_tools' || item.type === 'function_call' || item.type === 'function_call_output')) {
    fail('native_tool_approval_unavailable')
  }
  // One native message must not race two model selections or two token issuances.
  const identity = JSON.stringify([sessionID, messageID])
  if (active.has(identity)) fail('turn_already_active')
  active.add(identity)
  // AbortSignal.timeout uses an unref'd timer: a pending token supplier can
  // leave no ref'd handles and Node exits before timeout/cancellation settles.
  const timeout = new AbortController()
  const timeoutHandle = setTimeout(() => timeout.abort(), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let response
  try {
    if (combined.aborted) fail('response_aborted')
    const tokenRequest = Promise.resolve().then(() => getToken({ sessionID, messageID, model, signal: combined }))
    let rejectOnAbort
    const aborted = new Promise((_, reject) => { rejectOnAbort = () => reject(new ResponsesTransportError('response_aborted')) })
    combined.addEventListener('abort', rejectOnAbort, { once: true })
    let credential
    try { credential = await Promise.race([tokenRequest, aborted]) } finally { combined.removeEventListener('abort', rejectOnAbort) }
    if (combined.aborted) fail('response_aborted')
    if (!credential || credential.model !== model || typeof credential.token !== 'string' ||
        credential.token.length < 8 || credential.token.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(credential.token)) fail('token_model_not_authorized')
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${credential.token}`, Accept: 'text/event-stream',
          'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify(body), signal: combined,
      })
    } catch { fail(combined.aborted ? 'response_aborted' : 'responses_network_failed') }
    if (combined.aborted) fail('response_aborted')
    if (response?.status !== 200) fail('responses_http_rejected')
    if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers?.get?.('content-type') ?? '')) fail('responses_content_type_invalid')
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') fail('responses_stream_required')
    const completed = await collectResponsesSSE(response.body, { signal: combined, expectedModel: model, allowedTools: new Set() })
    if (combined.aborted) fail('response_aborted')
    return { ...completed, sessionID, messageID, model }
  } catch (error) {
    // Never forward credential-bearing errors, server bodies, headers, or upstream URLs to callers.
    if (combined.aborted) fail('response_aborted')
    if (error instanceof ResponsesContractError || error instanceof ResponsesTransportError) throw error
    fail('responses_transport_failed')
  } finally {
    clearTimeout(timeoutHandle)
    try { await response?.body?.cancel?.() } catch { /* stream may already be consumed/locked */ }
    active.delete(identity)
  }
}
