import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativeReadCustody } from '../src/native-read-custody.mjs'

const call = (id, args = '{"path":"D:/fixture/approved.txt","limit":7}') => ({
  id, type: 'function', function: { name: 'read', arguments: args },
})
const messages = (toolCall, content = 'APPROVED_CONTENT') => [
  { role: 'assistant', tool_calls: [toolCall] },
  { role: 'tool', tool_call_id: toolCall.id, content },
]

test('custody preserves session, exact argument semantics and stable retry content', () => {
  const store = new NativeReadCustody()
  const issued = call('call_approved_read_001')
  store.issue('session-A', 'message-A', issued)
  const reordered = call(issued.id, '{"limit":7,"path":"D:/fixture/approved.txt"}')
  assert.doesNotThrow(() => store.claim('session-A', 'message-A', messages(reordered)))
  assert.doesNotThrow(() => store.claim('session-A', 'message-A', messages(issued)))
  for (const [session, message, input] of [
    ['session-B', 'message-A', messages(issued)],
    ['session-A', 'message-B', messages(issued)],
    ['session-A', 'message-A', messages(call(issued.id, '{"path":"D:/fixture/private.txt","limit":7}'))],
    ['session-A', 'message-A', messages(issued, 'DIFFERENT_RESULT')],
    ['session-A', 'message-A', messages(call('call_other_read_001'))],
  ]) assert.throws(() => store.claim(session, message, input), /native_tool_result_not_issued/)
  store.consume('session-A')
  assert.throws(() => store.claim('session-A', 'message-A', messages(issued)), /native_tool_result_not_issued/)
})

test('abandon, bounded custody, expiry and malformed tool shape fail closed', () => {
  let clock = 100
  const store = new NativeReadCustody(2, { now: () => clock, ttlMs: 1000 })
  store.issue('session-A', 'message-A', call('call_read_00001'))
  store.issue('session-B', 'message-B', call('call_read_00002'))
  store.issue('session-C', 'message-C', call('call_read_00003'))
  assert.equal(store.has('session-A'), false, 'oldest custody is evicted')
  store.abandon('session-B')
  assert.equal(store.has('session-B'), false)
  assert.throws(() => store.claim('session-B', 'message-B', messages(call('call_read_00002'))),
    /native_tool_result_not_issued/)
  clock += 1001
  assert.throws(() => store.claim('session-C', 'message-C', messages(call('call_read_00003'))),
    /native_tool_result_not_issued/)
  assert.throws(() => store.issue('session-D', 'message-D', call('bad', 'null')),
    /native_tool_result_not_issued/)
})
