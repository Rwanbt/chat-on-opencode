import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'
import { BridgeError } from '../src/control.mjs'

// A retry of an already completed native message must replay that turn's own
// journal, not resume past its terminal event. The previous fake control in
// provider-followup-restart-replay.e2e.test.mjs ignored `from`, so it could not
// observe this. This fixture honours the durable cursor exactly like CoS.
function cursorControl() {
  const journal = []
  const inputs = new Map()
  let turns = 0
  const push = event => { journal.push({ ...event, seq: journal.length + 1 }) }
  return {
    inputs, journal,
    get turns() { return turns },
    async hasSession(id) { return id === stableUUID('session:session-replay') && inputs.size > 0 },
    async assertReady() {},
    async readiness() {
      return { sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true }
    },
    async send(input) {
      const earlier = inputs.get(input.id)
      if (earlier) {
        if (earlier.text !== input.text || (earlier.sessionId ?? null) !== (input.sessionId ?? null)) {
          throw new BridgeError('id_conflict', 409)
        }
        return { delivery: 'sent' }
      }
      inputs.set(input.id, input)
      const turn = 'turn-' + ++turns
      push({ kind: 'user_message', inputId: input.id, messageId: input.id })
      push({ kind: 'turn_start', turnId: turn, inputId: input.id })
      push({ kind: 'assistant_message', turnId: turn, message: { text: 'Answer-' + turns } })
      push({ kind: 'turn_end', turnId: turn, outcome: 'completed' })
      return { delivery: 'sent' }
    },
    async readInput(id) { return inputs.get(id) ?? null },
    async *events(_sessionID, { from = 0 } = {}) {
      for (const event of journal) if (event.seq >= from) yield event
    },
  }
}

async function open(t, control, custody) {
  const key = 'k'.repeat(40)
  const server = createGateway({ control, key, turnCustody: custody })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  return async (message, prompt) => {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(4000), headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'x-opencode-session-id': 'session-replay', 'x-opencode-message-id': message,
    }, body: JSON.stringify({ model: 'chatgpt-default', stream: false,
      messages: [{ role: 'user', content: prompt }] }) })
    return { status: response.status, body: await response.text() }
  }
}

test('retrying a completed native message replays its own turn instead of resuming past its terminal event', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'completed-turn-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const custody = new TurnCustody(path.join(root, 'custody'))
  const control = cursorControl()
  const send = await open(t, control, custody)

  const first = await send('msg-first-001', 'hello')
  assert.equal(first.status, 200, first.body)
  const followUp = await send('msg-follow-002', 'second request')
  assert.equal(followUp.status, 200, followUp.body)
  assert.match(followUp.body, /Answer-2/)
  assert.equal(control.turns, 2)

  // The same native message is retried because its response never reached the
  // SDK. CoS already owns the input; no second model turn may be created.
  const retry = await send('msg-follow-002', 'second request')
  assert.equal(retry.status, 200,
    'a completed turn must remain replayable: ' + retry.body)
  assert.match(retry.body, /Answer-2/)
  assert.equal(control.turns, 2, 'replay must not enqueue a second CoS turn')
})

test('replaying a completed follow-up after gateway restart does not resume past its own terminal event', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'completed-turn-replay-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const custodyDirectory = path.join(root, 'custody')
  const control = cursorControl()

  const before = await open(t, control, new TurnCustody(custodyDirectory))
  assert.equal((await before('msg-first-001', 'hello')).status, 200)
  assert.equal((await before('msg-follow-002', 'second request')).status, 200)
  assert.equal(control.turns, 2)

  // A new gateway process loses every volatile map but keeps the durable
  // follow-up custody marker and CoS's own outbox record.
  const after = await open(t, control, new TurnCustody(custodyDirectory))
  const retry = await after('msg-follow-002', 'second request')
  assert.equal(retry.status, 200,
    'restart replay of a completed follow-up must still answer: ' + retry.body)
  assert.match(retry.body, /Answer-2/)
  assert.equal(control.turns, 2, 'restart replay must not enqueue a second CoS turn')
})
