import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'
import { TurnCustody } from '../src/turn-custody.mjs'

test('Windows loopback restart retains verified A→foreign B→A transcript for a NEW native message',
  { timeout: 8000 }, async t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'coo-transcript-restart-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const directory = path.join(root, 'consented-isolated-custody')
    const bearer = 'r'.repeat(48)
    const session = 'native-transcript-restart'
    const sid = stableUUID('session:' + session)
    const inputs = new Map()
    const events = []
    let turnCount = 0
    const control = {
      async hasSession(id) { return id === sid && inputs.size > 0 },
      async assertReady() {},
      async send(input) {
        if (inputs.has(input.id)) return { delivery: 'sent' }
        inputs.set(input.id, input)
        const turnId = 'cos-turn-' + ++turnCount
        const append = event => events.push({ ...event, seq: events.length + 1 })
        append({ kind: 'user_message', inputId: input.id })
        append({ kind: 'turn_start', turnId })
        append({ kind: 'assistant_message', turnId, message: { text: `CoS-Answer-${turnCount}` } })
        append({ kind: 'turn_end', turnId, outcome: 'completed' })
        return { delivery: 'sent' }
      },
      async readInput(id) { return inputs.get(id) ?? null },
      async *events() { for (const event of events) yield event },
    }
    async function withRestartedGateway(callback) {
      const server = createGateway({ control, key: bearer, turnCustody: new TurnCustody(directory) })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
      const send = async (message, messages) => {
        const res = await fetch(url, { method: 'POST', headers: {
          authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
          'x-opencode-session-id': session, 'x-opencode-message-id': message,
        }, body: JSON.stringify({ model: 'chatgpt-default', stream: true, messages }),
        signal: AbortSignal.timeout(2000) })
        return { status: res.status, body: await res.text() }
      }
      try { return await callback(send) }
      finally { await new Promise(resolve => server.close(resolve)) }
    }
    const opening = [{ role: 'user', content: 'hello CoS' }]
    const first = await withRestartedGateway(send => send('native-message-001', opening))
    assert.equal(first.status, 200)
    assert.match(first.body, /CoS-Answer-1/)

    // The first gateway is gone; native OpenCode receives an unrelated foreign
    // answer and sends a brand NEW CoS message after restart, not a replay.
    const history = [...opening, { role: 'assistant', content: 'CoS-Answer-1' },
      { role: 'user', content: 'ask foreign B' }, { role: 'assistant', content: 'foreign-B-reply' }]
    const second = await withRestartedGateway(send => send('native-message-002', [
      ...history, { role: 'user', content: 'return to CoS' },
    ]))
    assert.equal(second.status, 200)
    assert.match(second.body, /CoS-Answer-2/)
    const sent = inputs.get(stableUUID('turn:' + session + ':native-message-002'))
    assert.equal(sent.sessionId, sid)
    assert.match(sent.text, /ask foreign B/)
    assert.match(sent.text, /foreign-B-reply/)
    assert.match(sent.text, /return to CoS/)
    assert.doesNotMatch(sent.text, /CoS-Answer-1/, 'CoS history must never be duplicated')

    // A newer confirmed CoS turn becomes the anchor for another restart.
    const third = await withRestartedGateway(send => send('native-message-003', [
      ...history, { role: 'user', content: 'return to CoS' },
      { role: 'assistant', content: 'CoS-Answer-2' },
      { role: 'user', content: 'foreign C' }, { role: 'assistant', content: 'foreign-C-reply' },
      { role: 'user', content: 'back again' },
    ]))
    assert.equal(third.status, 200)
    const thirdInput = inputs.get(stableUUID('turn:' + session + ':native-message-003')).text
    assert.match(thirdInput, /foreign-C-reply/)
    assert.doesNotMatch(thirdInput, /foreign-B-reply/, 'older foreign exchanges must not replay')
    assert.equal(turnCount, 3)

    const custody = new TurnCustody(directory)
    const latest = custody.readAnchor(session)
    assert.equal(latest.seq, 12, 'the latest CoS journal completion owns the persisted anchor')
    custody.rememberAnchor(session, {
      questionSha256: 'a'.repeat(64), answerSha256: 'b'.repeat(64),
    }, 4)
    assert.deepEqual(custody.readAnchor(session), latest, 'an earlier retry cannot replace a newer completed turn')

    // No prompt, response, bearer or transcript content is stored in the markers.
    for (const name of readdirSync(directory)) {
      const marker = readFileSync(path.join(directory, name), 'utf8')
      assert.doesNotMatch(marker, /hello CoS|CoS-Answer|foreign-B-reply|foreign-C-reply|return to CoS|Bearer|native-message/)
    }
  })
