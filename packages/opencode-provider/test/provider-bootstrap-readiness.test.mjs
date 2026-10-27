import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BridgeError } from '../src/control.mjs'
import { awaitProviderReady, runTurn } from '../src/gateway.mjs'

const unknown = { sessionCookie: 'unknown', extension: 'disconnected', paired: false, canAttempt: false }
const ready = { sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true }

test('hidden Chromium readiness transitions unknown -> paired before first admission', async () => {
  let time = 0
  const observed = []
  const control = {
    hasSession: async () => false,
    async readiness() { observed.push('readiness'); return observed.length < 3 ? unknown : ready },
    async assertReady() { observed.push('assertReady'); return undefined },
    async send(payload) { observed.push('admitted'); assert.equal(payload.text.includes('one prompt'), true) },
    async *events(id) {
      yield { kind: 'user_message', inputId: id }
      yield { kind: 'assistant_message', message: { text: 'REAL_TRANSPORT_FAKE_ONLY' } }
      yield { kind: 'turn_end', outcome: 'complete' }
    },
  }
  const deltas = []
  const result = await runTurn(control, {
    model: 'chatgpt-default', messages: [{ role: 'user', content: 'one prompt' }],
  }, {
    sessionKey: 'session_safety_123', messageKey: 'message_safety_123',
    emit: async delta => deltas.push(delta),
  })
  assert.equal(result, 'REAL_TRANSPORT_FAKE_ONLY')
  assert.deepEqual(deltas, ['REAL_TRANSPORT_FAKE_ONLY'])
  assert.deepEqual(observed, ['readiness', 'readiness', 'readiness', 'assertReady', 'admitted'])
})

test('no network wait for confirmed missing sign-in or explicitly unpaired bridge', async () => {
  for (const [state, code] of [
    [{ ...unknown, sessionCookie: 'absent' }, 'chatgpt_sign_in_required'],
    [{ ...ready, paired: false, canAttempt: false }, 'cos_companion_unpaired'],
  ]) {
    let slept = 0
    let checked = 0
    await assert.rejects(awaitProviderReady({
      readiness: async () => state,
      assertReady: async () => { checked++; throw new BridgeError(code, 503) },
    }, { sleep: () => { slept++; throw Error('unexpected_delay') } }), { message: code })
    assert.equal(slept, 0)
    assert.equal(checked, 1)
  }
})

test('unknown bridge never sends input when finite bootstrap deadline expires', async () => {
  let elapsed = 0, reads = 0, assertions = 0
  await assert.rejects(awaitProviderReady({
    readiness: async () => { reads++; return unknown },
    assertReady: async () => { assertions++; throw new BridgeError('chatgpt_session_unobserved', 503) },
  }, {
    maxWaitMs: 1200, clock: () => elapsed,
    sleep: async ms => { elapsed += ms },
  }), { message: 'chatgpt_session_unobserved' })
  assert.equal(elapsed, 1200)
  assert.equal(assertions, 1)
  assert.ok(reads >= 2 && reads <= 5)
})

test('cancellation while awaiting extension wake refuses without prompt admission', async () => {
  const controller = new AbortController()
  let sends = 0
  await assert.rejects(awaitProviderReady({
    readiness: async () => unknown,
    assertReady: async () => { throw Error('not_ready') },
    send: async () => { sends++ },
  }, {
    signal: controller.signal,
    sleep: async () => { controller.abort(); throw Error('simulated_abort') },
  }), { message: 'opencode_turn_cancelled' })
  assert.equal(sends, 0)
})
