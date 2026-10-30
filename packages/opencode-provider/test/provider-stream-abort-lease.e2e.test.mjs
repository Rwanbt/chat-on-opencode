import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'

const session = 'provider-switch-stream-session'
const key = 's'.repeat(48)
const pause = ms => new Promise((_, reject) => setTimeout(() => reject(Error('timed_out')), ms))

test('Windows loopback: stalled CoS SSE cannot retain native session lease after streaming cancel and provider switch',
  { timeout: 5000 }, async t => {
    let releaseStall
    let enteredStall
    const entered = new Promise(resolve => { enteredStall = resolve })
    const stalled = new Promise(resolve => { releaseStall = resolve })
    const sent = []
    const stops = []
    let call = 0
    const control = {
      async hasSession() { return true }, async assertReady() {},
      async send(value) { sent.push(value) },
      async stop(sessionID, turnId, { signal } = {}) {
        assert.ok(signal instanceof AbortSignal)
        stops.push([sessionID, turnId])
      },
      async cancelInput() { throw Error('must_stop_proven_turn_not_input') },
      async *events() {
        const current = ++call
        const id = sent.at(-1).id
        yield { kind: 'user_message', inputId: id }
        yield { kind: 'turn_start', turnId: 'cos-turn-' + current }
        if (current === 1) {
          yield { kind: 'assistant_message', turnId: 'cos-turn-1', message: { text: 'PARTIAL-STREAM' } }
          enteredStall()
          await stalled
          return
        }
        yield { kind: 'assistant_message', turnId: 'cos-turn-' + current, message: { text: 'RESUMED-' + current } }
        yield { kind: 'turn_end', turnId: 'cos-turn-' + current, outcome: 'completed' }
      },
    }
    const gateway = createGateway({ control, key })
    gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
    const url = `http://127.0.0.1:${gateway.address().port}/v1/chat/completions`
    t.after(async () => { releaseStall(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)) })

    function request(message, text, stream = false) {
      let abort
      const response = new Promise((resolve, reject) => {
        const req = httpRequest(url, { method: 'POST', headers: {
          authorization: `Bearer ${key}`, 'content-type': 'application/json',
          'x-opencode-session-id': session, 'x-opencode-message-id': message,
        } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => { body += chunk })
          res.once('end', () => resolve({ status: res.statusCode, body }))
          res.once('error', reject)
          res.once('aborted', () => reject(Error('native_response_aborted')))
        })
        abort = () => req.destroy(Error('native_stream_cancelled'))
        req.once('error', reject)
        req.end(JSON.stringify({ model: 'chatgpt-default', stream,
          messages: [{ role: 'user', content: text }] }))
      })
      return { response, abort: () => abort() }
    }

    const pending = request('msg-stream-001', 'one', true)
    pending.response.catch(() => {})
    await Promise.race([entered, pause(900)])
    pending.abort()
    await assert.rejects(pending.response, /native_stream_cancelled|aborted|ECONNRESET/)
    // A foreign provider completes independently while the old CoS SSE reader
    // is still blocked. OpenCode should be able to return to CoS immediately.
    const foreignResponse = 'foreign answer'
    assert.equal(foreignResponse, 'foreign answer')
    const resumed = await Promise.race([request('msg-stream-002', 'back from foreign').response,
      pause(1200)])
    assert.equal(resumed.status, 200, 'a cancelled obsolete stream releases its session')
    assert.match(resumed.body, /RESUMED-2/)
    assert.equal(sent.length, 2)
    assert.equal(sent[0].sessionId, stableUUID('session:' + session))
    assert.equal(sent[1].sessionId, stableUUID('session:' + session))
    assert.equal(sent[1].id, stableUUID('turn:' + session + ':msg-stream-002'))
    assert.deepEqual(stops, [[stableUUID('session:' + session), 'cos-turn-1']],
      'only the actual cancelled prior CoS turn is stopped, never the resumed turn')
  })
