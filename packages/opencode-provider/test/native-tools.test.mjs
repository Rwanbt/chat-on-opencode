import assert from 'node:assert/strict'
import test from 'node:test'
import { runTurn } from '../src/gateway.mjs'
import {
  validateCodingTools, codingInstructions, codingResultPrompt, parseCodingCall,
} from '../src/native-tools.mjs'
import { enforceTextOnlyContext } from '../plugin/text-only.mjs'

const request = { model: 'chatgpt-default', messages: [{ role: 'user', content: 'Bonjour' }] }
const tool = (name, parameters = { type: 'object' }) =>
  ({ type: 'function', function: { name, description: name + ' tool', parameters } })
const coding = (...names) => ({ tools: names.map(name => tool(name)), tool_choice: 'auto' })

class FakeCoS {
  constructor(events = ['Bonjour']) { this.sent = []; this.exists = false; this.outputs = events }
  async assertReady() {}
  async hasSession() { return this.exists }
  async send(payload) { this.sent.push(payload); this.exists = true; return { delivery: 'pending' } }
  async *events() {
    yield { seq: 1, kind: 'user_message', inputId: this.sent.at(-1).id }
    yield { seq: 2, kind: 'turn_start', turnId: 'fake-current-turn' }
    for (const [i, text] of this.outputs.entries()) {
      yield { seq: i + 3, kind: 'assistant_message', turnId: 'fake-current-turn', message: { text, truncated: false } }
    }
    yield { seq: this.outputs.length + 3, kind: 'turn_end', turnId: 'fake-current-turn', outcome: 'completed' }
  }
}

test('coding mode forwards every declared tool instead of silently dropping contracts', () => {
  const validated = validateCodingTools(coding('read', 'write', 'edit', 'bash', 'grep', 'glob', 'list'))
  assert.equal(validated.enabled, true)
  assert.deepEqual([...validated.names].sort(), ['bash', 'edit', 'glob', 'grep', 'list', 'read', 'write'])
  assert.equal(validated.tools.length, 7)
})

test('coding mode is inert without a declared tool or with tool_choice none', () => {
  assert.equal(validateCodingTools({ tools: [] }).enabled, false)
  assert.equal(validateCodingTools({ tools: [], tool_choice: 'auto' }).enabled, false)
  assert.equal(validateCodingTools({ tools: [tool('bash')], tool_choice: 'none' }).enabled, false)
})

test('coding mode refuses duplicate, malformed, oversized and excessive tool contracts', () => {
  assert.throws(() => validateCodingTools({ tools: [tool('bash'), tool('bash')] }), /native_tool_schema_invalid/)
  for (const bad of ['', 'a b', 'x'.repeat(65), 'a/b']) {
    assert.throws(() => validateCodingTools({ tools: [tool(bad)] }), /native_tool_schema_invalid/)
  }
  assert.throws(() => validateCodingTools({ tools: [{ type: 'function', function: { name: 'bash', parameters: [] } }] }),
    /native_tool_schema_invalid/)
  assert.throws(() => validateCodingTools({ tools: [{ type: 'function', function: { name: 'bash', parameters: { x: 'y'.repeat(5000) } } }] }),
    /native_tool_schema_too_large/)
  assert.throws(() => validateCodingTools({ tools: Array.from({ length: 33 }, (_, i) => tool('t' + i)) }),
    /native_tool_count_too_large/)
})

test('coding mode refuses a tool_choice naming an undeclared tool', () => {
  assert.throws(() => validateCodingTools({
    tools: [tool('bash')], tool_choice: { type: 'function', function: { name: 'write' } },
  }), /native_tool_choice_unsupported/)
  assert.throws(() => validateCodingTools({ tools: [tool('bash')], tool_choice: 'only_this' }),
    /native_tool_choice_unsupported/)
  assert.equal(validateCodingTools({
    tools: [tool('bash')], tool_choice: { type: 'function', function: { name: 'bash' } },
  }).enabled, true)
})

test('coding mode converts an envelope into a native call and never streams it as prose', async () => {
  const cos = new FakeCoS(['<opencode-tool>{"name":"bash","arguments":{"command":"npm test"}}</opencode-tool>'])
  const result = await runTurn(cos, { ...request, ...coding('read', 'bash') }, {
    sessionKey: 'ses_native_coding', messageKey: 'msg_native_coding_1', nativeTools: 'coding',
    emit: () => { throw new Error('a tool envelope must never stream as user-visible text') },
  })
  assert.equal(result.toolCall.type, 'function')
  assert.equal(result.toolCall.function.name, 'bash')
  assert.deepEqual(JSON.parse(result.toolCall.function.arguments), { command: 'npm test' })
  assert.match(result.toolCall.id, /^call_[0-9a-f]{24}$/)
  assert.match(cos.sent.at(-1).text, /<opencode-tool>/)
  assert.match(cos.sent.at(-1).text, /- bash: bash tool/)
})

test('coding mode streams an ordinary answer when the model does not call a tool', async () => {
  const cos = new FakeCoS(['Le projet compile.'])
  const emitted = []
  const text = await runTurn(cos, { ...request, ...coding('bash') }, {
    sessionKey: 'ses_native_coding', messageKey: 'msg_native_coding_2', nativeTools: 'coding',
    emit: chunk => { emitted.push(chunk) },
  })
  assert.equal(text, 'Le projet compile.')
  assert.deepEqual(emitted, ['Le projet compile.'])
})

test('coding mode refuses an undeclared, malformed, partial or oversized envelope', () => {
  const names = new Set(['bash'])
  for (const payload of [
    '<opencode-tool>{"name":"write","arguments":{"path":"a"}}</opencode-tool>',
    '<opencode-tool>{"name":"bash","arguments":[]}</opencode-tool>',
    '<opencode-tool>{"name":"bash","arguments":{}}</opencode-tool> extra',
    '<opencode-tool>{"name":"bash"}</opencode-tool>',
    '<opencode-tool>{"name":"bash","arguments":{},"extra":1}</opencode-tool>',
  ]) assert.throws(() => parseCodingCall(payload, names, 'ses_test', 'msg_native_coding_3'),
    /native_tool_(envelope|arguments)_(invalid|too_large)/)
  assert.equal(parseCodingCall('Aucun outil requis.', names, 'ses_test', 'msg_native_coding_4'), null)
})

test('coding mode folds the native result back as untrusted data and refuses identity mismatch', async () => {
  const names = new Set(['bash'])
  const call = parseCodingCall('<opencode-tool>{"name":"bash","arguments":{"command":"ls"}}</opencode-tool>',
    names, 'ses_native_coding', 'msg_native_coding_5')
  const folded = codingResultPrompt([
    { role: 'assistant', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: 'src\nREADME.md' },
  ], names)
  assert.ok(folded.text.includes('src\nREADME.md'))
  assert.match(folded.text, /UNTRUSTED/)
  assert.match(folded.text, /<untrusted-tool-result>/)
  assert.throws(() => codingResultPrompt([
    { role: 'assistant', tool_calls: [call] },
    { role: 'tool', tool_call_id: 'call_forged000000000000000', content: 'x' },
  ], names), /native_tool_result_identity_invalid/)
  assert.throws(() => codingResultPrompt([
    { role: 'assistant', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: 'x' },
  ], new Set(['read'])), /native_tool_result_identity_invalid/)
})

test('a tool result without coding consent is refused, never merged as prose', async () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call_abcdefgh', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_abcdefgh', content: 'output' },
  ]
  await assert.rejects(runTurn(new FakeCoS(), { ...request, messages }, {
    sessionKey: 'ses_native_coding', messageKey: 'msg_native_coding_6', emit: () => undefined,
  }), /native_tool_result_without_consent/)
})

test('coding instructions stay bounded and name every forwarded tool', () => {
  const validated = validateCodingTools(coding('read', 'bash'))
  const text = codingInstructions(validated.tools)
  assert.match(text, /- read: read tool/)
  assert.match(text, /- bash: bash tool/)
  assert.ok(text.length <= 24000)
  assert.throws(() => codingInstructions(
    Array.from({ length: 6 }, (_, i) => ({ name: 't' + i, description: 'd', schema: { x: 'y'.repeat(4096) } }))),
    /native_tools_manifest_too_large/)
})

test('coding instructions state the forced tool when tool_choice requires one', () => {
  const validated = validateCodingTools(coding('read', 'bash'))
  assert.match(codingInstructions(validated.tools, 'required'), /MUST call one of the listed tools/)
  assert.match(codingInstructions(validated.tools, 'bash'), /MUST call the tool "bash"/)
  assert.doesNotMatch(codingInstructions(validated.tools), /MUST call/)
})

test('the context gate keeps every declared tool only in coding mode', () => {
  const tools = { bash: { description: 'exec' }, read: { description: 'read' } }
  const all = { model: { providerID: 'chat-on-opencode' }, tools: { ...tools } }
  assert.equal(enforceTextOnlyContext(all, 'coding'), true)
  assert.deepEqual(Object.keys(all.tools).sort(), ['bash', 'read'])
  const readOnly = { model: { providerID: 'chat-on-opencode' }, tools: { ...tools } }
  enforceTextOnlyContext(readOnly, 'read')
  assert.deepEqual(Object.keys(readOnly.tools), ['read'])
  const off = { model: { providerID: 'chat-on-opencode' }, tools: { ...tools } }
  enforceTextOnlyContext(off, 'off')
  assert.deepEqual(off.tools, {})
  const other = { model: { providerID: 'anthropic' }, tools: { ...tools } }
  assert.equal(enforceTextOnlyContext(other, 'coding'), false)
  assert.deepEqual(Object.keys(other.tools).sort(), ['bash', 'read'])
})
