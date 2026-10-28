import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { traceStage } from './stage-trace.mjs'
import { BridgeError } from './control.mjs'
import { READ_INSTRUCTIONS, validateNativeTools, readResultPrompt, parseReadCall } from './native-read.mjs'
import { plainMessages, completedTranscriptAnchor, continuationWithTranscript } from './transcript-handoff.mjs'

// Deterministic names survive restart; never infer session identity from prompt text.
export function stableUUID(value) {
  const hex = createHash('sha256').update('chat-on-opencode-v1\0' + value).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = '8'
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

export function requestText(messages, first) {
  const plain = plainMessages(messages)
  const last = plain.at(-1)
  if (last.role !== 'user' || !last.content.trim()) throw new BridgeError('last_message_must_be_user', 422)
  if (!first) return last.content
  const preface = plain.filter(part => part.role === 'system' || part.role === 'developer')
  const history = plain.filter(part => part.role === 'user' || part.role === 'assistant')
  // Only the initial turn carries prior history; later turns use the CoS session itself.
  return [...preface.map(p => `[${p.role} instructions]\n${p.content}\n[/instructions]`),
    ...history.map(p => `[${p.role}]\n${p.content}\n[/${p.role}]`)].join('\n\n')
}

// The session lookup and readiness checks are read-only. A provider switch may
// abandon them before CoS responds; the obsolete attempt must release its
// session lease without waiting for a stale read to finish.
async function abortableRead(pending, signal) {
  if (!signal) return pending
  if (signal.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  const onAbort = () => rejectAbort(new BridgeError('opencode_turn_cancelled', 499))
  let rejectAbort
  const cancelled = new Promise((_, reject) => { rejectAbort = reject })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) onAbort()
    return await Promise.race([pending, cancelled])
  } finally { signal.removeEventListener('abort', onAbort) }
}

/**
 * The hidden Chromium extension starts asynchronously after Electron's control
 * socket opens. Wait for that local bootstrap BEFORE admitting an OpenCode turn.
 * Never resubmit a prompt, approve pairing, or infer authentication from "up".
 * Confirmed missing sign-in/unpaired states still fail immediately.
 */
export async function awaitProviderReady(control, {
  signal, clock = Date.now, sleep = delay, maxWaitMs = 60_000,
} = {}) {
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  // Older synthetic control fixtures implement assertReady but not readiness.
  if (typeof control.readiness !== 'function') return abortableRead(control.assertReady({ signal }), signal)
  const deadline = clock() + maxWaitMs
  for (;;) {
    if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
    const state = await abortableRead(control.readiness({ signal }), signal)
    if (state.sessionCookie === 'present' && state.extension === 'connected' &&
        state.paired && state.canAttempt) return abortableRead(control.assertReady({ signal }), signal)
    if (state.sessionCookie === 'absent' ||
        (state.sessionCookie === 'present' && state.extension === 'connected' && !state.paired) ||
        clock() >= deadline) return abortableRead(control.assertReady({ signal }), signal)
    const ms = Math.max(1, Math.min(400, deadline - clock()))
    try { await sleep(ms, undefined, { signal }) }
    catch (error) {
      if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
      throw error
    }
  }
}

export async function runTurn(control, request, { sessionKey, messageKey, kind = 'primary', emit, signal,
  nativeTools = 'off', checkpoint, previousInput, rememberInput, turnCustody, messageFingerprint } = {}) {
  traceStage('gateway_turn_received')
  if (!sessionKey || sessionKey.length > 256 || /[\r\n]/.test(sessionKey)) throw new BridgeError('opencode_session_id_required', 422)
  if (!messageKey || !/^[A-Za-z0-9_.:-]{6,256}$/.test(messageKey)) throw new BridgeError('opencode_message_id_required', 422)
  const readEnabled = validateNativeTools(request, nativeTools === 'read')
  if (request.model !== 'chatgpt-default') throw new BridgeError('model_not_configured', 422)
  if (kind !== 'primary') throw new BridgeError('auxiliary_calls_not_yet_supported', 501)
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  const sessionID = stableUUID('session:' + sessionKey)
  const result = readResultPrompt(request.messages)
  if (result && !readEnabled) throw new BridgeError('native_tool_result_without_consent', 403)
  const turnID = stableUUID('turn:' + sessionKey + ':' + messageKey + (result ? ':' + result.callId : ''))
  const first = !(await abortableRead(control.hasSession(sessionID, { signal }), signal))
  if (result && first) throw new BridgeError('native_tool_result_without_session', 422)
  const firstRecord = !result && turnCustody?.read(sessionKey)
  const originalFirst = !result && turnCustody?.isOriginal(firstRecord, messageKey)
  if (first && firstRecord && !originalFirst) throw new BridgeError('turn_first_message_pending', 409)
  const text = previousInput ?? (result ? result.text : (first || readEnabled
    ? requestText(request.messages, first)
    : originalFirst ? requestText(request.messages, true)
    : continuationWithTranscript(plainMessages(request.messages), checkpoint)) +
    (readEnabled ? '\n\n' + READ_INSTRUCTIONS : ''))
  if (text.length > 64000) throw new BridgeError('cos_input_too_large', 413)
  if (originalFirst && firstRecord) turnCustody.verify(firstRecord, messageKey, text)
  const inputID = first || originalFirst ? sessionID : turnID
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  // A hidden provider with no ChatGPT session or browser bridge must not accept
  // a prompt into the durable outbox that no authenticated page can deliver.
  await awaitProviderReady(control, { signal })
  traceStage('control_ready')
  if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
  // A conversation is not considered delivered just because POST returned 202. Follow its
  // exact outbox input id in the durable event journal, including on idempotent retries.
  let seenInput = false
  let complete = false
  let textSoFar = ''
  let activeTurnID = null
  let sendStarted = false
  try {
    // Once POST /inputs begins, completion is no longer a read-only operation.
    // Wait for its bounded response before releasing custody; if the native
    // request was cancelled during admission, CoS must decide whether the exact
    // outbox input can still be cancelled.
    sendStarted = true
    if (first && !result) turnCustody?.claimFirst(sessionKey, messageKey, text)
    if (!first && !originalFirst && !result && messageFingerprint) {
      turnCustody?.claimFollowup(sessionKey, messageKey, messageFingerprint, text)
    }
    rememberInput?.(text)
    await control.send({ id: inputID, ...(first ? {} : { sessionId: sessionID }), text })
    traceStage('input_admitted')
    if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
    // A native provider switch can close the HTTP socket while a remote SSE
    // iterator is blocked in next(). Relying only on the iterator to notice
    // AbortSignal leaves this session leased indefinitely, preventing retry.
    // Race each next() with native cancellation, without abandoning exact
    // outbox/turn custody or waiting for an unresponsive iterator.return().
    const iterator = control.events(sessionID, { signal })[Symbol.asyncIterator]()
    try {
    for (;;) {
      const next = await abortableRead(iterator.next(), signal)
      if (next.done) break
      const event = next.value
      if (signal?.aborted) throw new BridgeError('opencode_turn_cancelled', 499)
      if (event.kind === 'user_message') {
        if (event.inputId === inputID || event.messageId === inputID) seenInput = true
        else if (seenInput) throw new BridgeError('cos_input_superseded', 409)
        continue
      }
      if (!seenInput) continue
      // Ignore other sessions'/earlier turns' events; the exact user-message acknowledgement
      // is the publication boundary. Only an observed turn_start may authorize cancellation.
      if (event.kind === 'turn_start' && typeof event.turnId === 'string' && event.turnId) {
        if (activeTurnID && activeTurnID !== event.turnId) throw new BridgeError('cos_turn_superseded', 409)
        if (typeof event.inputId === 'string' && event.inputId !== inputID) throw new BridgeError('cos_input_superseded', 409)
        activeTurnID = event.turnId
      }
      // A follow-up's input receipt may precede stale history notifications.
      // Only a newly observed turn and its matching events can supply an answer.
      if (!activeTurnID || event.turnId !== activeTurnID) continue
      if (event.kind === 'chat_error' && event.blocking) throw new BridgeError('cos_chat_blocked', 502)
      if (event.kind === 'assistant_message') {
        if (event.message?.truncated || typeof event.message?.text !== 'string') throw new BridgeError('cos_output_incomplete', 502)
        const next = event.message.text
        if (!next.startsWith(textSoFar)) throw new BridgeError('cos_answer_revision_not_streamable', 502)
        const delta = next.slice(textSoFar.length)
        if (delta) { textSoFar = next; if (!readEnabled) await emit(delta) }
      }
      if (event.kind === 'turn_end') {
        if (event.outcome && /error|fail|stop|abort|cancel|incomplete/.test(event.outcome)) {
          throw new BridgeError('cos_turn_not_completed', 502)
        }
        complete = true
        break
      }
    }
    } finally {
      if (typeof iterator.return === 'function') {
        if (signal?.aborted) {
          // CoSControl.events has the same AbortSignal and closes its SSE
          // reader; never await a transport that ignores cancellation here.
          try { void Promise.resolve(iterator.return()).catch(() => undefined) }
          catch { /* cancellation already owns the failure */ }
        } else await iterator.return()
      }
    }
    if (!seenInput || !complete) throw new BridgeError('cos_turn_unconfirmed', 502)
    if (readEnabled) {
      // Delay every byte until the whole CoS turn has completed and the envelope
      // can be validated. Never stream half a forged tool call as user-visible prose.
      const toolCall = parseReadCall(textSoFar, !result, sessionKey, messageKey)
      if (toolCall) return { toolCall }
      await emit(textSoFar)
    }
    return textSoFar
  } finally {
    if (signal?.aborted && !complete && sendStarted) {
      // Never stop a later or unproven turn. The CoS broker validates exact turn identity;
      // when Send is not proven, its outbox independently decides whether cancellation is safe.
      try {
        if (seenInput && activeTurnID) await control.stop(sessionID, activeTurnID)
        else await control.cancelInput(inputID)
      } catch { /* an unconfirmed stop must never be reported as successful */ }
    }
  }
}

export function createGateway({ control, key, nativeTools = 'off', turnCustody }) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('A strong local gateway bearer token is required')
  const active = new Set()
  // Volatile custody for a *generated* tool call. An authenticated caller may
  // not invent a tool-result message and have it forwarded into ChatGPT.
  // Gateway restart loses custody and intentionally refuses the result.
  const issuedReads = new Map()
  // Only completed CoS turns create anchors. Do not persist transcript content;
  // a service restart safely loses this optional handoff proof.
  const checkpoints = new Map()
  // Freeze the exact submitted payload per native message for idempotent retry.
  const submittedInputs = new Map()
  const rememberBounded = (map, id, value, limit = 128) => {
    map.delete(id); map.set(id, value)
    while (map.size > limit) map.delete(map.keys().next().value)
  }
  const secret = Buffer.from('Bearer ' + key)
  // Protected /health gives only categorical diagnostics. No prompt, path, headers or secrets.
  const diagnostics = { attempted: 0, authRefused: 0, lastFailure: null }
  const server = http.createServer(async (req, res) => {
    const sendJSON = (status, value) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}`) return sendJSON(403, { error: 'untrusted_origin' })
    const presented = Buffer.from(req.headers.authorization ?? '')
    if (presented.length !== secret.length || !timingSafeEqual(presented, secret)) {
      diagnostics.authRefused++
      return sendJSON(401, { error: 'unauthorized' })
    }
    if (req.method === 'GET' && req.url === '/health') return sendJSON(200, {
      ok: true, gateway: 'chat-on-opencode', phase: 'control-api-adapter', pid: process.pid,
      diagnostics, provider: await control.readiness().catch(() => ({ sessionCookie: 'unknown',
        extension: 'disconnected', paired: false, canAttempt: false })),
    })
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return sendJSON(404, { error: 'not_found' })
    diagnostics.attempted++
    let sessionKey = ''
    let ownsSession = false
    try {
      const header = req.headers['x-opencode-session-id']
      if (typeof header !== 'string' || !/^[\w.:/-]{1,256}$/.test(header)) throw new BridgeError('opencode_session_id_required', 422)
      sessionKey = header
      const messageKey = req.headers['x-opencode-message-id']
      if (typeof messageKey !== 'string' || !/^[A-Za-z0-9_.:-]{6,256}$/.test(messageKey)) throw new BridgeError('opencode_message_id_required', 422)
      if (active.has(sessionKey)) throw new BridgeError('session_busy', 409)
      active.add(sessionKey)
      ownsSession = true
      let raw = ''
      let bodyBytes = 0
      // HTTP buffers may split a multi-byte codepoint at any boundary. Decoding each
      // chunk independently silently corrupts prompt text; replacing invalid bytes
      // would also make a malformed input look like a valid user message.
      const decoder = new TextDecoder('utf-8', { fatal: true })
      for await (const chunk of req) {
        bodyBytes += chunk.byteLength
        if (bodyBytes > 262144) throw new BridgeError('body_too_large', 413)
        try { raw += decoder.decode(chunk, { stream: true }) }
        catch { throw new BridgeError('invalid_utf8', 400) }
      }
      try { raw += decoder.decode() }
      catch { throw new BridgeError('invalid_utf8', 400) }
      let body
      try { body = JSON.parse(raw) } catch { throw new BridgeError('invalid_json', 400) }
      if (!body || typeof body !== 'object') throw new BridgeError('invalid_body', 400)
      const isToolResult = body.messages?.at(-1)?.role === 'tool'
      if (isToolResult) {
        const issued = issuedReads.get(sessionKey)
        const previous = body.messages.at(-2)?.tool_calls
        if (!issued || issued.messageKey !== messageKey || previous?.length !== 1 ||
            previous[0]?.id !== issued.id || body.messages.at(-1).tool_call_id !== issued.id) {
          throw new BridgeError('native_tool_result_not_issued', 403)
        }
      } else if (issuedReads.has(sessionKey)) {
        // A later user prompt supersedes an unanswered tool request.
        issuedReads.delete(sessionKey)
      }
      const stream = body.stream === true
      const cancel = new AbortController()
      res.once('close', () => { if (!res.writableEnded) cancel.abort() })
      const id = 'chatcmpl-' + stableUUID(sessionKey + ':' + raw)
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let answer = ''
      // Do not announce SSE success until we have validated the request and upstream admission.
      const inputKey = sessionKey + '\0' + messageKey
      const messageFingerprint = createHash('sha256').update(JSON.stringify(body.messages ?? null)).digest('hex')
      const priorInput = !isToolResult && submittedInputs.get(inputKey)
      if (priorInput && priorInput.messageFingerprint !== messageFingerprint) {
        throw new BridgeError('opencode_message_identity_reused_with_changed_history', 409)
      }
      // A restart loses volatile foreign-provider handoff checkpoints. For an
      // already admitted follow-up, retrieve the exact prior text from CoS's
      // own persistent outbox rather than recompose a different prompt under
      // the same native message ID. The salted local marker binds the full
      // original native history without storing the text or credentials.
      let recoveredInput
      if (!isToolResult && !priorInput && turnCustody) {
        const record = turnCustody.readFollowup(sessionKey, messageKey)
        if (record) {
          turnCustody.verifyFollowup(record, messageFingerprint)
          const id = stableUUID('turn:' + sessionKey + ':' + messageKey)
          const stored = await control.readInput?.(id, { signal: cancel.signal })
          if (!stored || stored.id !== id || stored.sessionId !== stableUUID('session:' + sessionKey) ||
              typeof stored.text !== 'string' || stored.text.length > 64000) {
            throw new BridgeError('cos_replay_input_unavailable', 409)
          }
          turnCustody.verifyFollowup(record, messageFingerprint, stored.text)
          recoveredInput = stored.text
        }
      }
      const result = await runTurn(control, body, { sessionKey, messageKey, nativeTools, signal: cancel.signal,
        checkpoint: checkpoints.get(sessionKey), previousInput: priorInput?.text ?? recoveredInput,
        turnCustody, messageFingerprint,
        rememberInput: isToolResult ? undefined : text => rememberBounded(submittedInputs, inputKey,
          { text, messageFingerprint }), emit: async (delta) => {
        answer += delta
        if (stream) {
          if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'close' })
          res.write('data: ' + JSON.stringify(chunk({ content: delta })) + '\n\n')
        }
      } })
      if (!isToolResult && typeof result === 'string' && !cancel.signal.aborted) {
        const anchor = completedTranscriptAnchor(body.messages, result)
        if (anchor) rememberBounded(checkpoints, sessionKey, anchor)
      }
      if (typeof result === 'object' && result?.toolCall) {
        if (res.headersSent) throw new BridgeError('native_tool_call_after_text', 502)
        const call = result.toolCall
        issuedReads.delete(sessionKey)
        issuedReads.set(sessionKey, { id: call.id, messageKey })
        while (issuedReads.size > 1024) issuedReads.delete(issuedReads.keys().next().value)
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          res.end('data: ' + JSON.stringify(chunk({ tool_calls: [{
            index: 0, id: call.id, type: call.type, function: call.function,
          }] })) + '\n\ndata: ' + JSON.stringify(chunk({}, 'tool_calls')) + '\n\ndata: [DONE]\n\n')
        } else sendJSON(200, {
          id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
        })
        return
      }
      if (isToolResult) issuedReads.delete(sessionKey)
      if (stream) {
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.end('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\ndata: [DONE]\n\n')
      } else sendJSON(200, { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result }, finish_reason: 'stop' }] })
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 502
      const code = error instanceof BridgeError ? error.code : 'unexpected_bridge_failure'
      diagnostics.lastFailure = code
      if (res.headersSent) res.destroy(new Error(code))
      else sendJSON(status, { error: { message: code, type: 'chat_on_opencode_error' } })
    } finally { if (ownsSession) active.delete(sessionKey) }
  })
  return server
}
