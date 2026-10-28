import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createGateway, runTurn, stableUUID } from '../src/gateway.mjs'
import { MessageIdentity, pinProviderMessage, bindProviderMessage } from '../plugin/message-identity.mjs'

const timeout = (ms, code) => new Promise((_, reject) => setTimeout(() => reject(Error(code)), ms))

test('native provider switch preserves the pinned request identity across asynchronous startup', () => {
  const identities = new MessageIdentity()
  identities.remember('session-switch', 'message-original-001')
  const model = { providerID: 'chat-on-opencode' }
  const original = { model, sessionID: 'session-switch', headers: {} }
  assert.equal(pinProviderMessage(original, identities), true)
  identities.remember('session-switch', 'message-foreign-002')
  const foreign = { model: { providerID: 'other-native-provider' }, sessionID: 'session-switch', headers: {} }
  assert.equal(pinProviderMessage(foreign, identities), false)
  assert.deepEqual(foreign.headers, {}, 'other providers remain untouched')
  const delayedHTTP = { model, sessionID: 'session-switch', request: new Request('http://127.0.0.1:1/v1/chat/completions', { headers: original.headers }) }
  assert.equal(bindProviderMessage(delayedHTTP, identities), true)
  assert.equal(delayedHTTP.request.headers.get('x-opencode-message-id'), 'message-original-001')
  assert.equal(delayedHTTP.request.headers.get('x-opencode-session-id'), 'session-switch')
  assert.throws(() => bindProviderMessage({ ...delayedHTTP, sessionID: 'other-session' }, identities),
    /opencode_request_identity_mismatch/)
})

test('Windows loopback provider switch cancels a pending session lookup and retains the CoS session',
  { timeout: 9000 }, async t => {
    const sent = []
    let beganLookup
    const lookupStarted = new Promise(resolve => { beganLookup = resolve })
    let releaseLookup
    const hungLookup = new Promise(resolve => { releaseLookup = resolve })
    let hang = false
    const control = {
      async hasSession() {
        if (hang) { hang = false; beganLookup(); return hungLookup }
        return sent.length > 0
      },
      async readiness() { return { sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true } },
      async assertReady() {},
      async send(input) { sent.push(input); return { delivery: 'pending' } },
      async *events() {
        yield { kind: 'user_message', inputId: sent.at(-1).id }
        yield { kind: 'turn_start', turnId: 'exact-observed-turn-' + sent.length }
        yield { kind: 'assistant_message', turnId: 'exact-observed-turn-' + sent.length, message: { text: 'CoS-' + sent.length } }
        yield { kind: 'turn_end', turnId: 'exact-observed-turn-' + sent.length, outcome: 'completed' }
      },
    }
    const gateway = createGateway({ control, key: 'p'.repeat(48) })
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
    t.after(() => { releaseLookup(); gateway.close() })
    const url = `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`
    const session = 'session-provider-switch'
    const request = (message, messages) => new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: {
        Authorization: 'Bearer ' + 'p'.repeat(48),
        'content-type': 'application/json',
        'x-opencode-session-id': session,
        'x-opencode-message-id': message,
      } }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.once('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }))
      })
      req.once('error', reject)
      req.end(JSON.stringify({ model: 'chatgpt-default', messages }))
    })
    const first = await request('message-switch-001', [{ role: 'user', content: 'one' }])
    assert.equal(first.status, 200)
    assert.equal(first.json.choices[0].message.content, 'CoS-1')
    assert.equal(sent[0].id, stableUUID('session:' + session))

    // Native OpenCode switches away before the previous CoS attempt finishes.
    // A foreign provider runs independently and must not consume a CoS input.
    hang = true
    let abandon
    const waiting = new Promise((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: {
        Authorization: 'Bearer ' + 'p'.repeat(48),
        'content-type': 'application/json',
        'x-opencode-session-id': session,
        'x-opencode-message-id': 'message-switch-002',
      } }, res => { res.resume(); res.once('end', resolve) })
      req.once('error', reject)
      req.end(JSON.stringify({ model: 'chatgpt-default', messages: [{ role: 'user', content: 'abandoned' }] }))
      abandon = () => req.destroy(Error('native_provider_switched'))
    })
    waiting.catch(() => {})
    await Promise.race([lookupStarted, timeout(1500, 'lookup_not_started')])
    abandon()
    await assert.rejects(waiting, /native_provider_switched/)
    const externalProvider = async () => 'foreign-answer'
    assert.equal(await externalProvider(), 'foreign-answer')
    assert.equal(sent.length, 1, 'foreign provider and cancelled lookup never post to CoS')

    const resumed = await Promise.race([request('message-switch-003', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'CoS-1' },
      { role: 'user', content: 'foreign request' },
      { role: 'assistant', content: 'foreign-answer' },
      { role: 'user', content: 'back to CoS' },
    ]), timeout(1700, 'stale_turn_kept_CoS_session_busy')])
    assert.equal(resumed.status, 200)
    assert.equal(resumed.json.choices[0].message.content, 'CoS-2')
    assert.equal(sent.length, 2)
    assert.equal(sent[1].sessionId, sent[0].id, 'CoS stable identity survives switching to another provider')
    assert.match(sent[1].text, /foreign request/, 'return includes previously completed intervening native context')
    assert.match(sent[1].text, /foreign-answer/)
    assert.match(sent[1].text, /back to CoS/)
    assert.doesNotMatch(sent[1].text, /CoS-1/, 'existing CoS answer never replays')
    releaseLookup()
  })

test('cancel during a pending CoS outbox response never waits for SSE and cancels the exact input',
  { timeout: 2500 }, async () => {
    let resolveSend
    let startedSend
    const sent = new Promise(resolve => { startedSend = resolve })
    const abort = new AbortController()
    const cancels = []
    let streams = 0
    const control = {
      async hasSession() { return false },
      async assertReady() {},
      async send() { startedSend(); return new Promise(resolve => { resolveSend = resolve }) },
      async cancelInput(id) { cancels.push(id) },
      events() { streams++; return { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } } },
    }
    const task = runTurn(control, { model: 'chatgpt-default', messages: [{ role: 'user', content: 'cancel me' }] }, {
      sessionKey: 'session_switch_abort', messageKey: 'msg_switch_abort_0001',
      signal: abort.signal, emit: () => undefined,
    })
    await Promise.race([sent, timeout(600, 'send_not_started')])
    abort.abort()
    resolveSend({ delivery: 'pending' })
    await assert.rejects(Promise.race([task, timeout(700, 'cancel_waited_for_event_stream')]),
      /opencode_turn_cancelled/)
    assert.equal(streams, 0, 'no event stream begins for an already cancelled send')
    assert.deepEqual(cancels, [stableUUID('session:session_switch_abort')])
  })
