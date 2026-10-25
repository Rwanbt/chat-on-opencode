// Independent, offline Responses protocol adapter. Deliberately owns no HTTP, auth or tools.
// Upstream must select an account-authorized model; caller must execute tools in OpenCode.
const MAX_FRAME = 1_048_576
const MAX_TEXT = 1_048_576
const MAX_CALLS = 32
const ID = /^[A-Za-z0-9_-]{1,128}$/
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k)
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

export class ResponsesContractError extends Error {
  constructor(code) { super(code); this.name = 'ResponsesContractError'; this.code = code }
}
const fail = code => { throw new ResponsesContractError(code) }
const keys = (value, allowed) => {
  if (!obj(value) || Object.keys(value).some(k => !allowed.includes(k))) fail('unsupported_fields')
}
const bounded = (text, max = MAX_TEXT) => typeof text === 'string' && text.length <= max
const jsonArgs = text => {
  if (!bounded(text, 32768)) fail('invalid_tool_arguments')
  let parsed
  try { parsed = JSON.parse(text) } catch { fail('invalid_tool_arguments') }
  if (!obj(parsed)) fail('invalid_tool_arguments')
  return text
}
function content(value) {
  if (bounded(value)) return value
  if (Array.isArray(value) && value.length && value.every(p => obj(p) && Object.keys(p).sort().join() === 'text,type' && p.type === 'text' && bounded(p.text))) {
    const text = value.map(p => p.text).join('')
    if (bounded(text)) return text
  }
  fail('unsupported_content')
}

export function createResponsesRequest(request, { model } = {}) {
  keys(request, ['model', 'messages', 'stream', 'tools', 'tool_choice'])
  if (!bounded(request.model, 128) || !request.model || request.stream !== true ||
      typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) fail('resolved_model_required')
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.length > 256) fail('invalid_messages')
  const tools = new Map()
  if (own(request, 'tools')) {
    if (!Array.isArray(request.tools) || request.tools.length > MAX_CALLS) fail('invalid_tools')
    for (const t of request.tools) {
      keys(t, ['type', 'function'])
      keys(t.function, ['name', 'description', 'parameters'])
      const f = t.function
      if (t.type !== 'function' || !NAME.test(f.name ?? '') || tools.has(f.name) ||
          !obj(f.parameters) || f.parameters.type !== 'object' ||
          (own(f, 'description') && !bounded(f.description, 4096))) fail('invalid_tools')
      tools.set(f.name, { type: 'function', name: f.name,
        ...(f.description === undefined ? {} : { description: f.description }), parameters: f.parameters })
    }
  }
  if (own(request, 'tool_choice') && !['auto', 'none'].includes(request.tool_choice)) fail('unsupported_tool_choice')
  const input = []
  if (tools.size) input.push({ type: 'additional_tools', role: 'developer', tools: [...tools.values()] })
  const pending = new Set()
  const past = new Set()
  const instructions = []
  let preface = true
  for (const m of request.messages) {
    if (!obj(m) || typeof m.role !== 'string') fail('invalid_messages')
    if (m.role === 'system') {
      keys(m, ['role', 'content'])
      if (!preface) fail('late_system_message')
      instructions.push(content(m.content))
    } else if (m.role === 'developer' || m.role === 'user') {
      keys(m, ['role', 'content'])
      if (pending.size) fail('unanswered_tool_call')
      input.push({ role: m.role, content: content(m.content) })
      if (m.role === 'user') preface = false
    } else if (m.role === 'assistant') {
      keys(m, ['role', 'content', 'tool_calls'])
      if (pending.size) fail('unanswered_tool_call')
      preface = false
      if ((m.content === null || m.content === undefined) && m.tool_calls === undefined) fail('unsupported_content')
      if (m.content !== null && m.content !== undefined && content(m.content)) input.push({ role: 'assistant', content: content(m.content) })
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || !m.tool_calls.length || m.tool_calls.length > MAX_CALLS) fail('invalid_tool_history')
        for (const call of m.tool_calls) {
          keys(call, ['id', 'type', 'function'])
          keys(call.function, ['name', 'arguments'])
          if (call.type !== 'function' || !ID.test(call.id ?? '') || past.has(call.id) ||
              !NAME.test(call.function.name ?? '')) fail('invalid_tool_history')
          past.add(call.id); pending.add(call.id)
          input.push({ type: 'function_call', call_id: call.id, name: call.function.name,
            arguments: jsonArgs(call.function.arguments) })
        }
      }
    } else if (m.role === 'tool') {
      keys(m, ['role', 'content', 'tool_call_id'])
      if (!ID.test(m.tool_call_id ?? '') || !pending.delete(m.tool_call_id)) fail('unmatched_tool_result')
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: content(m.content) })
    } else fail('unsupported_role')
  }
  if (pending.size) fail('unanswered_tool_call')
  if (!input.some(item => item.role === 'user' || item.type === 'function_call_output')) fail('missing_user_input')
  const body = { model, input, store: false, stream: true,
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    ...(tools.size && request.tool_choice ? { tool_choice: request.tool_choice } : {}) }
  if (JSON.stringify(body).length > MAX_FRAME) fail('request_too_large')
  return { body, allowedTools: request.tool_choice === 'none' ? new Set() : new Set(tools.keys()) }
}

// All bytes are synthetic supplied by the caller. No fetch, credentials or local execution.
export async function collectResponsesSSE(chunks, { signal, allowedTools = new Set() } = {}) {
  if (!(allowedTools instanceof Set)) fail('invalid_tool_policy')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', frame = [], frameBytes = 0, completed = false, done = false, observed = '', count = 0
  const partial = new Map(), calls = new Map()
  const append = text => {
    if (!bounded(text) || observed.length + text.length > MAX_TEXT) fail('output_too_large')
    observed += text
  }
  function accept(raw) {
    if (done) fail('data_after_terminal')
    if (raw === '[DONE]') {
      if (!completed) fail('premature_done')
      done = true; return
    }
    let event
    try { event = JSON.parse(raw) } catch { fail('invalid_sse_json') }
    if (!obj(event) || typeof event.type !== 'string') fail('invalid_sse_event')
    if (completed) fail('data_after_terminal')
    switch (event.type) {
      case 'response.created': case 'response.in_progress':
      case 'response.output_item.added': case 'response.content_part.added':
      case 'response.content_part.done': case 'response.output_text.done': break
      case 'response.output_text.delta': append(event.delta); break
      case 'response.function_call_arguments.delta': {
        const k = event.output_index
        if (!Number.isSafeInteger(k) || k < 0 || k >= MAX_CALLS || !ID.test(event.item_id ?? '') || !bounded(event.delta, 32768)) fail('invalid_call_delta')
        const p = partial.get(k) ?? { id: event.item_id, text: '' }
        if (p.id !== event.item_id || p.text.length + event.delta.length > 32768) fail('invalid_call_delta')
        p.text += event.delta; partial.set(k, p); break
      }
      case 'response.function_call_arguments.done': {
        const p = partial.get(event.output_index)
        if (p && (p.id !== event.item_id || p.text !== event.arguments)) fail('call_arguments_mismatch')
        jsonArgs(event.arguments)
        break
      }
      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'reasoning' || item?.type === 'message') break
        if (item?.type !== 'function_call') fail('unsupported_output_item')
        if (!ID.test(item.call_id ?? '') || !NAME.test(item.name ?? '') || !allowedTools.has(item.name) ||
            calls.has(item.call_id) || calls.size >= MAX_CALLS) fail('tool_not_authorized')
        const p = partial.get(event.output_index)
        if (p && (p.id !== item.id || p.text !== item.arguments)) fail('call_arguments_mismatch')
        calls.set(item.call_id, { id: item.call_id, type: 'function', function: {
          name: item.name, arguments: jsonArgs(item.arguments) } })
        break
      }
      case 'response.completed': {
        if (event.response?.status !== 'completed' || !Array.isArray(event.response.output)) fail('invalid_completion')
        const text = []
        const finalCalls = []
        for (const item of event.response.output) {
          if (item.type === 'reasoning') continue
          if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content) &&
              item.content.every(part => part.type === 'output_text' && bounded(part.text))) {
            text.push(...item.content.map(part => part.text)); continue
          }
          if (item.type === 'function_call' && allowedTools.has(item.name) && ID.test(item.call_id ?? '') && NAME.test(item.name ?? '')) {
            finalCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: jsonArgs(item.arguments) } }); continue
          }
          fail('unsupported_output_item')
        }
        const content = text.join('')
        if (!bounded(content) || (observed && observed !== content) || finalCalls.length !== calls.size ||
            finalCalls.some(c => JSON.stringify(c) !== JSON.stringify(calls.get(c.id)))) fail('completion_mismatch')
        completed = { content, tool_calls: finalCalls, finish_reason: finalCalls.length ? 'tool_calls' : 'stop' }
        break
      }
      case 'response.failed': case 'response.incomplete': case 'error': fail('response_not_completed')
      default: fail('unsupported_sse_event')
    }
  }
  function line(value) {
    if (value === '') {
      const data = frame.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      const type = frame.find(l => l.startsWith('event:'))?.slice(6).trim()
      frame = []; frameBytes = 0
      if (data) {
        if (++count > 100000) fail('too_many_events')
        if (type && type !== '[DONE]' && data !== '[DONE]') {
          let parsed
          try { parsed = JSON.parse(data) } catch { fail('invalid_sse_json') }
          if (parsed.type !== type) fail('sse_event_type_mismatch')
        }
        accept(data)
      }
    } else if (!value.startsWith(':')) {
      if (!value.startsWith('data:') && !value.startsWith('event:') && !value.startsWith('id:') && !value.startsWith('retry:')) fail('invalid_sse_field')
      frameBytes += value.length
      if (frameBytes > MAX_FRAME) fail('sse_frame_too_large')
      frame.push(value)
    }
  }
  for await (const chunk of chunks) {
    if (signal?.aborted) fail('response_aborted')
    if (!(chunk instanceof Uint8Array)) fail('invalid_sse_bytes')
    try { buffer += decoder.decode(chunk, { stream: true }) } catch { fail('invalid_utf8') }
    if (buffer.length > MAX_FRAME) fail('sse_frame_too_large')
    let pos
    while ((pos = buffer.indexOf('\n')) !== -1) {
      const row = buffer.slice(0, pos)
      buffer = buffer.slice(pos + 1)
      line(row.endsWith('\r') ? row.slice(0, -1) : row)
    }
  }
  if (signal?.aborted) fail('response_aborted')
  try { buffer += decoder.decode() } catch { fail('invalid_utf8') }
  if (buffer.trim() || frame.length) fail('truncated_sse_frame')
  if (!completed) fail('response_missing_completion')
  return completed
}
