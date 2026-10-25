import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createResponsesRequest, collectResponsesSSE } from '../src/responses-adapter.mjs'

const tool = { type: 'function', function: { name: 'read', description: 'Read an approved path',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
const req = (extra = {}) => ({ model: 'chatgpt-default', stream: true,
  messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Bonjour' }], ...extra })
const adapter = request => createResponsesRequest(request, { model: 'gpt-6.1-sol' })
const encoder = new TextEncoder()
const sse = (type, value) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...value })}\r\n\r\n`
const output = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const completed = outputItems => sse('response.completed', { response: { status: 'completed', output: outputItems } })
async function* feed(source, sizes = [2, 1, 5, 3, 7]) {
  const bytes = encoder.encode(source)
  for (let i = 0, n = 0; i < bytes.length; n++) {
    const size = sizes[n % sizes.length]
    yield bytes.subarray(i, i + size)
    i += size
  }
}
const parse = (text, options) => collectResponsesSSE(feed(text), options)

test('strict outbound request fixes SIWC store/stream, model selection and full context', () => {
  const { body, allowedTools } = adapter(req())
  assert.deepEqual(body, { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Bonjour' }],
    store: false, stream: true, instructions: 'Be precise' })
  assert.equal(allowedTools.size, 0)
  assert.deepEqual(adapter(req({ tools: [tool], tool_choice: 'auto' })).body.input[0], {
    type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'read',
      description: 'Read an approved path', parameters: tool.function.parameters }] })
})

test('native OpenCode function call and tool response preserve exact ids and ordering', () => {
  const messages = [{ role: 'developer', content: 'No writes' }, { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_from_native_01', type: 'function',
      function: { name: 'read', arguments: '{"path":"/tmp/item"}' } }] },
    { role: 'tool', tool_call_id: 'call_from_native_01', content: 'file value' }]
  const { body } = adapter(req({ messages, tools: [tool] }))
  assert.deepEqual(body.input.slice(-2), [
    { type: 'function_call', call_id: 'call_from_native_01', name: 'read', arguments: '{"path":"/tmp/item"}' },
    { type: 'function_call_output', call_id: 'call_from_native_01', output: 'file value' }])
  assert.deepEqual(body.input[1], { role: 'developer', content: 'No writes' })
})

test('unsupported fields, ambiguous messages and tool identities fail closed', () => {
  for (const field of ['temperature', 'max_tokens', 'metadata', 'store', 'previous_response_id', 'background', 'user']) {
    assert.throws(() => adapter(req({ [field]: field === 'store' ? false : 0 })), /unsupported_fields/)
  }
  assert.throws(() => adapter(req({ stream: false })), /resolved_model_required/)
  assert.throws(() => createResponsesRequest(req()), /resolved_model_required/)
  assert.throws(() => adapter(req({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] })), /unsupported_content/)
  assert.throws(() => adapter(req({ messages: [{ role: 'user', content: 'x' },
    { role: 'assistant', content: null }] })), /unsupported_content/)
  assert.throws(() => adapter(req({ messages: [{ role: 'user', content: 'x'.repeat(1_048_577) }] })), /unsupported_content/)
  assert.throws(() => adapter(req({ tools: [{ type: 'file_search' }] })), /invalid_tools|unsupported_fields/)
  assert.throws(() => adapter(req({ tool_choice: 'required' })), /unsupported_tool_choice/)
  assert.throws(() => adapter(req({ messages: [{ role: 'tool', tool_call_id: 'forged', content: 'secret' }] })), /unmatched_tool_result/)
  const call = { id: 'call_native_01', type: 'function', function: { name: 'read', arguments: '{}' } }
  assert.throws(() => adapter(req({ messages: [{ role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [call] }] })), /unanswered_tool_call/)
  assert.throws(() => adapter(req({ messages: [{ role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [call, call] }] })), /invalid_tool_history/)
})

test('SSE stream parses CRLF and fragmented multibyte UTF-8; complete output is authoritative', async () => {
  const frames = sse('response.created', { response: { id: 'resp_test' } }) +
    ': heartbeat\r\n\r\n' + sse('response.output_text.delta', { delta: 'é' }) +
    sse('response.output_text.delta', { delta: '🌊' }) + completed([output('é🌊')]) + 'data: [DONE]\r\n\r\n'
  assert.deepEqual(await parse(frames), { content: 'é🌊', tool_calls: [], finish_reason: 'stop' })
  assert.deepEqual(await parse(completed([output('fallback')])), { content: 'fallback', tool_calls: [], finish_reason: 'stop' })
})

test('SSE function call is completed before forwarding and identity is never regenerated', async () => {
  const call = { type: 'function_call', id: 'fc_backend_001', call_id: 'call_native_108',
    name: 'read', arguments: '{"path":"/allowed/file"}' }
  const frames = sse('response.function_call_arguments.delta', { output_index: 0, item_id: call.id, delta: '{"path":' }) +
    sse('response.function_call_arguments.delta', { output_index: 0, item_id: call.id, delta: '"/allowed/file"}' }) +
    sse('response.function_call_arguments.done', { output_index: 0, item_id: call.id, arguments: call.arguments }) +
    sse('response.output_item.done', { output_index: 0, item: call }) + completed([call])
  const result = await parse(frames, { allowedTools: new Set(['read']) })
  assert.deepEqual(result, { content: '', finish_reason: 'tool_calls', tool_calls: [
    { id: 'call_native_108', type: 'function', function: { name: 'read', arguments: call.arguments } }] })
  await assert.rejects(parse(frames, { allowedTools: new Set() }), /tool_not_authorized/)
  const mismatched = sse('response.function_call_arguments.delta', { output_index: 0, item_id: call.id, delta: '{"path":"/wrong/file"}' }) +
    sse('response.output_item.done', { output_index: 0, item: call }) + completed([call])
  await assert.rejects(parse(mismatched, { allowedTools: new Set(['read']) }), /call_arguments_mismatch/)
})

test('deny tool from output even if response.completed claims success', async () => {
  const forged = { type: 'function_call', call_id: 'call_unauthorized', name: 'shell', arguments: '{}' }
  await assert.rejects(parse(completed([forged]), { allowedTools: new Set(['read']) }), /unsupported_output_item/)
})

test('aborted, failed, incomplete, truncated and mismatched streams never complete', async () => {
  const delta = sse('response.output_text.delta', { delta: 'maybe' })
  await assert.rejects(parse(delta), /response_missing_completion/)
  await assert.rejects(parse(delta + sse('response.failed', { response: { error: { code: 'usage_limit' } } })), /response_not_completed/)
  await assert.rejects(parse(delta + sse('response.incomplete', {})), /response_not_completed/)
  await assert.rejects(parse(delta + completed([output('different')])), /completion_mismatch/)
  await assert.rejects(parse('data: [DONE]\n\n'), /premature_done/)
  await assert.rejects(parse(completed([output('ok')]) + sse('response.output_text.delta', { delta: 'late' })), /data_after_terminal/)
  await assert.rejects(parse(completed([output('ok')]) + 'data: [DONE]\n\n' + 'data: [DONE]\n\n'), /data_after_terminal/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(parse(completed([output('ok')]), { signal: controller.signal }), /response_aborted/)
  await assert.rejects(collectResponsesSSE((async function* () { yield Uint8Array.from([0xc3]) })()), /invalid_utf8/)
  await assert.rejects(collectResponsesSSE((async function* () { yield encoder.encode('data: {"type":"response.completed"}') })()), /truncated_sse_frame/)
  await assert.rejects(parse('id: repeated\n'.repeat(120_000)), /sse_frame_too_large/)
  await assert.rejects(parse(sse('response.unknown', {})), /unsupported_sse_event/)
})
