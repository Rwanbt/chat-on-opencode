import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CoSControl, BridgeError } from '../src/control.mjs'
import { createGateway, requestText, runTurn, stableUUID } from '../src/gateway.mjs'
import { CoSRuntime, validateRuntime } from '../src/runtime.mjs'
import { GatewayLifecycle } from '../src/lifecycle.mjs'

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

test('runtime launcher only accepts existing, isolated files and directories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cos-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = path.join(root, 'provider')
  const personal = path.join(root, 'cos')
  await mkdir(profile)
  await mkdir(personal)
  const ok = await validateRuntime({ executable: process.execPath, profile, personalProfile: personal })
  // Windows temp may be an 8.3 alias (RUNNER~1) while realpath expands it.
  assert.equal(ok.folder, await realpath(profile))
  await assert.rejects(validateRuntime({ executable: process.execPath, profile: personal, personalProfile: personal }),
    /runtime_profile_overlaps_personal/)
  await assert.rejects(validateRuntime({ executable: 'node', profile }), /isolated_runtime_not_configured/)
  await assert.rejects(validateRuntime({ executable: process.execPath, profile: path.join(root, 'missing') }),
    /runtime_path_not_found/)
})

test('service launcher uses the fork-only flag, owns exact endpoint PID and stops its child', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'cos-owned-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const token = 'z'.repeat(43)
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, protocol: 1, actions: { enabled: true } }))
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
  assert.equal(launch.opts.windowsHide, true)
  assert.equal(launch.opts.shell, false)
  runtime.stop()
  assert.equal(child.killed, true)
})

test('selected-provider lifecycle starts only one gateway, with private env, and cleans up', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) } })
  const launches = []
  const gateway = new GatewayLifecycle({ entry: 'fixture.mjs', runtimeExecutable: 'fixture-fork.exe',
    runtimeData: 'fixture-isolated', key: 'a'.repeat(40), port: 45861 }, {
    launcher: (exe, args, options) => { launches.push({ exe, args, options }); return child },
    fetcher: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:45861/health')
      assert.equal(opts.headers.Authorization, `Bearer ${'a'.repeat(40)}`)
      return Response.json({ ok: true, gateway: 'chat-on-opencode' })
    },
  })
  assert.equal(launches.length, 0) // Import and setup alone cannot launch Chromium.
  await Promise.all([gateway.ensure(), gateway.ensure()])
  assert.equal(launches.length, 1)
  assert.equal(launches[0].options.windowsHide, true)
  assert.equal(launches[0].options.shell, false)
  assert.equal(launches[0].options.env.CHAT_ON_OPENCODE_RUNTIME_EXE, 'fixture-fork.exe')
  assert.equal(launches[0].options.env.CHAT_ON_OPENCODE_RUNTIME_DATA, 'fixture-isolated')
  gateway.stop()
  assert.equal(child.killed, true)
})

test('selected-provider lifecycle refuses incomplete runtime configuration before spawning', async () => {
  let launches = 0
  const gateway = new GatewayLifecycle({ entry: 'fixture.mjs', key: '', port: 45861 }, {
    launcher: () => { launches++; throw new Error('must_not_launch') },
  })
  await assert.rejects(gateway.ensure(), /provider_runtime_not_configured/)
  assert.equal(launches, 0)
})
