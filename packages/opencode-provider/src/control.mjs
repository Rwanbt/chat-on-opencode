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

  async send(body) {
    const result = await this.json('POST', '/v1/inputs', body)
    if (!result?.input || !['sent', 'pending'].includes(result.input.delivery)) {
      throw new BridgeError('cos_delivery_unconfirmed', 409)
    }
    return result.input
  }

  async *events(sessionID, { from = 0, signal } = {}) {
    // The CoS outbox admits a *new* chat before the recording has become queryable.
    // Retrying the read is safe; repeating POST /inputs is not.
    let response
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        response = await this.request('GET', `/v1/sessions/${sessionID}/events/stream?from=${from}`, undefined, { signal, stream: true })
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
    let lastSeq = from - 1
    try {
      for (;;) {
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
          if (kind === 'end') throw new BridgeError('cos_stream_expired', 503)
          const payload = lines.find(line => line.startsWith('data: '))?.slice(6)
          if (!payload) continue
          let event
          try { event = JSON.parse(payload) } catch { throw new BridgeError('cos_event_invalid', 502) }
          if (!Number.isInteger(event.seq) || event.seq <= lastSeq) continue
          lastSeq = event.seq
          yield event
        }
      }
    } finally { await reader.cancel().catch(() => undefined) }
  }
}
