import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { completedTranscriptAnchor, continuationWithTranscript, plainMessages } from '../src/transcript-handoff.mjs'

const key = 'h'.repeat(48)
const primary = (text, extra = []) => ({ model: 'chatgpt-default', stream: false,
  messages: [...extra, { role: 'user', content: text }] })

test('Windows HTTP provider A→foreign B→A preserves CoS session and transports only verified intervening transcript',
  { timeout: 6000 }, async t => {
    const submitted = []
    let called = 0
    const control = {
      async hasSession() { return submitted.length > 0 },
      async assertReady() {},
      async send(value) { submitted.push(value) },
      async *events() {
        const index = ++called
        yield { kind: 'user_message', inputId: submitted.at(-1).id }
        yield { kind: 'turn_start', turnId: `turn-${index}` }
        yield { kind: 'assistant_message', turnId: `turn-${index}`, message: { text: `CoS-Answer-${index}` } }
        yield { kind: 'turn_end', turnId: `turn-${index}`, outcome: 'completed' }
      },
    }
    const gateway = createGateway({ control, key })
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
    t.after(() => gateway.close())
    const url = `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`
    async function send(message, body, session = 'same-native-session') {
      const response = await fetch(url, { method: 'POST', headers: {
        authorization: `Bearer ${key}`, 'content-type': 'application/json',
        'x-opencode-session-id': session, 'x-opencode-message-id': message,
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) })
      return { status: response.status, result: await response.json() }
    }
    const first = await send('message-001', primary('hello'))
    assert.equal(first.status, 200)
    assert.equal(first.result.choices[0].message.content, 'CoS-Answer-1')
    const foreign = async () => 'Foreign-Answer-1'
    const foreignAnswer = await foreign()
    assert.equal(submitted.length, 1, 'foreign provider does not call CoS')
    const history = [
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'CoS-Answer-1' },
      { role: 'user', content: 'foreign question' }, { role: 'assistant', content: foreignAnswer },
    ]
    const back = await send('message-002', primary('back to ChatGPT', history))
    assert.equal(back.status, 200)
    assert.equal(submitted[1].sessionId, stableUUID('session:same-native-session'))
    assert.match(submitted[1].text, /foreign question/)
    assert.match(submitted[1].text, /Foreign-Answer-1/)
    assert.match(submitted[1].text, /back to ChatGPT/)
    assert.doesNotMatch(submitted[1].text, /CoS-Answer-1|"hello"/, 'existing CoS history must not be replayed')
    const another = await send('message-003', primary('ordinary next', [
      ...history, { role: 'user', content: 'back to ChatGPT' },
      { role: 'assistant', content: 'CoS-Answer-2' },
    ]))
    assert.equal(another.status, 200)
    assert.equal(submitted[2].text, 'ordinary next', 'the foreign transcript must never replay on later turns')
    const reuse = await send('message-002', primary('back to ChatGPT', history))
    assert.equal(reuse.status, 200)
    assert.equal(submitted.at(-1).text, submitted[1].text, 'idempotent retry keeps original handoff bytes')
    const conflict = await send('message-002', primary('modified after admission', history))
    assert.equal(conflict.status, 409, 'same native message id cannot replace its history')
    assert.equal(submitted.length, 4)
    // Real official renderer can send two consecutive user-role records after
    // the exact last CoS completion; preserve both in the same native session.
    const nativeGap = await send('message-004', primary('continue in the same session', [
      ...history, { role: 'user', content: 'back to ChatGPT' },
      { role: 'assistant', content: 'CoS-Answer-2' },
      { role: 'user', content: 'ordinary next' },
      { role: 'assistant', content: 'CoS-Answer-3' },
      { role: 'user', content: 'renderer context A' },
      { role: 'user', content: 'renderer context B' },
    ]))
    assert.equal(nativeGap.status, 200)
    assert.match(submitted.at(-1).text, /renderer context A/)
    assert.match(submitted.at(-1).text, /renderer context B/)
    assert.match(submitted.at(-1).text, /quoted context only/)
    assert.doesNotMatch(submitted.at(-1).text, /CoS-Answer-3/, 'verified CoS reply never replayed')
    assert.equal(submitted.at(-1).sessionId, stableUUID('session:same-native-session'))
  })

test('unverified or ambiguous text cannot be imported as foreign transcript', async t => {
  const submitted = []
  const sessions = new Set()
  let reply = 'identical'
  const control = {
    async hasSession(id) { return sessions.has(id) }, async assertReady() {},
    async send(value) { submitted.push(value); sessions.add(value.sessionId ?? value.id) },
    async *events() {
      const n = submitted.length
      yield { kind: 'user_message', inputId: submitted.at(-1).id }
      yield { kind: 'turn_start', turnId: `turn-${n}` }
      yield { kind: 'assistant_message', turnId: `turn-${n}`, message: { text: reply } }
      yield { kind: 'turn_end', turnId: `turn-${n}`, outcome: 'completed' }
    },
  }
  const server = createGateway({ control, key })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  async function send(message, messages, session = 'session-ambiguous') {
    const res = await fetch(url, { method: 'POST', headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'x-opencode-session-id': session, 'x-opencode-message-id': message,
    }, body: JSON.stringify({ model: 'chatgpt-default', messages }), signal: AbortSignal.timeout(1500) })
    return { status: res.status, value: await res.json() }
  }
  assert.equal((await send('message-001', [{ role: 'user', content: 'same' }])).status, 200)
  const ambiguous = [
    { role: 'user', content: 'same' }, { role: 'assistant', content: 'identical' },
    { role: 'user', content: 'same' }, { role: 'assistant', content: 'identical' },
    { role: 'user', content: 'now' },
  ]
  const duplicate = await send('message-002', ambiguous)
  assert.equal(duplicate.status, 422, 'repeated matching anchors do not authorize transcript sync')
  assert.equal(submitted.length, 1)
  const noAnchor = await send('message-003', [
    { role: 'user', content: 'unrelated' }, { role: 'assistant', content: 'not-CoS' },
    { role: 'user', content: 'current' },
  ])
  assert.equal(noAnchor.status, 200, 'unverified history falls back to existing latest-only behavior')
  assert.equal(submitted.at(-1).text, 'current')
  const newSession = await send('message-004', [{ role: 'user', content: 'independent' }], 'independent-session')
  assert.equal(newSession.status, 200)
  assert.ok(!('sessionId' in submitted.at(-1)), 'other session must never inherit checkpoint')
})

test('handoff rejects clipped/non-text/incomplete and excessive context without replaying prior CoS history', () => {
  const anchor = completedTranscriptAnchor([{ role: 'user', content: 'initial' }], 'CoS-1')
  const prefix = [{ role: 'user', content: 'initial' }, { role: 'assistant', content: 'CoS-1' }]
  const user = { role: 'user', content: 'new prompt' }
  const complete = continuationWithTranscript(plainMessages([
    ...prefix, { role: 'user', content: 'foreign 1' }, { role: 'assistant', content: 'foreign answer' }, user,
  ]), anchor)
  assert.match(complete, /foreign answer/)
  assert.doesNotMatch(complete, /CoS-1/)
  const consecutive = continuationWithTranscript(plainMessages([
    ...prefix, { role: 'user', content: 'orphan' }, user,
  ]), anchor)
  assert.match(consecutive, /"role":"user","content":"orphan"/)
  assert.match(consecutive, /quoted context only/)
  const largeBounded = continuationWithTranscript(plainMessages([
    ...prefix, { role: 'user', content: 'X'.repeat(17000) },
      { role: 'assistant', content: 'reply' }, user,
  ]), anchor)
  assert.ok(largeBounded.includes('X'.repeat(17000)))
  assert.throws(() => continuationWithTranscript(plainMessages([
    ...prefix, { role: 'user', content: 'Y'.repeat(49000) },
      { role: 'assistant', content: 'reply' }, user,
  ]), anchor), /transcript_handoff_too_large/)
  assert.throws(() => plainMessages([...prefix, { role: 'assistant', content: [{ type: 'image_url', image_url: 'data' }] }, user]),
    /unsupported_chat_content/)
  assert.equal(continuationWithTranscript(plainMessages([user]), anchor), 'new prompt',
    'compacted history with no exact anchor remains latest-only')
})
