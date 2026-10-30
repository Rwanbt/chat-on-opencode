import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgeRequestText, requestText, runTurn } from '../src/gateway.mjs'
import { bridgeContextLine, normalizeLocation } from '../src/bridge-context.mjs'

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

test('the bridge context accepts only a bounded absolute path', () => {
  assert.equal(normalizeLocation('C:\\project\\fixture'), 'C:\\project\\fixture')
  assert.equal(normalizeLocation('/srv/project'), '/srv/project')
  assert.equal(normalizeLocation('relative\\path'), null)
  assert.equal(normalizeLocation('C:\\bad\npath'), null)
  assert.equal(normalizeLocation(''), null)
  assert.equal(normalizeLocation('x'.repeat(2000)), null)
  assert.equal(bridgeContextLine('relative'), '')
  assert.match(bridgeContextLine('C:\\project'), /project directory: C:\\project/)
})

test('a bridge turn carries the task, not the native system preface', () => {
  const messages = [
    { role: 'system', content: 'NATIVE PREFACE' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' },
    { role: 'user', content: 'Again' },
  ]
  const bridge = bridgeRequestText(messages, true)
  assert.ok(!bridge.includes('NATIVE PREFACE'))
  assert.match(bridge, /Hello/)
  assert.match(bridge, /Again/)
  assert.match(bridge, /Task to carry out/)
  assert.equal(bridgeRequestText(messages, false), 'Task to carry out:\nAgain')
  // The plain text mode is the native agent answering in prose: it keeps the preface.
  assert.match(requestText(messages, true), /NATIVE PREFACE/)
})

test('a realistic native system prompt cannot overflow the CoS envelope in coding mode', async () => {
  const cos = new FakeCoS(['done'])
  const native = {
    model: 'chatgpt-default',
    messages: [
      { role: 'system', content: '## Available tools\n' + 'x'.repeat(70000) },
      { role: 'user', content: 'Fix the failing test.' },
    ],
    ...coding('read', 'bash'),
  }
  const text = await runTurn(cos, native, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_01', nativeTools: 'coding',
    location: 'C:\\project\\fixture', emit: () => undefined,
  })
  assert.equal(text, 'done')
  const admitted = cos.sent.at(-1).text
  assert.ok(admitted.length < 64000, 'the admitted input must fit the CoS envelope')
  assert.ok(!admitted.includes('## Available tools'), 'the native tool prose must not cross the bridge')
  assert.match(admitted, /Fix the failing test/)
  assert.match(admitted, /project directory: C:\\project\\fixture/)
})

test('the read bridge does not forward the native system preface either', async () => {
  const cos = new FakeCoS(['file contents'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [
      { role: 'system', content: 'NATIVE PREFACE' },
      { role: 'user', content: 'Read the file.' },
    ],
    tools: [tool('read')], tool_choice: 'auto',
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_02', nativeTools: 'read',
    location: 'C:\\project\\fixture', emit: () => undefined,
  })
  const admitted = cos.sent.at(-1).text
  assert.ok(!admitted.includes('NATIVE PREFACE'))
  assert.match(admitted, /Read the file/)
  assert.match(admitted, /<opencode-read>/)
  assert.match(admitted, /project directory: C:\\project\\fixture/)
})

test('a plain text turn keeps the native system preface', async () => {
  const cos = new FakeCoS(['Bonjour'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [
      { role: 'system', content: 'Be precise' },
      { role: 'user', content: 'Hello' },
    ],
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_03', emit: () => undefined,
  })
  assert.match(cos.sent.at(-1).text, /Be precise/)
})

test('an unusable project location is dropped, never guessed', async () => {
  const cos = new FakeCoS(['done'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [{ role: 'user', content: 'Do the work.' }],
    ...coding('bash'),
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_04', nativeTools: 'coding',
    location: 'not-absolute', emit: () => undefined,
  })
  assert.doesNotMatch(cos.sent.at(-1).text, /project directory/)
})

test('the bridge speaks first: the protocol and the project come before the task', async () => {
  const cos = new FakeCoS(['done'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [{ role: 'user', content: 'Fix the failing test.' }],
    ...coding('read', 'shell'),
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_05', nativeTools: 'coding',
    location: 'C:\\project\\fixture', emit: () => undefined,
  })
  const admitted = cos.sent.at(-1).text
  const protocol = admitted.indexOf('<opencode-tool>')
  const project = admitted.indexOf('OpenCode runs these tools in the project directory')
  const task = admitted.indexOf('Fix the failing test.')
  assert.ok(protocol >= 0 && project >= 0 && task >= 0)
  assert.ok(protocol < project, 'the protocol must precede the project context')
  assert.ok(project < task, 'the project context must precede the task')
})

test('the worked example is valid JSON and names a declared tool', async () => {
  const cos = new FakeCoS(['done'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [{ role: 'user', content: 'Look at the project.' }],
    ...coding('read', 'shell'),
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_06', nativeTools: 'coding',
    location: 'C:\\project\\fixture', emit: () => undefined,
  })
  const admitted = cos.sent.at(-1).text
  const envelopes = admitted.match(/<opencode-tool>.*?<\/opencode-tool>/g) ?? []
  const worked = envelopes.find(text => text.includes('"read"'))
  assert.ok(worked, 'a worked example must be present')
  const parsed = JSON.parse(worked.slice('<opencode-tool>'.length, -'</opencode-tool>'.length))
  assert.equal(parsed.name, 'read')
  assert.equal(parsed.arguments.path, 'C:\\project\\fixture')
})

test('the tool manifest and the project context are separated, never glued', async () => {
  const cos = new FakeCoS(['done'])
  await runTurn(cos, {
    model: 'chatgpt-default',
    messages: [{ role: 'user', content: 'Do the work.' }],
    ...coding('read', 'shell'),
  }, {
    sessionKey: 'ses_bridge_context', messageKey: 'msg_bridge_context_07', nativeTools: 'coding',
    location: 'C:\\project\\fixture', emit: () => undefined,
  })
  const admitted = cos.sent.at(-1).text
  assert.doesNotMatch(admitted, /\}OpenCode runs these tools/)
  assert.match(admitted, /Available tools:[\s\S]*?\n\nOpenCode runs these tools in the project directory/)
})
