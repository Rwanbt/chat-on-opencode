import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MessageIdentity, pinProviderMessage } from '../plugin/message-identity.mjs'
import { admitRequest } from '../plugin/auxiliary.mjs'

// OpenCode 2.2.4 sends compaction as a real model request: its model.request
// event has no messages and no result field, so it cannot be answered locally.
const event = kind => ({
  sessionID: 'ses_compaction1', agent: 'build', kind,
  model: { id: 'chatgpt-default', providerID: 'chat-on-opencode' },
  baseURL: 'http://x', headers: {},
})

test('a compaction request is admitted under its own identity, never the user message id', () => {
  const identities = new MessageIdentity()
  identities.remember('ses_compaction1', 'msg_user00001')
  const primary = event('primary')
  admitRequest(primary, identities)
  pinProviderMessage(primary, identities)
  assert.equal(primary.headers['x-opencode-message-id'], 'msg_user00001')

  const first = event('compaction')
  admitRequest(first, identities)
  const second = event('compaction')
  admitRequest(second, identities)
  const keys = [first, second].map(e => e.headers['x-opencode-message-id'])
  assert.ok(keys.every(key => /^msg_user00001\.compaction\.\d+$/.test(key)))
  assert.notEqual(keys[0], keys[1])
  assert.ok(keys.every(key => key !== 'msg_user00001'))
  assert.equal(first.headers['x-opencode-session-id'], 'ses_compaction1')
})

test('title and generate stay refused; an unknown kind is refused', () => {
  const identities = new MessageIdentity()
  identities.remember('ses_compaction1', 'msg_user00001')
  for (const kind of ['title', 'generate']) {
    assert.throws(() => admitRequest(event(kind), identities), new RegExp(`chat_on_opencode_${kind}_requires_separate_contract`))
  }
  assert.throws(() => admitRequest(event('unexpected'), identities), /chat_on_opencode_unknown_request_kind/)
})

test('a compaction without a known user message is refused, never guessed', () => {
  assert.throws(() => admitRequest(event('compaction'), new MessageIdentity()), /opencode_message_identity_unavailable/)
})
