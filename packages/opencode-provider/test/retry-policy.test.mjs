import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stopUnavailableGatewayRetry } from '../plugin/retry-policy.mjs'

const event = (providerID, status, decision = { retry: true, delay: 9000 }) => ({
  model: { providerID, id: 'chatgpt-default' },
  error: { type: 'provider.unavailable', message: 'unavailable', status },
  decision,
})

test('unpaired local CoS 503 fails once instead of repeating primary model steps', () => {
  const e = event('chat-on-opencode', 503)
  assert.equal(stopUnavailableGatewayRetry(e), true)
  assert.deepEqual(e.decision, { retry: false })
})

test('other providers, 429/500 errors, and successful requests retain native retry decisions', () => {
  for (const [providerID, status] of [
    ['openai', 503], ['anthropic', 503], ['chat-on-opencode', 429],
    ['chat-on-opencode', 500], ['chat-on-opencode', 200],
  ]) {
    const e = event(providerID, status)
    const original = e.decision
    assert.equal(stopUnavailableGatewayRetry(e), false)
    assert.equal(e.decision, original)
  }
})

test('a terminal or missing decision is not revived and malformed retry events fail closed', () => {
  const terminal = event('chat-on-opencode', 503, { retry: false })
  assert.equal(stopUnavailableGatewayRetry(terminal), true)
  assert.deepEqual(terminal.decision, { retry: false })
  for (const value of [null, undefined, {}, { error: { status: 503 } },
    { model: { providerID: 'chat-on-opencode' } }]) {
    assert.equal(stopUnavailableGatewayRetry(value), false)
  }
})
