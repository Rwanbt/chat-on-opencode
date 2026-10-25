import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CoSControl, BridgeError } from '../src/control.mjs'
import { createGateway, requestText, runTurn, stableUUID } from '../src/gateway.mjs'

const request = { model: 'chatgpt-default', messages: [{ role: 'user', content: 'Bonjour' }] }

class FakeCoS {
  constructor(events = ['Bon', 'Bonjour']) { this.sent = []; this.exists = false; this.outputs = events }
  async hasSession() { return this.exists }
  async send(payload) { this.sent.push(payload); this.exists = true; return { delivery: 'pending' } }
  async *events(id) {
    yield { seq: 1, kind: 'user_message', inputId: this.sent.at(-1).id }
    for (const [i, text] of this.outputs.entries()) {
      yield { seq: i + 2, kind: 'assistant_message', message: typeof text === 'string' ? { text, truncated: false } : text }
    }
    yield { seq: this.outputs.length + 2, kind: 'turn_end', outcome: 'completed' }
  }
}

test('UUID ownership is deterministic and valid across independent turns', () => {
  assert.match(stableUUID('session:ses_123'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(stableUUID('session:ses_123'), stableUUID('session:ses_123'))
  assert.notEqual(stableUUID('session:ses_123'), stableUUID('session:ses_124'))
})

test('extract initial system context but only latest user on CoS continuation', () => {
  const messages = [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi' }, { role: 'user', content: 'Again' }]
  assert.match(requestText(messages, true), /Be precise/)
  assert.equal(requestText(messages, false), 'Again')
  assert.throws(() => requestText([{ role: 'tool', content: 'x' }], true), /unsupported_chat_content/)
})

test('preserve a CoS session, stream only increasing text and correlate the input', async () => {
  const cos = new FakeCoS()
  const deltas = []
  assert.equal(await runTurn(cos, request, { sessionKey: 'ses_123', emit: x => deltas.push(x) }), 'Bonjour')
  assert.deepEqual(deltas, ['Bon', 'jour'])
  const first = cos.sent[0].id
  const second = await runTurn(cos, { ...request, messages: [...request.messages, { role: 'assistant', content: 'Bonjour' },
    { role: 'user', content: 'Next' }] }, { sessionKey: 'ses_123', emit: () => undefined })
  assert.equal(second, 'Bonjour')
  assert.equal(cos.sent[1].sessionId, first)
  assert.notEqual(cos.sent[1].id, first)
  assert.equal(cos.sent[1].text, 'Next')
})

test('refuse tools instead of silently dropping OpenCode tool contracts', async () => {
  const cos = new FakeCoS()
  await assert.rejects(runTurn(cos, { ...request, tools: [{ type: 'function', function: { name: 'bash' } }] },
    { sessionKey: 'ses_123', emit: () => undefined }), /native_tool_calls_not_yet_supported/)
  assert.equal(cos.sent.length, 0)
})

test('refuse clipped or rewritten CoS output, never invent a complete reply', async () => {
  await assert.rejects(runTurn(new FakeCoS([{ text: 'partial', truncated: true }]), request,
    { sessionKey: 'ses_123', emit: () => undefined }), /cos_output_incomplete/)
  await assert.rejects(runTurn(new FakeCoS(['abc', 'abd']), request,
    { sessionKey: 'ses_123', emit: () => undefined }), /cos_answer_revision_not_streamable/)
})

test('gateway authenticates, binds to local host and yields Chat Completions SSE', async t => {
  const server = createGateway({ control: new FakeCoS(), key: 't'.repeat(40) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const unauth = await fetch(url, { method: 'POST', body: JSON.stringify(request) })
  assert.equal(unauth.status, 401)
  const wrongOrigin = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}`, origin: 'https://evil.example' }, body: JSON.stringify(request) })
  assert.equal(wrongOrigin.status, 403)
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}`,
    'x-opencode-session-id': 'ses_test', 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) })
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.match(body, /"content":"Bon"/)
  assert.match(body, /"content":"jour"/)
  assert.match(body, /data: \[DONE\]/)
})

test('control API discovers only a private local protocol-1 endpoint', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cos-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(path.join(dir, 'endpoint.json'), JSON.stringify({ protocol: 1, port: 45678 }))
  await writeFile(path.join(dir, 'token'), 'k'.repeat(43) + '\n')
  const calls = []
  const cos = new CoSControl({ directory: dir, fetcher: async (url, opts) => {
    calls.push({ url, opts })
    return new Response(JSON.stringify({ ok: true, protocol: 1, actions: { enabled: true } }), { status: 200 })
  } })
  await cos.connect()
  assert.equal(calls[0].url, 'http://127.0.0.1:45678/v1/health')
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${'k'.repeat(43)}`)
  assert.equal(calls[0].opts.redirect, 'error')
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
