import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { CoSControl, BridgeError } from '../src/control.mjs'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'

test('Windows loopback rejects a skipped CoS SSE revision; restart retries the exact first input and then a new native turn',
  { timeout: 8500 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'provider-sequence-gap-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const session = 'session-sequence-gap-retry'
    const firstID = stableUUID('session:' + session)
    const key = 'j'.repeat(48)
    const inputs = new Map()
    const journal = []
    const curls = []
    let admitted = 0
    let missingRevision = true
    const add = event => journal.push({ seq: journal.length + 1, ...event })
    const encode = event => 'event: ' + event.kind + '\ndata: ' + JSON.stringify(event) + '\n\n'
    const control = new CoSControl({ directory: root, fetcher: async url => {
      const from = Number(new URL(url).searchParams.get('from'))
      curls.push(from)
      const missing = missingRevision ? journal.filter(event => event.seq !== 4) : journal
      const frames = missing.filter(event => event.seq >= from).map(encode).join('')
      return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    } })
    control.base = 'http://127.0.0.1:1'
    control.token = 't'.repeat(40)
    control.hasSession = async id => id === firstID && inputs.size > 0
    control.readiness = async () => ({
      sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true,
    })
    control.assertReady = async () => {}
    control.send = async input => {
      const prior = inputs.get(input.id)
      if (prior) {
        // This is the real CoS outbox's idempotency contract: an already
        // admitted ID must retain its *whole* original input, not just text.
        if (JSON.stringify(prior) !== JSON.stringify(input)) throw new BridgeError('cos_input_id_payload_conflict', 409)
        return { delivery: 'sent' }
      }
      inputs.set(input.id, input)
      const turnId = 'cos-turn-' + ++admitted
      add({ kind: 'user_message', inputId: input.id })
      add({ kind: 'turn_start', turnId, inputId: input.id })
      if (admitted === 1) {
        add({ kind: 'assistant_message', turnId, message: { text: 'START' } })
        add({ kind: 'assistant_message', turnId, message: { text: 'START-FINISH' } })
      } else add({ kind: 'assistant_message', turnId, message: { text: 'NEXT-TURN' } })
      add({ kind: 'turn_end', turnId, outcome: 'completed' })
      return { delivery: 'sent' }
    }
    const custodyPath = path.join(root, 'custody')
    async function sendNative(messageKey, prompt, stream = false) {
      const server = createGateway({ control, key, turnCustody: new TurnCustody(custodyPath) })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions'
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json',
            'x-opencode-session-id': session, 'x-opencode-message-id': messageKey },
          body: JSON.stringify({ model: 'chatgpt-default', stream,
            messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(1400),
        })
        return { status: response.status, body: await response.text() }
      } finally { await new Promise(resolve => server.close(resolve)) }
    }
    const first = await sendNative('native-first-001', 'opening prompt')
    assert.equal(first.status, 502, 'missing sequence 4 cannot be silently replaced by completed event 5')
    assert.match(first.body, /cos_event_sequence_gap/)
    assert.equal(new TurnCustody(custodyPath).readAnchor(session), null,
      'never anchor an incomplete transcript after an apparent completed turn')
    assert.equal(admitted, 1)
    assert.deepEqual(curls, [0])

    missingRevision = false // the same durable CoS journal is now fully readable
    const recovered = await sendNative('native-first-001', 'opening prompt', true)
    assert.equal(recovered.status, 200, 'identical native message replays after gateway restart')
    assert.match(recovered.body, /"content":"START"/)
    assert.match(recovered.body, /"content":"-FINISH"/)
    assert.match(recovered.body, /\[DONE\]/)
    assert.equal(admitted, 1, 'first CoS model turn is never sent twice')
    assert.deepEqual(inputs.get(firstID), { id: firstID, text: '[user]\nopening prompt\n[/user]' })
    assert.equal(new TurnCustody(custodyPath).readAnchor(session)?.seq, 5)

    const next = await sendNative('native-followup-002', 'new user request')
    assert.equal(next.status, 200)
    assert.match(next.body, /NEXT-TURN/)
    assert.doesNotMatch(next.body, /START-FINISH/, 'the earlier answer must not contaminate the next turn')
    assert.equal(admitted, 2)
    assert.equal(inputs.get(stableUUID('turn:' + session + ':native-followup-002')).sessionId, firstID)
    assert.equal(new TurnCustody(custodyPath).readAnchor(session)?.seq, 9)
  })
