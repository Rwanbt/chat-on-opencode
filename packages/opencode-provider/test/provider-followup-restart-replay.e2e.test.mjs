import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'
import { BridgeError } from '../src/control.mjs'

test('Windows loopback A→foreign→A: replay an admitted follow-up after gateway restart without losing its original handoff or sending twice', { timeout: 6500 }, async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'restart-followup-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const rootCustody = path.join(root, 'isolated-custody')
  const key = 'k'.repeat(40)
  const session = 'session-switch-restart'
  const sid = stableUUID('session:' + session)
  const inputs = new Map()
  const journal = []
  let turns = 0
  let sends = 0
  const control = {
    async hasSession(id) { return id === sid && inputs.size > 0 },
    async assertReady() {},
    async send(input) {
      sends++
      const earlier = inputs.get(input.id)
      if (earlier) {
        if (earlier.text !== input.text || (earlier.sessionId ?? input.id) !== (input.sessionId ?? input.id))
          throw new BridgeError('id_conflict', 409)
        return { delivery: 'sent' }
      }
      inputs.set(input.id, input)
      const turn = 'turn-' + ++turns
      journal.push({ kind: 'user_message', inputId: input.id },
        { kind: 'turn_start', turnId: turn },
        { kind: 'assistant_message', turnId: turn, message: { text: 'Answer-' + turns } },
        { kind: 'turn_end', turnId: turn, outcome: 'completed' })
      return { delivery: 'sent' }
    },
    async readInput(id) { return inputs.get(id) ?? null },
    async *events() { for (const event of journal) yield event },
  }
  const history = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Answer-1' },
    { role: 'user', content: 'foreign request' }, { role: 'assistant', content: 'foreign-answer' }]
  const body = (prompt, prior = [], stream = false) =>
    ({ model: 'chatgpt-default', stream, messages: [...prior, { role: 'user', content: prompt }] })
  async function gateway(callback) {
    const server = createGateway({ control, key, turnCustody: new TurnCustody(rootCustody) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
    const send = async (message, payload) => {
      const response = await fetch(url, { method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
          'x-opencode-session-id': session, 'x-opencode-message-id': message },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(1600) })
      return { status: response.status, body: await response.text() }
    }
    try { return await callback(send) }
    finally { await new Promise(resolve => server.close(resolve)) }
  }
  const original = await gateway(async send => {
    assert.equal((await send('msg-first-001', body('hello'))).status, 200)
    return send('msg-foreign-002', body('back to CoS', history, true))
  })
  assert.equal(original.status, 200)
  assert.match(original.body, /Answer-2/)
  const id = stableUUID('turn:' + session + ':msg-foreign-002')
  assert.match(inputs.get(id).text, /foreign-answer/)
  assert.equal(turns, 2)
  // A gateway restart loses volatile transcript anchors. CoS owns original input.
  const retry = await gateway(send => send('msg-foreign-002', body('back to CoS', history, true)))
  assert.equal(retry.status, 200, 'restart replay must not produce CoS id_conflict')
  assert.match(retry.body, /Answer-2/)
  assert.equal(turns, 2, 'same CoS input has exactly one real model turn')
  assert.match(inputs.get(id).text, /foreign-answer/)
  const altered = await gateway(send => send('msg-foreign-002', body('changed text', history)))
  assert.equal(altered.status, 409, 'same native message id with modified history is refused')
  assert.equal(sends, 3, 'changed native text rejected before resubmission')
  const next = await gateway(send => send('msg-next-003', body('following request')))
  assert.equal(next.status, 200)
  assert.match(next.body, /Answer-3/)
  assert.equal(inputs.get(stableUUID('turn:' + session + ':msg-next-003')).sessionId, sid)
  assert.equal(turns, 3)
  const markerFiles = readdirSync(rootCustody)
  assert.equal(markerFiles.length, 3, 'first marker and two hashed follow-up markers')
  for (const name of markerFiles) {
    const text = readFileSync(path.join(rootCustody, name), 'utf8')
    assert.doesNotMatch(text, /foreign-answer|foreign request|back to CoS|msg-foreign-002|hello|cookies|Bearer/)
  }
})
