import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { BridgeError } from './control.mjs'

// Deterministic names survive restart; never infer session identity from prompt text.
export function stableUUID(value) {
  const hex = createHash('sha256').update('chat-on-opencode-v1\0' + value).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = '8'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export function requestText(messages, first) {
  if (!Array.isArray(messages) || !messages.length) throw new BridgeError('messages_required', 400)
  for (const part of messages) {
    if (!['system', 'developer', 'user', 'assistant'].includes(part?.role) || typeof part.content !== 'string') {
      throw new BridgeError('unsupported_chat_content', 422)
    }
  }
  const last = messages.at(-1)
  if (last.role !== 'user' || !last.content.trim()) throw new BridgeError('last_message_must_be_user', 422)
  if (!first) return last.content
  const preface = messages.filter(part => part.role === 'system' || part.role === 'developer')
  const history = messages.filter(part => part.role === 'user' || part.role === 'assistant')
  // Only the initial turn carries prior history; later turns use the CoS session itself.
  return [...preface.map(p => `[${p.role} instructions]\n${p.content}\n[/instructions]`),
    ...history.map(p => `[${p.role}]\n${p.content}\n[/${p.role}]`)].join('\n\n')
}

export async function runTurn(control, request, { sessionKey, kind = 'primary', emit, signal } = {}) {
  if (!sessionKey || sessionKey.length > 256 || /[\r\n]/.test(sessionKey)) throw new BridgeError('opencode_session_id_required', 422)
  if (request.tools?.length || request.tool_choice && request.tool_choice !== 'none') throw new BridgeError('native_tool_calls_not_yet_supported', 501)
  if (request.model !== 'chatgpt-default') throw new BridgeError('model_not_configured', 422)
  if (kind !== 'primary') throw new BridgeError('auxiliary_calls_not_yet_supported', 501)
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  const sessionID = stableUUID('session:' + sessionKey)
  const turnID = stableUUID('turn:' + sessionKey + ':' + JSON.stringify(request.messages))
  const first = !(await control.hasSession(sessionID))
  const text = requestText(request.messages, first)
  if (text.length > 64000) throw new BridgeError('cos_input_too_large', 413)
  const inputID = first ? sessionID : turnID
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  await control.send({ id: inputID, ...(first ? {} : { sessionId: sessionID }), text })

  // A conversation is not considered delivered just because POST returned 202. Follow its
  // exact outbox input id in the durable event journal, including on idempotent retries.
  let seenInput = false
  let complete = false
  let textSoFar = ''
  let activeTurnID = null
  try {
    for await (const event of control.events(sessionID, { signal })) {
      if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
      if (event.kind === 'user_message' && (event.inputId === inputID || event.messageId === inputID)) {
        seenInput = true
        continue
      }
      if (!seenInput) continue
      // Ignore other sessions'/earlier turns' events; the exact user-message acknowledgement
      // is the publication boundary. Only an observed turn_start may authorize cancellation.
      if (event.kind === 'turn_start' && typeof event.turnId === 'string' && event.turnId) activeTurnID = event.turnId
      if (event.kind === 'chat_error' && event.blocking) throw new BridgeError('cos_chat_blocked', 502)
      if (event.kind === 'assistant_message') {
        if (event.message?.truncated || typeof event.message?.text !== 'string') throw new BridgeError('cos_output_incomplete', 502)
        const next = event.message.text
        if (!next.startsWith(textSoFar)) throw new BridgeError('cos_answer_revision_not_streamable', 502)
        const delta = next.slice(textSoFar.length)
        if (delta) { textSoFar = next; await emit(delta) }
      }
      if (event.kind === 'turn_end') {
        if (event.outcome && /error|fail|stop|abort|cancel|incomplete/.test(event.outcome)) {
          throw new BridgeError('cos_turn_not_completed', 502)
        }
        complete = true
        break
      }
    }
    if (!seenInput || !complete) throw new BridgeError('cos_turn_unconfirmed', 502)
    return textSoFar
  } finally {
    if (signal?.aborted && !complete) {
      // Never stop a later or unproven turn. The CoS broker validates exact turn identity;
      // when Send is not proven, its outbox independently decides whether cancellation is safe.
      try {
        if (seenInput && activeTurnID) await control.stop(sessionID, activeTurnID)
        else await control.cancelInput(inputID)
      } catch { /* an unconfirmed stop must never be reported as successful */ }
    }
  }
}

export function createGateway({ control, key }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('A strong local gateway bearer token is required')
  const active = new Set()
  const secret = Buffer.from('Bearer ' + key)
  const server = http.createServer(async (req, res) => {
    const sendJSON = (status, value) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}`) return sendJSON(403, { error: 'untrusted_origin' })
    const presented = Buffer.from(req.headers.authorization ?? '')
    if (presented.length !== secret.length || !timingSafeEqual(presented, secret)) return sendJSON(401, { error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/health') return sendJSON(200, { ok: true, gateway: 'chat-on-opencode', phase: 'control-api-adapter' })
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return sendJSON(404, { error: 'not_found' })
    let sessionKey = ''
    try {
      const header = req.headers['x-opencode-session-id']
      if (typeof header !== 'string' || !/^[\w.:/-]{1,256}$/.test(header)) throw new BridgeError('opencode_session_id_required', 422)
      sessionKey = header
      if (active.has(sessionKey)) throw new BridgeError('session_busy', 409)
      active.add(sessionKey)
      let raw = ''
      for await (const chunk of req) {
        raw += chunk.toString('utf8')
        if (raw.length > 262144) throw new BridgeError('body_too_large', 413)
      }
      let body
      try { body = JSON.parse(raw) } catch { throw new BridgeError('invalid_json', 400) }
      if (!body || typeof body !== 'object') throw new BridgeError('invalid_body', 400)
      const stream = body.stream === true
      const cancel = new AbortController()
      res.once('close', () => { if (!res.writableEnded) cancel.abort() })
      const id = 'chatcmpl-' + stableUUID(sessionKey + ':' + raw)
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let answer = ''
      // Do not announce SSE success until we have validated the request and upstream admission.
      const result = await runTurn(control, body, { sessionKey, signal: cancel.signal, emit: async (delta) => {
        answer += delta
        if (stream) {
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' })
          res.write('data: ' + JSON.stringify(chunk({ content: delta })) + '\n\n')
        }
      } })
      if (stream) {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n')
      } else sendJSON(200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }] })
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 502
      const code = error instanceof BridgeError ? error.code : 'unexpected_bridge_failure'
      if (res.headersSent) res.destroy(new Error(code))
      else sendJSON(status, { error: { message: code, type: 'chat_on_opencode_error' } })
    } finally { if (sessionKey) active.delete(sessionKey) }
  })
  return server
}
