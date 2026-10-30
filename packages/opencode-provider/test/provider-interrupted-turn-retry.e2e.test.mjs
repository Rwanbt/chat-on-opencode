import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'

test('Windows loopback never claims interrupted/stalled/unknown CoS turns completed across retry and provider switch',
  { timeout: 30000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'provider-outcomes-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const key = 'f'.repeat(48)
    const session = 'native-session-multiturn-outcome'
    const sessionId = stableUUID('session:' + session)
    const journal = []
    const inputs = new Map()
    const outcomes = ['completed', 'interrupted', 'stalled', 'unknown', 'completed']
    const texts = ['FIRST-OK', 'PARTIAL-INTERRUPTED', 'PARTIAL-STALLED', 'PARTIAL-UNKNOWN', 'RECOVERED-OK']
    let admitted = 0
    const control = {
      async hasSession(id) { return id === sessionId && inputs.size > 0 },
      async assertReady() {},
      async send(input) {
        if (inputs.has(input.id)) return { delivery: 'sent' }
        const i = admitted++
        inputs.set(input.id, input)
        const turnId = 'turn-' + (i + 1)
        const add = item => journal.push({ ...item, seq: journal.length + 1 })
        add({ kind: 'user_message', inputId: input.id })
        add({ kind: 'turn_start', turnId, inputId: input.id })
        add({ kind: 'assistant_message', turnId, message: { text: texts[i] } })
        add({ kind: 'turn_end', turnId, outcome: outcomes[i] })
        return { delivery: 'sent' }
      },
      async *events() { for (const event of journal) yield event },
      async readInput(id) { return inputs.get(id) ?? null },
    }
    const custody = new TurnCustody(path.join(root, 'isolated-runtime'))
    const server = createGateway({ control, key, turnCustody: custody })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => server.close())
    const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions'
    async function send(message, prompt, stream = false, previous = []) {
      const response = await fetch(url, { method: 'POST', headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'x-opencode-session-id': session,
        'x-opencode-message-id': message,
      }, body: JSON.stringify({ model: 'chatgpt-default', stream,
        messages: [...previous, { role: 'user', content: prompt }] }),
      // Real Windows CI can contend with simultaneous native Electron jobs; 1.2 s
      // accidentally timed out the HTTP client rather than exercising CoS outcomes.
      signal: AbortSignal.timeout(5000) })
      return { status: response.status, body: await response.text() }
    }
    const first = await send('native-msg-001', 'start')
    assert.equal(first.status, 200)
    assert.match(first.body, /FIRST-OK/)
    assert.equal(custody.readAnchor(session)?.seq, 4, 'first proven completion anchors the session')

    // These are actual CoS lifecycle outcomes, distinct from a verified
    // completion. They have partial assistant text but cannot be advertised as
    // final answers or used as verified foreign-provider transcript anchors.
    for (const [index, outcome] of ['interrupted', 'stalled', 'unknown'].entries()) {
      const message = 'native-msg-00' + (index + 2)
      const failed = await send(message, 'attempt-' + outcome)
      assert.equal(failed.status, 502, outcome + ' is not a successful provider turn')
      assert.match(failed.body, /cos_turn_not_completed/)
      assert.doesNotMatch(failed.body, /PARTIAL-/, 'partial CoS text must not become a normal completion')
      assert.equal(custody.readAnchor(session)?.seq, 4, 'failed turns must not replace verified transcript anchor')
    }
    const completed = await send('native-msg-005', 'resume after provider switch', true, [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'FIRST-OK' },
      { role: 'user', content: 'question for foreign provider' },
      { role: 'assistant', content: 'foreign response' },
    ])
    assert.equal(completed.status, 200, 'fresh turn still works after three failed turns')
    assert.match(completed.body, /RECOVERED-OK/)
    assert.match(completed.body, /\[DONE\]/)
    assert.equal(admitted, 5, 'exactly one CoS input per native message')
    assert.equal(inputs.get(stableUUID('turn:' + session + ':native-msg-005')).sessionId, sessionId)
    assert.equal(custody.readAnchor(session)?.seq, 20, 'only the later completed turn advances the anchor')
  })
