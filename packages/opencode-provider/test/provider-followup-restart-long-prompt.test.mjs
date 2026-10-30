import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'
import { BridgeError } from '../src/control.mjs'

// CoS `GET /v1/inputs` projects `text` with a 4000-character cap and reports
// `truncated:true`. A provider-switch follow-up routinely quotes more context
// than that, so restart recovery must not depend on reading the exact bytes
// back out of that projection.
const CAP = 4000
const LONG = 'x'.repeat(6000)

function control() {
  const journal = []
  const inputs = new Map()
  let turns = 0
  let posts = 0
  const push = event => { journal.push({ ...event, seq: journal.length + 1 }) }
  const sid = stableUUID('session:session-long')
  return {
    inputs, journal,
    get turns() { return turns },
    get posts() { return posts },
    async hasSession(id) { return id === sid && inputs.size > 0 },
    async assertReady() {},
    async readiness() {
      return { sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true }
    },
    async send(input) {
      posts++
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
    // Mirrors projectInput(): user text is clipped to 4000 chars.
    async readInput(id) {
      const entry = inputs.get(id)
      if (!entry) return null
      return { id: entry.id, sessionId: entry.sessionId ?? entry.id, state: 'sent', delivery: 'sent',
        text: entry.text.slice(0, CAP), chars: entry.text.length, truncated: entry.text.length > CAP }
    },
    async *events(_sessionID, { from = 0 } = {}) {
      for (const event of journal) if (event.seq >= from) yield event
    },
  }
}

async function open(t, fake, custody) {
  const key = 'k'.repeat(40)
  const server = createGateway({ control: fake, key, turnCustody: custody })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  return async (message, prompt) => {
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(6000), headers: {
      authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'x-opencode-session-id': 'session-long', 'x-opencode-message-id': message,
    }, body: JSON.stringify({ model: 'chatgpt-default', stream: false,
      messages: [{ role: 'user', content: prompt }] }) })
    return { status: response.status, body: await response.text() }
  }
}

test('restart replay of a follow-up longer than the broker input projection still answers without a second POST', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'followup-long-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const custodyDirectory = path.join(root, 'custody')
  const fake = control()

  const before = await open(t, fake, new TurnCustody(custodyDirectory))
  assert.equal((await before('msg-first-001', 'hello')).status, 200)
  const admitted = await before('msg-follow-002', LONG)
  assert.equal(admitted.status, 200, admitted.body)
  assert.match(admitted.body, /Answer-2/)
  assert.equal(fake.posts, 2)

  // The gateway restarts: volatile maps are gone, the salted marker and CoS's
  // own durable outbox survive. The projected text is no longer byte-exact.
  const after = await open(t, fake, new TurnCustody(custodyDirectory))
  const retry = await after('msg-follow-002', LONG)
  assert.equal(retry.status, 200, 'long follow-up replay must still answer: ' + retry.body)
  assert.match(retry.body, /Answer-2/)
  assert.equal(fake.turns, 2, 'replay must not enqueue a second CoS turn')
  assert.equal(fake.posts, 2, 'a durable input that CoS already owns must not be POSTed again')
})
