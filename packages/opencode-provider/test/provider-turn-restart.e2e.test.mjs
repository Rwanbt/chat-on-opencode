import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { createGateway, stableUUID, runTurn } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bearer = 'restart-test-'.repeat(4)
const session = 'native-session-restart-001'
const sourceId = stableUUID('session:' + session)
const request = (message, prompt) => ({
  key: message,
  body: { model: 'chatgpt-default', messages: [{ role: 'user', content: prompt }] },
})

async function withGateway(control, callback, turnCustody) {
  const server = createGateway({ control, key: bearer, turnCustody })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const send = async ({ key, body }, { streaming = false } = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'x-opencode-session-id': session,
        'x-opencode-message-id': key,
      },
      body: JSON.stringify({ ...body, stream: streaming }),
      signal: AbortSignal.timeout(1600),
    })
    return { status: response.status, text: await response.text() }
  }
  try { return await callback(send) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('Windows restart retains CoS session and replays only the same proven native turn from durable event journal',
  { timeout: 7000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'turn-custody-disposable-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const custodyFolder = path.join(root, 'owned-marker')
    const makeCustody = () => new TurnCustody(custodyFolder)
    const journal = []
    const inputs = new Map()
    let serial = 0
    const control = {
      async hasSession() { return inputs.size > 0 },
      async assertReady() {},
      async send(input) {
        if (inputs.has(input.id)) return { delivery: 'sent' }
        inputs.set(input.id, input)
        const id = `cos-turn-${++serial}`
        journal.push(
          { kind: 'user_message', inputId: input.id, seq: journal.length + 1 },
          { kind: 'turn_start', turnId: id, seq: journal.length + 2 },
          { kind: 'assistant_message', turnId: id, message: { text: 'Answer-' + serial }, seq: journal.length + 3 },
          { kind: 'turn_end', turnId: id, outcome: 'completed', seq: journal.length + 4 },
        )
        return { delivery: 'sent' }
      },
      async *events() { for (const item of journal) yield item },
    }
    const first = request('msg-restart-001', 'first')
    const one = await withGateway(control, send => send(first), makeCustody())
    assert.equal(one.status, 200)
    assert.match(one.text, /Answer-1/)
    assert.equal(inputs.get(sourceId)?.text, '[user]\nfirst\n[/user]')
    // New gateway object models a real process restart: no volatile identity,
    // message or transcript checkpoint survives. The CoS journal does.
    const again = await withGateway(control, send => send(first), makeCustody())
    assert.equal(again.status, 200)
    assert.match(again.text, /Answer-1/)
    assert.equal(inputs.size, 1, 'restart replay must not create a second durable CoS input')
    const followup = await withGateway(control, send => send(request('msg-restart-002', 'next')), makeCustody())
    assert.equal(followup.status, 200)
    assert.match(followup.text, /Answer-2/)
    assert.equal(inputs.size, 2)
    assert.equal(inputs.get(stableUUID('turn:' + session + ':msg-restart-002'))?.sessionId, sourceId)
    const files = readdirSync(custodyFolder)
    assert.equal(files.length, 2, 'first-message marker plus one hashed follow-up retry marker')
    for (const file of files) {
      const record = readFileSync(path.join(custodyFolder, file), 'utf8')
      assert.doesNotMatch(record, /first|next|msg-restart|session-restart|authorization|cookie/i)
      assert.match(record, /"salt":"[a-f0-9]{32}"/, 'small marker is salted, not a plain prompt fingerprint')
    }
  })

test('disposable custody refuses changed first message, unrelated pending first input and corrupted marker', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'turn-custody-guard-'))
  try {
    const custody = new TurnCustody(path.join(root, 'owned'))
    custody.claimFirst('session-one', 'first-message-001', 'original data')
    assert.doesNotThrow(() => custody.claimFirst('session-one', 'first-message-001', 'original data'))
    assert.throws(() => custody.claimFirst('session-one', 'first-message-001', 'changed data'), /turn_first_message_conflict/)
    assert.throws(() => custody.claimFirst('session-one', 'other-message-002', 'original data'), /turn_first_message_conflict/)
    const file = path.join(root, 'owned', readdirSync(path.join(root, 'owned'))[0])
    writeFileSync(file, '{corrupted\n')
    assert.throws(() => custody.read('session-one'), /turn_custody_corrupt/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Windows loopback refuses a superseded input rather than claiming another turn as its answer',
  { timeout: 5000 }, async () => {
    const ownInput = stableUUID('turn:' + session + ':msg-superseded-002')
    const competitor = stableUUID('turn:' + session + ':msg-competitor-003')
    const sent = []
    const control = {
      async hasSession() { return true }, async assertReady() {},
      async send(input) { sent.push(input); return { delivery: 'pending' } },
      async *events() {
        yield { kind: 'user_message', inputId: 'prior-input' }
        yield { kind: 'turn_start', turnId: 'prior-turn' }
        yield { kind: 'turn_end', turnId: 'prior-turn', outcome: 'completed' }
        yield { kind: 'user_message', inputId: ownInput }
        yield { kind: 'user_message', inputId: competitor }
        yield { kind: 'turn_start', turnId: 'competitor-turn' }
        yield { kind: 'assistant_message', turnId: 'competitor-turn', message: { text: 'PRIVATE-COMPETING-ANSWER' } }
        yield { kind: 'turn_end', turnId: 'competitor-turn', outcome: 'completed' }
      },
    }
    const value = await withGateway(control, send => send(request('msg-superseded-002', 'own text')))
    assert.equal(value.status, 409, 'a newer acknowledged user input defeats old turn custody')
    assert.doesNotMatch(value.text, /PRIVATE-COMPETING-ANSWER/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].id, ownInput)
  })

test('newer turn_start cannot hijack original cancellation target, including after a native abort', async () => {
  const abort = new AbortController()
  const stopped = []
  const control = {
    async hasSession() { return true }, async assertReady() {},
    async send() {},
    async stop(...args) { stopped.push(args) },
    async *events() {
      yield { kind: 'user_message', inputId: stableUUID('turn:' + session + ':msg-stop-race-002') }
      yield { kind: 'turn_start', turnId: 'proven-original-turn' }
      yield { kind: 'turn_start', turnId: 'unrelated-newer-turn' }
      abort.abort()
      yield { kind: 'assistant_message', turnId: 'unrelated-newer-turn', message: { text: 'UNRELATED' } }
    },
  }
  await assert.rejects(runTurn(control, request('msg-stop-race-002', 'hello').body, {
    sessionKey: session, messageKey: 'msg-stop-race-002',
    signal: abort.signal, emit: () => undefined,
  }), /(?:cos_turn_superseded|opencode_turn_cancelled)/)
  assert.ok(stopped.every(([, turn]) => turn === 'proven-original-turn'), 'never stop unrelated turn')
})
