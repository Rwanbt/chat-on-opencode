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

  async connect({ expectedPid } = {}) {
    const [raw, token] = await Promise.all([
      readFile(path.join(this.directory, 'endpoint.json'), 'utf8'),
      readFile(path.join(this.directory, 'token'), 'utf8'),
    ]).catch(() => { throw new BridgeError('cos_runtime_unavailable', 503) })
    let endpoint
    try { endpoint = JSON.parse(raw) } catch { throw new BridgeError('invalid_cos_endpoint', 503) }
    if (endpoint.protocol !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
      !/^[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new BridgeError('invalid_cos_endpoint', 503)
    // Validate endpoint ownership BEFORE sending its token or reaching its port.
    // A stale/foreign endpoint in an otherwise approved profile is never a broker.
    if (expectedPid !== undefined && (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || endpoint.pid !== expectedPid)) {
      throw new BridgeError('runtime_endpoint_pid_mismatch', 503)
    }
    this.endpointPid = endpoint.pid
    this.base = `http://127.0.0.1:${endpoint.port}`
    this.token = token.trim()
    const health = await this.json('GET', '/v1/health')
    if (health.protocol !== 1 || !health.ok || !health.actions?.enabled) throw new BridgeError('cos_actions_unavailable', 503)
    // A prior CoS binary can expose protocol 1 but still lack the provider-only
    // readiness or stream routes. Reject before accepting an OpenCode prompt.
    const requiredReads = ['/v1/provider/readiness', '/v1/sessions/{id}/events/stream']
    const requiredActions = ['POST /v1/inputs', 'POST /v1/sessions/{id}/stop', 'POST /v1/inputs/{id}/cancel']
    if (!Array.isArray(health.routes) || !Array.isArray(health.actions.routes) ||
        !requiredReads.every(route => health.routes.includes(route)) ||
        !requiredActions.every(route => health.actions.routes.includes(route))) {
      throw new BridgeError('cos_provider_runtime_incompatible', 503)
    }
  }

  async request(method, route, body, { signal, stream = false } = {}) {
    if (!this.base) throw new BridgeError('cos_runtime_not_connected', 503)
    const response = await this.fetcher(this.base + route, {
      method, redirect: 'error', signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(stream ? 33 * 60_000 : 15000)])
        : AbortSignal.timeout(stream ? 33 * 60_000 : 15000),
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => { throw new BridgeError(signal?.aborted ? 'opencode_turn_cancelled' : 'cos_transport_unavailable', signal?.aborted ? 499 : 503) })
    if (!response.ok) {
      let code = 'cos_http_' + response.status
      try { const error = await response.json(); if (typeof error.error === 'string') code = error.error } catch { /* bounded upstream failure */ }
      throw new BridgeError(code, response.status)
    }
    return response
  }

  async json(method, route, body, options) {
    const response = await this.request(method, route, body, options)
    return response.json()
  }

  async hasSession(id, { signal } = {}) {
    try { await this.json('GET', `/v1/sessions/${id}`, undefined, { signal }); return true }
    catch (error) { if (error instanceof BridgeError && error.status === 404) return false; throw error }
  }

  /** Categorical, private local readiness hint. ChatGPT may still reject a stale cookie. */
  async readiness({ signal } = {}) {
    const state = await this.json('GET', '/v1/provider/readiness', undefined, { signal })
    if (!state || !['present', 'absent', 'unknown'].includes(state.sessionCookie) ||
        !['connected', 'disconnected'].includes(state.extension) ||
        typeof state.paired !== 'boolean' || typeof state.canAttempt !== 'boolean') {
      throw new BridgeError('cos_provider_readiness_invalid', 503)
    }
    return state
  }

  async assertReady({ signal } = {}) {
    const state = await this.readiness({ signal })
    if (state.sessionCookie !== 'present') throw new BridgeError(
      state.sessionCookie === 'absent' ? 'chatgpt_sign_in_required' : 'chatgpt_session_unobserved', 503)
    if (!state.paired) throw new BridgeError('cos_companion_unpaired', 503)
    if (state.extension !== 'connected' || !state.canAttempt) {
      throw new BridgeError('cos_companion_not_connected', 503)
    }
  }

  async send(body, { signal } = {}) {
    const result = await this.json('POST', '/v1/inputs', body, { signal })
    if (!result?.input || !['sent', 'pending'].includes(result.input.delivery)) {
      throw new BridgeError('cos_delivery_unconfirmed', 409)
    }
    return result.input
  }

  /** Recover only one already-owned input from CoS's durable outbox.
   * The bounded read never stores or logs prompt text in the provider. */
  async readInput(id, { signal } = {}) {
    const page = await this.json('GET', '/v1/inputs?limit=500', undefined, { signal })
    if (!Array.isArray(page?.inputs) || page.inputs.length > 500) {
      throw new BridgeError('cos_outbox_unavailable', 503)
    }
    return page.inputs.find(input => input?.id === id) ?? null
  }

  /** Exact-turn stop; CoS itself rechecks that this is still the active turn. */
  async stop(sessionID, turnId, { signal } = {}) {
    return this.json('POST', `/v1/sessions/${sessionID}/stop`, { turnId }, { signal })
  }

  /** CoS refuses cancellation once Send may have reached ChatGPT. */
  async cancelInput(inputID, { signal } = {}) {
    return this.json('POST', `/v1/inputs/${inputID}/cancel`, {}, { signal })
  }

  async *events(sessionID, { from = 0, signal } = {}) {
    let cursor = from
    let consecutivePrematureEOF = 0
    // CoS ends a healthy SSE stream after 30 minutes. Reopen by its recorded sequence cursor,
    // never repeat the already admitted POST /inputs or claim a turn is complete on socket EOF.
    for (let renewal = 0; renewal < 8; renewal++) {
      let response
      // A new chat may be in the durable outbox before its recorder is queryable.
      // A transient GET failure is read-only: retry this cursor, NEVER the
      // already-admitted POST /inputs. Bound consecutive transport failures.
      let transportFailures = 0
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          response = await this.request('GET', `/v1/sessions/${sessionID}/events/stream?from=${cursor}&full=1`, undefined, { signal, stream: true })
          break
        } catch (error) {
          if (error instanceof BridgeError && error.code === 'cos_transport_unavailable' &&
              ++transportFailures <= 2 && attempt < 59) {
            await delay(150, undefined, { signal }).catch(() => { throw new BridgeError('cos_stream_aborted', 499) })
            continue
          }
          if (!(error instanceof BridgeError) || error.status !== 404 || attempt === 59) throw error
          await delay(500, undefined, { signal }).catch(() => { throw new BridgeError('cos_stream_aborted', 499) })
        }
      }
      if (!response.body) throw new BridgeError('cos_stream_missing', 502)
      const reader = response.body.getReader()
      // AbortSignal attached to fetch does not guarantee that a custom/bridged
      // ReadableStream will interrupt an already pending reader.read().
      const onAbort = () => { void reader.cancel('turn_cancelled').catch(() => undefined) }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      const decoder = new TextDecoder()
      let buffer = ''
      let afterCR = false
      let rotated = false
      try {
        readStream: for (;;) {
          let packet
          try { packet = await reader.read() }
          catch (error) {
            if (signal?.aborted) throw new BridgeError('cos_stream_aborted', 499)
            // Network-level reader failure after a partial response: resume
            // from the last durable event sequence, never replay the input.
            // No malformed SSE or sequence error is swallowed by this catch.
            if (++consecutivePrematureEOF > 2) throw new BridgeError('cos_stream_transport_lost', 503)
            rotated = true
            break readStream
          }
          const { done, value } = packet
          if (signal?.aborted) throw new BridgeError('cos_stream_aborted', 499)
          if (done) {
            // The browser bridge can close a valid SSE transport without an
            // end frame. Never replay POST /inputs or declare completion:
            // reopen only the read stream from the last verified journal seq.
            if (++consecutivePrematureEOF > 2) throw new BridgeError('cos_stream_ended_without_terminal', 502)
            rotated = true
            break readStream
          }
          // SSE accepts LF, CRLF and bare CR. Normalize incrementally: a CRLF
          // split across network chunks must become ONE line break, not two.
          // This also preserves Unicode characters split by TextDecoder.
          const decoded = decoder.decode(value, { stream: true })
          let normalized = ''
          for (const char of decoded) {
            if (afterCR && char === '\n') { afterCR = false; continue }
            afterCR = char === '\r'
            normalized += char === '\r' ? '\n' : char
          }
          buffer += normalized
          if (buffer.length > 1_048_576) throw new BridgeError('cos_frame_overflow', 502)
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index).replace(/\r/g, '')
            buffer = buffer.slice(index + 2)
            const lines = frame.split('\n')
            const kind = lines.find(line => line.startsWith('event: '))?.slice(7)
            // SSE permits multiple data fields per event; each contributes a
            // newline. Dropping later fields corrupts turn identity/sequence.
            const payload = lines.filter(line => line === 'data:' || line.startsWith('data: '))
              .map(line => line === 'data:' ? '' : line.slice(6)).join('\n')
            if (!payload) continue
            let event
            try { event = JSON.parse(payload) } catch { throw new BridgeError('cos_event_invalid', 502) }
            if (kind === 'end') {
              if (event.reason === 'max_duration') { rotated = true; break readStream }
              throw new BridgeError('cos_stream_ended_' + (typeof event.reason === 'string' ? event.reason : 'unknown'), 503)
            }
            if (!Number.isSafeInteger(event.seq) || event.seq < cursor) continue
            // Full provider journals are contiguous. A skipped assistant
            // revision can otherwise be mistaken for a complete response
            // when a later turn_end arrives. Refuse unverifiable history:
            // the native caller can safely retry its exact durable input.
            if (event.seq !== Math.max(1, cursor)) {
              // CoS canonical events are revisions: the durable journal can
              // omit superseded seq values. Read-only backfill establishes
              // whether the SSE stream skipped a still-visible event; never
              // replay POST /inputs or silently accept a real stream hole.
              const page = await this.json('GET', `/v1/sessions/${sessionID}/events?from=${cursor}&limit=100`, undefined, { signal })
              if (!Array.isArray(page?.events) || page.events.length === 0 ||
                  Math.min(...page.events.map(row => row.seq)) !== event.seq) {
                throw new BridgeError('cos_event_sequence_gap', 502)
              }
            }
            cursor = event.seq + 1
            consecutivePrematureEOF = 0
            yield event
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
        // A rotation (max_duration) must advance to the next journal cursor
        // even if the old stream's cancellation handshake never settles.
        // Likewise, a completed turn must release the native HTTP response
        // without waiting on a now-obsolete upstream reader.
        try { void reader.cancel().catch(() => undefined) }
        catch { /* cleanup is best-effort after the stream is no longer owned */ }
      }
      if (!rotated) throw new BridgeError('cos_stream_ended_without_terminal', 502)
    }
    throw new BridgeError('cos_stream_renewal_limit', 503)
  }
}
