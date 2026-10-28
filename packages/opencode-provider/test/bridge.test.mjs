import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CoSControl, BridgeError } from '../src/control.mjs'
import { traceStage } from '../src/stage-trace.mjs'
import { createGateway, requestText, runTurn, stableUUID } from '../src/gateway.mjs'
import { CoSRuntime, validateRuntime, validateProfileConsent } from '../src/runtime.mjs'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { startService } from '../src/service.mjs'
import { MessageIdentity } from '../plugin/message-identity.mjs'
import { enforceTextOnlyContext } from '../plugin/text-only.mjs'
import { parseReadCall, readResultPrompt, validateNativeTools } from '../src/native-read.mjs'

const validProviderConfig = JSON.parse(await readFile(new URL('./fixtures/valid-provider-config.json', import.meta.url), 'utf8'))

const request = { model: 'chatgpt-default', messages: [{ role: 'user', content: 'Bonjour' }] }

test('opt-in startup stage trace records categorical markers only and ignores invalid destinations', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'provider-stages-'))
  try {
    const target = path.join(folder, 'stages.log')
    traceStage('gateway_listening', target)
    traceStage('input_admitted', target)
    traceStage('invalid secret=123', target)
    traceStage('control_ready', 'relative.log')
    assert.equal(await readFile(target, 'utf8'), 'gateway_listening\ninput_admitted\n')
  } finally { await rm(folder, { recursive: true, force: true }) }
})

class FakeCoS {
  constructor(events = ['Bon', 'Bonjour']) { this.sent = []; this.exists = false; this.outputs = events }
  async assertReady() {}
  async readiness() { return { sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true } }
  async hasSession() { return this.exists }
  async send(payload) { this.sent.push(payload); this.exists = true; return { delivery: 'pending' } }
  async *events(id) {
    yield { seq: 1, kind: 'user_message', inputId: this.sent.at(-1).id }
    yield { seq: 2, kind: 'turn_start', turnId: 'fake-current-turn' }
    for (const [i, text] of this.outputs.entries()) {
      yield { seq: i + 3, kind: 'assistant_message', turnId: 'fake-current-turn', message: typeof text === 'string' ? { text, truncated: false } : text }
    }
    yield { seq: this.outputs.length + 3, kind: 'turn_end', turnId: 'fake-current-turn', outcome: 'completed' }
  }
}

test('follow-up ignores replayed assistant and old terminal after its input receipt', async () => {
  const cos = new FakeCoS()
  cos.exists = true
  cos.events = async function* () {
    yield { kind: 'user_message', inputId: this.sent.at(-1).id }
    yield { kind: 'assistant_message', turnId: 'previous-turn', message: { text: 'PREVIOUS', truncated: false } }
    yield { kind: 'turn_end', turnId: 'previous-turn', outcome: 'completed' }
    yield { kind: 'turn_start', turnId: 'current-turn' }
    yield { kind: 'assistant_message', turnId: 'previous-turn', message: { text: 'PREVIOUS', truncated: false } }
    yield { kind: 'assistant_message', turnId: 'current-turn', message: { text: 'NEW', truncated: false } }
    yield { kind: 'turn_end', turnId: 'current-turn', outcome: 'completed' }
  }
  const emitted = []
  const answer = await runTurn(cos, request, { sessionKey: 'ses_followup', messageKey: 'msg_followup_002', emit: delta => emitted.push(delta) })
  assert.equal(answer, 'NEW')
  assert.deepEqual(emitted, ['NEW'])
})

test('UUID ownership is deterministic and valid across independent turns', () => {
  assert.match(stableUUID('session:ses_123'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(stableUUID('session:ses_123'), stableUUID('session:ses_123'))
  assert.notEqual(stableUUID('session:ses_123'), stableUUID('session:ses_124'))
})

test('native message identity changes between identical prompts and is bounded', () => {
  const store = new MessageIdentity(2)
  store.remember('ses_repeat1', 'msg_user_00001')
  assert.equal(store.require('ses_repeat1'), 'msg_user_00001')
  store.remember('ses_repeat2', 'msg_user_00002')
  store.remember('ses_repeat3', 'msg_user_00003')
  assert.throws(() => store.require('ses_repeat1'), /opencode_message_identity_unavailable/)
  assert.throws(() => store.remember('ses_repeat1', '../bad\nrequest'), /invalid_opencode_message_identity/)
})

test('extract initial system context but only latest user on CoS continuation', () => {
  const messages = [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Again' }]
  assert.match(requestText(messages, true), /Be precise/)
  assert.equal(requestText(messages, false), 'Again')
  assert.throws(() => requestText([{ role: 'tool', content: 'x' }], true), /unsupported_chat_content/)
  assert.equal(requestText([{ role: 'user', content: [{ type: 'text', text: 'Hello' },
    { type: 'text', text: ' world' }] }], false), 'Hello world')
  assert.throws(() => requestText([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png' } }] }], false),
    /unsupported_chat_content/)
})

test('identical user text in distinct native messages yields distinct CoS inputs', async () => {
  const cos = new FakeCoS()
  const args = { sessionKey: 'ses_repeat', emit: () => undefined }
  await runTurn(cos, request, { ...args, messageKey: 'msg_repeat1' })
  await runTurn(cos, request, { ...args, messageKey: 'msg_repeat2' })
  await runTurn(cos, request, { ...args, messageKey: 'msg_repeat2' })
  assert.equal(cos.sent[0].id, stableUUID('session:ses_repeat'))
  assert.notEqual(cos.sent[1].id, cos.sent[0].id)
  assert.equal(cos.sent[1].id, cos.sent[2].id)
  assert.equal(cos.sent[1].text, cos.sent[2].text)
})

test('preserve a CoS session, stream only increasing text and correlate the input', async () => {
  const cos = new FakeCoS()
  const deltas = []
  assert.equal(await runTurn(cos, request, { sessionKey: 'ses_123', messageKey: 'msg_first_0001', emit: x => deltas.push(x) }), 'Bonjour')
  assert.deepEqual(deltas, ['Bon', 'jour'])
  const first = cos.sent[0].id
  const second = await runTurn(cos, { ...request, messages: [...request.messages, { role: 'assistant', content: 'Bonjour' },
    { role: 'user', content: 'Next' }] }, { sessionKey: 'ses_123', messageKey: 'msg_second_0002', emit: () => undefined })
  assert.equal(second, 'Bonjour')
  assert.equal(cos.sent[1].sessionId, first)
  assert.notEqual(cos.sent[1].id, first)
  assert.equal(cos.sent[1].text, 'Next')
})

test('gateway evidence correlates assistant revisions to the admitted turn without exposing text', async () => {
  const cos = new FakeCoS()
  const evidence = []
  const emitted = []
  const answer = await runTurn(cos, request, {
    sessionKey:'ses_evidence', messageKey:'msg_evidence_001',
    emit:delta => emitted.push(delta),
    onEvidence:entry => { evidence.push(entry); if(entry.stage === 'turn_started') throw Error('observer_must_not_abort') },
  })
  assert.equal(answer,'Bonjour')
  assert.deepEqual(emitted,['Bon','jour'])
  assert.deepEqual(evidence.map(item => item.stage),[
    'input_admitted','turn_started','assistant_revision','native_delta_emitted',
    'assistant_revision','native_delta_emitted','turn_completed',
  ])
  assert.ok(evidence.every(entry => entry.sessionID === stableUUID('session:ses_evidence')))
  assert.ok(evidence.every(entry => entry.messageKey === 'msg_evidence_001'))
  assert.ok(evidence.slice(1).every(entry => entry.turnId === 'fake-current-turn'))
  assert.ok(evidence.every(entry => Number.isSafeInteger(entry.atMs)))
  assert.equal(JSON.stringify(evidence).includes('Bonjour'),false)
  assert.equal(JSON.stringify(evidence).includes('Bon'),false)
})

test('refuse tools instead of silently dropping OpenCode tool contracts', async () => {
  const cos = new FakeCoS()
  await assert.rejects(runTurn(cos, { ...request, tools: [{ type: 'function', function: { name: 'bash' } }] },
    { sessionKey: 'ses_123', messageKey: 'msg_tests_0001', emit: () => undefined }), /native_tools_explicit_consent_required/)
  assert.equal(cos.sent.length, 0)
})

test('refuse delivery while the isolated browser has no authenticated-session hint or companion', async () => {
  const cos = new FakeCoS()
  cos.assertReady = async () => { throw new BridgeError('chatgpt_sign_in_required', 503) }
  await assert.rejects(runTurn(cos, request, {
    sessionKey: 'no_login', messageKey: 'msg_no_login_1', emit: () => undefined,
  }), error => error instanceof BridgeError && error.code === 'chatgpt_sign_in_required')
  assert.equal(cos.sent.length, 0)
})

test('readiness endpoint distinguishes cookie, pairing and extension without exposing account data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cos-auth-'))
  try {
    const requests = []
    const control = new CoSControl({ directory: dir, fetcher: async url => {
      requests.push(url)
      return new Response(JSON.stringify({ sessionCookie: 'absent', extension: 'disconnected',
        paired: false, canAttempt: false }), { status: 200 })
    } })
    control.base = 'http://127.0.0.1:47898'
    control.token = 't'.repeat(40)
    await assert.rejects(control.assertReady(), /chatgpt_sign_in_required/)
    assert.deepEqual(requests, ['http://127.0.0.1:47898/v1/provider/readiness'])
    control.fetcher = async () => new Response(JSON.stringify({
      sessionCookie: 'present', extension: 'disconnected', paired: true, canAttempt: false,
    }), { status: 200 })
    await assert.rejects(control.assertReady(), /cos_companion_not_connected/)
    control.fetcher = async () => new Response(JSON.stringify({
      sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true,
    }), { status: 200 })
    await control.assertReady()
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('text-only context gate is provider-scoped, never modifies another provider tools', () => {
  const tools = { bash: { description: 'exec' }, read: { description: 'read' } }
  const other = { model: { providerID: 'anthropic' }, tools: { ...tools } }
  assert.equal(enforceTextOnlyContext(other), false)
  assert.deepEqual(other.tools, tools)
  const ours = { model: { providerID: 'chat-on-opencode' }, tools: { ...tools } }
  assert.equal(enforceTextOnlyContext(ours), true)
  assert.deepEqual(ours.tools, {})
  const enabled = { model: { providerID: 'chat-on-opencode' }, tools: { ...tools } }
  assert.equal(enforceTextOnlyContext(enabled, true), true)
  assert.deepEqual(Object.keys(enabled.tools), ['read'])
})

test('read parity validates exact single tool, arguments, output and native result identity', async () => {
  const defined = [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }]
  assert.equal(validateNativeTools({ tools: defined, tool_choice: 'auto' }, true), true)
  for (const name of ['bash', 'write', 'edit', 'task', 'read_bash']) {
    assert.throws(() => validateNativeTools({ tools: [{
      type: 'function', function: { name, parameters: {} },
    }] }, true), /native_tool_not_allowlisted/)
  }
  const cos = new FakeCoS(['<opencode-read>{"name":"read","arguments":{"path":"D:/scratch/approved.txt"}}</opencode-read>'])
  const result = await runTurn(cos, { ...request, tools: defined }, { sessionKey: 'ses_native_read', messageKey: 'msg_native_read1',
    nativeTools: 'read', emit: () => { throw new Error('tool text must not stream') } })
  assert.equal(result.toolCall.function.name, 'read')
  assert.equal(JSON.parse(result.toolCall.function.arguments).path, 'D:/scratch/approved.txt')
  const text = readResultPrompt([{ role: 'assistant', tool_calls: [result.toolCall] },
    { role: 'tool', tool_call_id: result.toolCall.id, content: 'READ_CONTENT' }])
  assert.ok(text.text.includes('READ_CONTENT'))
  assert.throws(() => readResultPrompt([{ role: 'assistant', tool_calls: [result.toolCall] },
    { role: 'tool', tool_call_id: 'call_bad', content: 'READ_CONTENT' }]), /native_tool_result_identity_invalid/)
  for (const payload of [
    '<opencode-read>{"name":"bash","arguments":{"command":"dir"}}</opencode-read>',
    '<opencode-read>{"name":"read","arguments":{"path":"a","other":1}}</opencode-read>',
    '<opencode-read>{"name":"read","arguments":{"path":"a"}}</opencode-read> extra',
  ]) assert.throws(() => parseReadCall(payload, true, 'ses_test', 'msg_native_read1'), /native_read_(envelope|arguments)_invalid/)
})

test('OpenAI compatible automatic tool choice without tool schemas is text-only', async () => {
  const cos = new FakeCoS()
  const text = await runTurn(cos, { ...request, tool_choice: 'auto', tools: [] }, {
    sessionKey: 'ses_text_only', messageKey: 'msg_textonly_1', emit: () => undefined,
  })
  assert.equal(text, 'Bonjour')
  assert.equal(cos.sent.length, 1)
})

test('refuse clipped or rewritten CoS output, never invent a complete reply', async () => {
  await assert.rejects(runTurn(new FakeCoS([{ text: 'partial', truncated: true }]), request,
    { sessionKey: 'ses_123', messageKey: 'msg_tests_0002', emit: () => undefined }), /cos_output_incomplete/)
  await assert.rejects(runTurn(new FakeCoS(['abc', 'abd']), request,
    { sessionKey: 'ses_123', messageKey: 'msg_tests_0003', emit: () => undefined }), /cos_answer_revision_not_streamable/)
})

test('a cancelled OpenCode request stops only its exact observed CoS turn', async () => {
  const abort = new AbortController()
  const calls = []
  const evidence = []
  const cos = new FakeCoS()
  cos.stop = async (session, turn) => { calls.push({ session, turn }); return { stopped:true } }
  cos.events = async function* () {
    yield { kind: 'user_message', inputId: this.sent.at(-1).id, seq: 1 }
    yield { kind: 'turn_start', turnId: 'proven-turn-42', seq: 2 }
    yield { kind: 'assistant_message', turnId: 'proven-turn-42', seq: 3, message: { text: 'partial', truncated: false } }
    yield { kind: 'turn_end', turnId: 'proven-turn-42', seq: 4, outcome: 'completed' }
  }
  await assert.rejects(runTurn(cos, request, { sessionKey: 'ses_cancel', messageKey: 'msg_cancel_0001', signal: abort.signal,
    emit: () => { abort.abort() }, onEvidence:row => evidence.push(row) }), /opencode_turn_cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [{ session: stableUUID('session:ses_cancel'), turn: 'proven-turn-42' }])
  assert.deepEqual(evidence.filter(row => /^(turn_stop_requested|cancel_command_acknowledged)$/.test(row.stage))
    .map(row => [row.stage,row.turnId]), [
    ['turn_stop_requested','proven-turn-42'],
    ['cancel_command_acknowledged','proven-turn-42'],
  ])
})

test('synchronous Stop transport failure is recorded as unconfirmed for the exact turn', async () => {
  const abort = new AbortController()
  const evidence = []
  const cos = new FakeCoS()
  cos.stop = () => { throw Error('test_transport_sync_failure') }
  cos.events = async function* () {
    yield { kind:'user_message', inputId:this.sent.at(-1).id, seq:1 }
    yield { kind:'turn_start', turnId:'owned-turn-sync-fail', seq:2 }
    yield { kind:'assistant_message', turnId:'owned-turn-sync-fail', seq:3,
      message:{ text:'partial', truncated:false } }
  }
  await assert.rejects(runTurn(cos, request, {
    sessionKey:'ses_sync_stop', messageKey:'msg_sync_stop_001', signal:abort.signal,
    emit:() => abort.abort(), onEvidence:row => evidence.push(row),
  }), /opencode_turn_cancelled/)
  assert.deepEqual(evidence.filter(row => /^(turn_stop_requested|cancel_command_unconfirmed)$/.test(row.stage))
    .map(row => [row.stage,row.turnId]), [
    ['turn_stop_requested','owned-turn-sync-fail'],
    ['cancel_command_unconfirmed','owned-turn-sync-fail'],
  ])
})

test('abort before admission never sends a prompt; abort before turn proof only attempts outbox cancel', async () => {
  const already = new AbortController()
  already.abort()
  const cos = new FakeCoS()
  await assert.rejects(runTurn(cos, request, { sessionKey: 'ses_cancel', messageKey: 'msg_cancel_0002', signal: already.signal,
    emit: () => undefined }), /opencode_turn_cancelled/)
  assert.equal(cos.sent.length, 0)

  const late = new AbortController()
  const cancels = []
  const noProof = new FakeCoS()
  noProof.cancelInput = async id => cancels.push(id)
  noProof.events = async function* () { late.abort(); yield { kind: 'user_message', inputId: this.sent.at(-1).id } }
  await assert.rejects(runTurn(noProof, request, { sessionKey: 'ses_unknown', messageKey: 'msg_cancel_0003', signal: late.signal,
    emit: () => undefined }), /opencode_turn_cancelled/)
  assert.deepEqual(cancels, [noProof.sent[0].id])
})

test('gateway authenticates, binds to local host and yields Chat Completions SSE', async t => {
  const evidence = []
  const server = createGateway({ control: new FakeCoS(), key: 't'.repeat(40),
    onEvidence:entry => evidence.push(entry) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const unauth = await fetch(url, { method: 'POST', body: JSON.stringify(request) })
  assert.equal(unauth.status, 401)
  const wrongOrigin = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}`, origin: 'https://evil.example' }, body: JSON.stringify(request) })
  assert.equal(wrongOrigin.status, 403)
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}`,
    'x-opencode-session-id': 'ses_test', 'x-opencode-message-id': 'msg_http_0001',
    'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /"content":"Bon"/)
  assert.match(body, /"content":"jour"/)
  assert.match(body, /data: \[DONE\]/)
  assert.deepEqual(evidence.map(entry => entry.stage), [
    'input_admitted','turn_started','assistant_revision','native_delta_emitted',
    'assistant_revision','native_delta_emitted','turn_completed',
  ])
  assert.ok(evidence.every(entry => entry.sessionID === stableUUID('session:ses_test')))
  assert.ok(evidence.every(entry => entry.messageKey === 'msg_http_0001'))
  assert.ok(evidence.slice(1).every(entry => entry.turnId === 'fake-current-turn'))
  assert.ok(evidence.every(entry => Number.isSafeInteger(entry.atMs)))
  assert.equal(JSON.stringify(evidence).includes('Bonjour'), false)
})

test('gateway preserves split UTF-8 and rejects malformed or oversized byte bodies before dispatch', async t => {
  const control = new FakeCoS()
  const server = createGateway({ control, key: 'z'.repeat(40) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  let n = 0
  async function send(chunks) {
    const messageID = `msg_utf8_${++n}00001`
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: server.address().port,
        method: 'POST', path: '/v1/chat/completions', headers: {
          authorization: `Bearer ${'z'.repeat(40)}`,
          'x-opencode-session-id': 'ses_utf8',
          'x-opencode-message-id': messageID,
          'content-type': 'application/json',
        },
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', part => { body += part })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      })
      req.on('error', reject)
      void (async () => {
        for (const [i, part] of chunks.entries()) {
          req.write(part)
          if (i !== chunks.length - 1) await new Promise(done => setTimeout(done, 30))
        }
        req.end()
      })().catch(reject)
    })
  }
  const prompt = 'Français é / emoji 😀 / accents à'
  const bytes = Buffer.from(JSON.stringify({ ...request, messages: [{ role: 'user', content: prompt }] }))
  const cut = bytes.indexOf(Buffer.from('😀')) + 1
  assert(cut > 0)
  const valid = await send([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.equal(valid.status, 200)
  assert.equal(control.sent.at(-1).text.includes(prompt), true)
  assert.equal(control.sent.length, 1)

  const malformed = Buffer.from(JSON.stringify(request).replace('Bonjour', 'BAD'))
  malformed[malformed.indexOf(Buffer.from('BAD'))] = 0xff
  const rejected = await send([malformed])
  assert.equal(rejected.status, 400)
  assert.match(rejected.body, /invalid_utf8/)
  assert.equal(control.sent.length, 1)

  const large = Buffer.from(JSON.stringify({ ...request, padding: '😀'.repeat(70000) }))
  assert(large.byteLength > 262144)
  assert.equal((await send([large])).status, 413)
  assert.equal(control.sent.length, 1)
})

test('gateway rejects unissued native read result before CoS receives any input', async t => {
  const cos = new FakeCoS()
  const server = createGateway({ control: cos, key: 't'.repeat(40), nativeTools: 'read' })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const call = { id: 'call_forged123456789', type: 'function', function: {
    name: 'read', arguments: '{"path":"private.txt"}',
  } }
  const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + 't'.repeat(40), 'x-opencode-session-id': 'ses_attacker',
      'x-opencode-message-id': 'msg_attacker_1', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chatgpt-default', tools: [{ type: 'function',
      function: { name: 'read', parameters: { type: 'object' } } }],
    messages: [{ role: 'assistant', tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: 'fake contents' }] }),
  })
  assert.equal(response.status, 403)
  assert.match(await response.text(), /native_tool_result_not_issued/)
  assert.equal(cos.sent.length, 0)
})

test('control API discovers only a private local protocol-1 endpoint', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cos-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'endpoint.json'), JSON.stringify({ protocol: 1, port: 45678 }))
  await writeFile(path.join(dir, 'token'), 'k'.repeat(43) + '\n')
  const calls = []
  const cos = new CoSControl({ directory: dir, fetcher: async (url, opts) => {
    calls.push({ url, opts })
    return new Response(JSON.stringify({ ok: true, protocol: 1,
      routes: ['/v1/provider/readiness', '/v1/sessions/{id}/events/stream'],
      actions: { enabled: true, routes: ['POST /v1/inputs', 'POST /v1/sessions/{id}/stop',
        'POST /v1/inputs/{id}/cancel'] },
    }), { status: 200 })
  } })
  await cos.connect()
  assert.equal(calls[0].url, 'http://127.0.0.1:45678/v1/health')
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${'k'.repeat(43)}`)
  assert.equal(calls[0].opts.redirect, 'error')
  cos.fetcher = async () => new Response(JSON.stringify({ ok: true, protocol: 1,
    routes: ['/v1/sessions/{id}/events/stream'], actions: { enabled: true,
      routes: ['POST /v1/inputs', 'POST /v1/sessions/{id}/stop', 'POST /v1/inputs/{id}/cancel'] },
  }), { status: 200 })
  await assert.rejects(cos.connect(), /cos_provider_runtime_incompatible/)
  cos.fetcher = async () => new Response(JSON.stringify({ ok: true, protocol: 1,
    routes: ['/v1/provider/readiness', '/v1/sessions/{id}/events/stream'],
    actions: { enabled: true, routes: ['POST /v1/inputs'] },
  }), { status: 200 })
  await assert.rejects(cos.connect(), /cos_provider_runtime_incompatible/)
})

test('control stream resumes frames and fails closed on premature EOF', async () => {
  const cos = new CoSControl({ directory: os.tmpdir(), fetcher: async () => new Response('id: 4\nevent: assistant_message\ndata: {"seq":4,"kind":"assistant_message"}\n\n') })
  cos.base = 'http://127.0.0.1:47898'
  cos.token = 't'.repeat(40)
  const got = []
  await assert.rejects(async () => { for await (const item of cos.events('12345678', { from: 5 })) got.push(item) },
    error => error instanceof BridgeError && error.code === 'cos_stream_ended_without_terminal')
  assert.deepEqual(got, []) // The duplicate last sequence is not emitted again.
})

test('renew a timed-out CoS SSE stream by cursor without repeating input', async () => {
  const routes = []
  const payloads = [
    'id: 1\nevent: assistant_message\ndata: {"seq":1,"kind":"assistant_message","message":{"text":"partial"}}\n\nevent: end\ndata: {"reason":"max_duration"}\n\n',
    'id: 2\nevent: turn_end\ndata: {"seq":2,"kind":"turn_end","outcome":"completed"}\n\n',
  ]
  const control = new CoSControl({ directory: os.tmpdir(), fetcher: async (url, options) => {
    assert.equal(options.method, 'GET')
    routes.push(url)
    return new Response(payloads.shift() ?? 'event: end\ndata: {"reason":"error"}\n\n')
  } })
  control.base = 'http://127.0.0.1:47898'
  control.token = 'r'.repeat(43)
  const events = []
  for await (const event of control.events('12345678')) {
    events.push(event)
    if (event.kind === 'turn_end') break
  }
  assert.deepEqual(events.map(event => event.seq), [1, 2])
  assert.equal(routes.length, 2)
  assert.match(routes[0], /from=0&full=1$/)
  assert.match(routes[1], /from=2&full=1$/)
})

test('runtime launcher only accepts existing, isolated files and directories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cos-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = path.join(root, 'provider')
  const personal = path.join(root, 'cos')
  await mkdir(profile)
  await mkdir(personal)
  await assert.rejects(validateRuntime({ executable: process.execPath, profile, personalProfile: personal }),
    /isolated_profile_not_initialized/)
  await writeFile(path.join(profile, 'config.json'), JSON.stringify(validProviderConfig))
  const ok = await validateRuntime({ executable: process.execPath, profile, personalProfile: personal })
  // Windows temp may be an 8.3 alias (RUNNER~1) while realpath expands it.
  assert.equal(ok.folder, await realpath(profile))
  await assert.rejects(validateRuntime({ executable: process.execPath, profile: personal, personalProfile: personal }),
    /runtime_profile_overlaps_personal/)
  await assert.rejects(validateRuntime({ executable: 'node', profile }), /isolated_runtime_not_configured/)
  await assert.rejects(validateRuntime({ executable: process.execPath, profile: path.join(root, 'missing') }),
    /runtime_path_not_found/)
})

test('runtime refuses unconsented or damaged isolated CoS profile before any process spawn', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cos-no-consent-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const config = path.join(profile, 'config.json')
  await assert.rejects(validateProfileConsent(profile), /isolated_profile_not_initialized/)
  await writeFile(config, '{ broken')
  await assert.rejects(validateProfileConsent(profile), /isolated_profile_config_unreadable/)
  await writeFile(config, JSON.stringify({ ui: { chatBrowser: 'chrome' }, controlApi: { enabled: true, allowActions: true } }))
  await assert.rejects(validateProfileConsent(profile), /isolated_profile_has_no_provider_consent/)
  await writeFile(config, JSON.stringify({ ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: false } }))
  await assert.rejects(validateProfileConsent(profile), /isolated_profile_has_no_provider_consent/)
  await writeFile(config, JSON.stringify({ ui:{chatBrowser:'cos'}, controlApi:{enabled:true,allowActions:true} }))
  await assert.rejects(validateProfileConsent(profile), /isolated_profile_config_incomplete/)
  await writeFile(config, JSON.stringify(validProviderConfig))
  await validateProfileConsent(profile)
})

test('service launcher uses the fork-only flag, owns exact endpoint PID and stops its child', async t => {
  const inherited = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS']
  const originals = Object.fromEntries(inherited.map(name => [name, process.env[name]]))
  t.after(() => { for (const name of inherited) {
    if (originals[name] === undefined) delete process.env[name]
    else process.env[name] = originals[name]
  } })
  process.env.ELECTRON_RUN_AS_NODE = '1'
  process.env.ELECTRON_NO_ASAR = '1'
  process.env.NODE_OPTIONS = '--inspect=0'
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cos-owned-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await writeFile(path.join(profile, 'config.json'), JSON.stringify(validProviderConfig))
  const token = 'z'.repeat(43)
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: 1,
      routes: ['/v1/provider/readiness', '/v1/sessions/{id}/events/stream'],
      actions: { enabled: true, routes: ['POST /v1/inputs', 'POST /v1/sessions/{id}/stop',
        'POST /v1/inputs/{id}/cancel'] },
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const directory = path.join(profile, 'control-api')
  await mkdir(directory)
  await writeFile(path.join(directory, 'endpoint.json'), JSON.stringify({ protocol: 1, port: server.address().port, pid: 12345 }))
  await writeFile(path.join(directory, 'token'), token)
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, killed: false,
    kill(signal) { assert.equal(signal, 'SIGTERM'); this.killed = true; this.emit('exit', 0) } })
  let launch
  const runtime = new CoSRuntime({ executable: process.execPath, profile }, { launcher: (exe, args, opts) => {
    launch = { exe, args, opts }
    return child
  } })
  const control = await runtime.start()
  assert.equal(control.endpointPid, child.pid)
  assert.deepEqual(launch.args, ['--chat-on-opencode-provider-service'])
  assert.equal(launch.opts.env.CHAT_ON_OPENCODE_USERDATA_DIR, await realpath(profile))
  assert.equal(launch.opts.env.CHAT_ON_OPENCODE_OWNER_PID, String(process.pid))
  assert.equal(launch.opts.env.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
  for (const name of inherited) assert.equal(launch.opts.env[name], undefined, `${name} leaked to Electron helper`)
  assert.equal(launch.opts.windowsHide, true)
  assert.equal(launch.opts.shell, false)
  assert.deepEqual(launch.opts.stdio, ['ignore', 'ignore', 'pipe'])
  runtime.stop()
  assert.equal(child.killed, true)
})

test('early packaged Electron profile refusal is classified without propagating native stderr', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cos-profile-refusal-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await writeFile(path.join(profile, 'config.json'), JSON.stringify(validProviderConfig))
  const stderr = new EventEmitter()
  const child = Object.assign(new EventEmitter(), { pid: 12345, stderr, exitCode: null, killed: false,
    kill() { this.killed = true },
  })
  const runtime = new CoSRuntime({ executable: process.execPath, profile }, {
    launcher: () => {
      queueMicrotask(() => {
        stderr.emit('data', Buffer.from('Provider service refused: invalid isolated pro'))
        stderr.emit('data', Buffer.from('file\nSECRET_MUST_NOT_LEAK'))
        child.exitCode = 1
        child.emit('exit', 1)
      })
      return child
    },
  })
  await assert.rejects(runtime.start(), error => {
    assert.equal(error.code, 'runtime_profile_refused')
    assert.ok(!JSON.stringify(error).includes('SECRET_MUST_NOT_LEAK'))
    return true
  })
})

test('service launcher immediately rejects an old advertised API without waiting for readiness timeout', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cos-incompatible-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  await writeFile(path.join(profile, 'config.json'), JSON.stringify(validProviderConfig))
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: 1, routes: [], actions: { enabled: true, routes: [] } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const directory = path.join(profile, 'control-api')
  await mkdir(directory)
  await writeFile(path.join(directory, 'endpoint.json'), JSON.stringify({ protocol: 1, port: server.address().port, pid: 12346 }))
  await writeFile(path.join(directory, 'token'), 'z'.repeat(43))
  const child = Object.assign(new EventEmitter(), { pid: 12346, exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) } })
  const runtime = new CoSRuntime({ executable: process.execPath, profile, startupTimeoutMs: 1000 }, {
    launcher: () => child,
  })
  await assert.rejects(runtime.start(), /cos_provider_runtime_incompatible/)
  assert.equal(child.killed, true)
})

test('selected-provider lifecycle starts only one gateway, with private env, and cleans up', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 43210, exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) } })
  const launches = []
  const gateway = new GatewayLifecycle({ entry: 'fixture.mjs', runtimeExecutable: 'fixture-fork.exe',
    runtimeData: 'fixture-isolated', key: 'a'.repeat(40), port: 45861, node: process.execPath }, {
    launcher: (exe, args, options) => { launches.push({ exe, args, options }); return child },
    fetcher: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:45861/health')
      assert.equal(opts.headers.Authorization, `Bearer ${'a'.repeat(40)}`)
      return Response.json({ ok: true, gateway: 'chat-on-opencode', pid: 43210 })
    },
  })
  assert.equal(launches.length, 0) // Import and setup alone cannot launch Chromium.
  await Promise.all([gateway.ensure(), gateway.ensure()])
  assert.equal(launches.length, 1)
  assert.equal(launches[0].options.windowsHide, true)
  assert.equal(launches[0].options.shell, false)
  assert.deepEqual(launches[0].args, ['fixture.mjs', '--owned-ipc'])
  assert.deepEqual(launches[0].options.stdio, ['ignore', 'ignore', 'ignore', 'ipc'])
  assert.equal(launches[0].options.env.CHAT_ON_OPENCODE_RUNTIME_EXE, 'fixture-fork.exe')
  assert.equal(launches[0].options.env.CHAT_ON_OPENCODE_RUNTIME_DATA, 'fixture-isolated')
  gateway.stop()
  assert.equal(child.killed, true)
})

test('owned gateway refuses startup without an actual live parent IPC channel', async () => {
  let started = false
  const owner = Object.assign(new EventEmitter(), { connected: false, exit: () => {} })
  await assert.rejects(startService({
    runtime: { start() { started = true }, stop() {} }, owner, owned: true, key: 'k'.repeat(40), port: 45861,
  }), /provider_parent_ipc_required/)
  assert.equal(started, false)
})

test('parent IPC disconnect during pending runtime.start kills it and forbids late listener', async () => {
  const exits = []
  const owner = Object.assign(new EventEmitter(), {
    channel: {}, connected: true, exit: code => exits.push(code),
  })
  let finishStartup
  let stopped = 0
  let listeners = 0
  const runtime = {
    start: () => new Promise(resolve => { finishStartup = resolve }),
    stop: () => { stopped++ },
  }
  const pending = startService({
    runtime, key: 'k'.repeat(40), port: 45861, owner, owned: true,
    gatewayFactory: () => { listeners++; throw new Error('late_listener_created') },
  })
  owner.connected = false
  owner.emit('disconnect')
  owner.emit('disconnect')
  assert.equal(stopped, 1)
  assert.deepEqual(exits, [0])
  finishStartup({})
  await pending
  assert.equal(listeners, 0)
})

test('parent IPC disconnect after listen closes sockets and stops the CoS runtime once', async () => {
  const owner = Object.assign(new EventEmitter(), { channel: {}, connected: true })
  const activity = []
  const server = Object.assign(new EventEmitter(), {
    listen: () => activity.push('listen'),
    closeAllConnections: () => activity.push('connections_closed'),
    close: () => activity.push('server_closed'),
  })
  const runtime = {
    start: async () => ({}),
    stop: () => activity.push('runtime_stopped'),
  }
  await startService({
    runtime, owner, owned: true, port: 45861, key: 'a'.repeat(40),
    gatewayFactory: () => server, exit: code => activity.push('exit_' + code),
  })
  owner.connected = false
  owner.emit('disconnect')
  owner.emit('SIGTERM')
  assert.deepEqual(activity, ['listen', 'connections_closed', 'server_closed', 'runtime_stopped', 'exit_0'])
})

test('legacy direct offline service still starts without IPC', async () => {
  const owner = new EventEmitter()
  let listening = false
  const server = Object.assign(new EventEmitter(), { listen() { listening = true }, close() {} })
  await startService({
    runtime: { start: async () => ({}), stop() {} }, owner, key: 'q'.repeat(40),
    port: 45861, gatewayFactory: () => server, exit() {},
  })
  assert.equal(listening, true)
})

test('gateway rejects an authenticated, stale listener with the wrong process owner', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 43210, exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) } })
  const lifecycle = new GatewayLifecycle({ entry: 'entry.mjs', runtimeExecutable: 'offline.exe',
    runtimeData: 'isolated', key: 'm'.repeat(40), node: process.execPath }, {
    launcher: () => child,
    fetcher: async () => Response.json({ ok: true, gateway: 'chat-on-opencode', pid: 99999 }),
  })
  await assert.rejects(lifecycle.ensure(), /provider_gateway_owner_mismatch/)
  assert.equal(child.killed, true)
})

test('selected-provider lifecycle refuses incomplete runtime configuration before spawning', async () => {
  let launches = 0
  const gateway = new GatewayLifecycle({ entry: 'fixture.mjs', key: '', port: 45861 }, {
    launcher: () => { launches++; throw new Error('must_not_launch') },
  })
  await assert.rejects(gateway.ensure(), /provider_runtime_not_configured/)
  assert.equal(launches, 0)
  const noNode = new GatewayLifecycle({ entry: 'fixture.mjs', runtimeExecutable: 'fork.exe',
    runtimeData: 'isolated', key: 'a'.repeat(40), node: 'opencode' }, {
    launcher: () => { launches++; throw new Error('must_not_launch') },
  })
  await assert.rejects(noNode.ensure(), /provider_runtime_not_configured/)
  assert.equal(launches, 0)
})

test('foreign control endpoint is rejected before any network request or token exposure', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cos-foreign-owner-'))
  t.after(() => rm(folder, { recursive:true, force:true }))
  await writeFile(path.join(folder, 'endpoint.json'), JSON.stringify({ protocol:1, port:54321, pid:7444 }))
  await writeFile(path.join(folder, 'token'), 'z'.repeat(43))
  let networkCalls = 0
  const control = new CoSControl({ directory:folder, fetcher:async () => { networkCalls++; throw Error('foreign network forbidden') } })
  await assert.rejects(control.connect({expectedPid:12345}), /runtime_endpoint_pid_mismatch/)
  assert.equal(networkCalls,0)
  assert.equal(control.base,undefined)
  assert.equal(control.token,undefined)
})

test('live isolated endpoint refuses second runtime before a child is launched', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cos-occupied-owner-'))
  t.after(() => rm(folder, {recursive:true, force:true}))
  await writeFile(path.join(folder, 'config.json'), JSON.stringify(validProviderConfig))
  const controlDir = path.join(folder,'control-api')
  await mkdir(controlDir)
  await writeFile(path.join(controlDir,'endpoint.json'), JSON.stringify({protocol:1,pid:process.pid,port:23001}))
  let launched = false
  const runtime = new CoSRuntime({executable:process.execPath,profile:folder}, {
    launcher:() => { launched = true; throw Error('must_not_spawn') },
  })
  await assert.rejects(runtime.start(), /runtime_profile_endpoint_occupied/)
  assert.equal(launched,false)
  assert.equal(JSON.parse(await readFile(path.join(controlDir,'endpoint.json'),'utf8')).pid,process.pid)
})

test('dead previous endpoint is never contacted while new owned child publishes its endpoint', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'cos-stale-cold-'))
  t.after(() => rm(folder, {recursive:true,force:true}))
  await writeFile(path.join(folder,'config.json'),JSON.stringify(validProviderConfig))
  const controlDir = path.join(folder,'control-api')
  await mkdir(controlDir)
  const stalePid = 2147483000
  const newPid = 2147483001
  await writeFile(path.join(controlDir,'endpoint.json'),JSON.stringify({protocol:1,pid:stalePid,port:1}))
  await writeFile(path.join(controlDir,'token'),'z'.repeat(43))
  let healthReads = 0
  const server = createServer((req,res) => {
    healthReads++
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({protocol:1,ok:true,actions:{enabled:true,routes:[
      'POST /v1/inputs','POST /v1/sessions/{id}/stop','POST /v1/inputs/{id}/cancel']},
      routes:['/v1/provider/readiness','/v1/sessions/{id}/events/stream']}))
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  t.after(() => server.close())
  const child = new EventEmitter()
  child.pid = newPid; child.exitCode = null; child.killed = false
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  let cycles = 0
  const runtime = new CoSRuntime({executable:process.execPath,profile:folder,startupTimeoutMs:1500}, {
    launcher:() => child,
    clock:async () => {
      cycles++
      await writeFile(path.join(controlDir,'endpoint.json'),JSON.stringify({
        protocol:1,pid:newPid,port:server.address().port}))
    },
  })
  const control = await runtime.start()
  assert.equal(control.endpointPid,newPid)
  assert.equal(cycles,1)
  assert.equal(healthReads,1,'stale endpoint must never receive a request')
  runtime.stop()
})
