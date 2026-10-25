import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export class BridgeError extends Error {
  constructor(code, status = 502) {
    super(code)
    this.code = code
    this.status = status
  }
}

// The existing CoS control API owns the send outbox, its delivery proof, and its event journal.
// This client never scrapes credentials from Chromium or invents a delivery acknowledgement.
export class CoSControl {
  constructor({ directory, fetcher = fetch }) {
    if (!path.isAbsolute(directory)) throw new BridgeError('control_directory_must_be_absolute', 400)
    this.directory = directory
    this.fetcher = fetcher
  }

  async connect() {
    const [raw, token] = await Promise.all([
      readFile(path.join(this.directory, 'endpoint.json'), 'utf8'),
      readFile(path.join(this.directory, 'token'), 'utf8'),
    ]).catch(() => { throw new BridgeError('cos_runtime_unavailable', 503) })
    let endpoint
    try { endpoint = JSON.parse(raw) } catch { throw new BridgeError('invalid_cos_endpoint', 503) }
    if (endpoint.protocol !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
      !/^[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new BridgeError('invalid_cos_endpoint', 503)
    this.endpointPid = endpoint.pid
    this.base = `http://127.0.0.1:${endpoint.port}`
    this.token = token.trim()
    const health = await this.json('GET', '/v1/health')
    if (health.protocol !== 1 || !health.ok || !health.actions?.enabled) throw new BridgeError('cos_actions_unavailable', 503)
  }

  async request(method, route, body, { signal, stream = false } = {}) {
    if (!this.base) throw new BridgeError('cos_runtime_not_connected', 503)
    const response = await this.fetcher(this.base + route, {
      method, redirect: 'error', signal: signal ?? AbortSignal.timeout(stream ? 33 * 60_000 : 15000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => { throw new BridgeError('cos_transport_unavailable', 503) })
    if (!response.ok) {
      let code = 'cos_http_' + response.status
      try { const error = await response.json(); if (typeof error.error === 'string') code = error.error } catch { /* bounded upstream failure */ }
      throw new BridgeError(code, response.status)
    }
    return response
  }

  async json(method, route, body) {
    const response = await this.request(method, route, body)
    return response.json()
  }

  async hasSession(id) {
    try { await this.json('GET', `/v1/sessions/${id}`); return true }
    catch (error) { if (error instanceof BridgeError && error.status === 404) return false; throw error }
  }

  /** Categorical, private local readiness hint. ChatGPT may still reject a stale cookie. */
  async readiness() {
    const state = await this.json('GET', '/v1/provider/readiness')
    if (!state || !['present', 'absent', 'unknown'].includes(state.sessionCookie) ||
        !['connected', 'disconnected'].includes(state.extension) ||
        typeof state.paired !== 'boolean' || typeof state.canAttempt !== 'boolean') {
      throw new BridgeError('cos_provider_readiness_invalid', 503)
    }
    return state
  }

  async assertReady() {
    const state = await this.readiness()
    if (state.sessionCookie !== 'present') throw new BridgeError(
      state.sessionCookie === 'absent' ? 'chatgpt_sign_in_required' : 'chatgpt_session_unobserved', 503)
    if (!state.paired) throw new BridgeError('cos_companion_unpaired', 503)
    if (state.extension !== 'connected' || !state.canAttempt) {
      throw new BridgeError('cos_companion_not_connected', 503)
    }
  }

  async send(body) {
    const result = await this.json('POST', '/v1/inputs', body)
    if (!result?.input || !['sent', 'pending'].includes(result.input.delivery)) {
      throw new BridgeError('cos_delivery_unconfirmed', 409)
    }
    return result.input
  }

  /** Exact-turn stop; CoS itself rechecks that this is still the active turn. */
  async stop(sessionID, turnId) {
    return this.json('POST', `/v1/sessions/${sessionID}/stop`, { turnId })
  }

  /** CoS refuses cancellation once Send may have reached ChatGPT. */
  async cancelInput(inputID) {
    return this.json('POST', `/v1/inputs/${inputID}/cancel`, {})
  }

  async *events(sessionID, { from = 0, signal } = {}) {
    let cursor = from
    // CoS ends a healthy SSE stream after 30 minutes. Reopen by its recorded sequence cursor,
    // never repeat the already admitted POST /inputs or claim a turn is complete on socket EOF.
    for (let renewal = 0; renewal < 8; renewal++) {
      let response
      // A new chat may be in the durable outbox before its recorder is queryable.
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          response = await this.request('GET', `/v1/sessions/${sessionID}/events/stream?from=${cursor}&full=1`, undefined, { signal, stream: true })
          break
        } catch (error) {
          if (!(error instanceof BridgeError) || error.status !== 404 || attempt === 59) throw error
          await delay(500, undefined, { signal }).catch(() => { throw new BridgeError('cos_stream_aborted', 499) })
        }
      }
      if (!response.body) throw new BridgeError('cos_stream_missing', 502)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let rotated = false
      try {
        readStream: for (;;) {
          const { done, value } = await reader.read()
          if (done) throw new BridgeError('cos_stream_ended_without_terminal', 502)
          buffer += decoder.decode(value, { stream: true })
          if (buffer.length > 1_048_576) throw new BridgeError('cos_frame_overflow', 502)
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index).replace(/\r/g, '')
            buffer = buffer.slice(index + 2)
            const lines = frame.split('\n')
            const kind = lines.find(line => line.startsWith('event: '))?.slice(7)
            const payload = lines.find(line => line.startsWith('data: '))?.slice(6)
            if (!payload) continue
            let event
            try { event = JSON.parse(payload) } catch { throw new BridgeError('cos_event_invalid', 502) }
            if (kind === 'end') {
              if (event.reason === 'max_duration') { rotated = true; break readStream }
              throw new BridgeError('cos_stream_ended_' + (typeof event.reason === 'string' ? event.reason : 'unknown'), 503)
            }
            if (!Number.isInteger(event.seq) || event.seq < cursor) continue
            cursor = event.seq + 1
            yield event
          }
        }
      } finally { await reader.cancel().catch(() => undefined) }
      if (!rotated) throw new BridgeError('cos_stream_ended_without_terminal', 502)
    }
    throw new BridgeError('cos_stream_renewal_limit', 503)
  }
}
