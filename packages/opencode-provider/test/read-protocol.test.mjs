import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readInstructions, readResultPrompt, READ_PROTOCOL_MARKER, READ_RESULT_MARKER,
} from '../src/native-read.mjs'
import { codingInstructions } from '../src/native-tools.mjs'
import { readTurnKind } from './fixtures/read-protocol.mjs'

// The offline CoS fixture stands in for ChatGPT and recognises the read
// protocol by its markers. It once keyed on a sentence of the instructions,
// and the hosted native-read E2E then failed for a cause that had nothing to
// do with the read path. These tests keep the fixture and the shipped prompts
// in agreement, locally, before any hosted runner is involved.

const declaredTool = { name: 'read', description: 'read a file', schema: { type: 'object' } }
const nativeCall = {
  id: 'call_abcdefgh', type: 'function',
  function: { name: 'read', arguments: '{"path":"C:\\\\project\\\\a.js"}' },
}

test('the shipped read instructions carry the protocol marker the fixture recognises', () => {
  const instructions = readInstructions()
  assert.ok(instructions.includes(READ_PROTOCOL_MARKER), 'the protocol marker left the instructions')
  assert.equal(readTurnKind(instructions), 'intent')
  assert.equal(readTurnKind(instructions + '\n\nTask to carry out:\nread that file'), 'intent')
})

test('the shipped read result prompt is a result, never an intent', () => {
  const result = readResultPrompt([
    { role: 'assistant', tool_calls: [nativeCall] },
    { role: 'tool', tool_call_id: nativeCall.id, content: 'READ_CONTENT' },
  ])
  assert.ok(result.text.includes(READ_RESULT_MARKER), 'the result marker left the result prompt')
  assert.ok(!result.text.includes(READ_PROTOCOL_MARKER),
    'the result prompt must not look like a read intent')
  assert.equal(readTurnKind(result.text), 'result')
})

test('the read instructions never look like a tool result', () => {
  assert.ok(!readInstructions().includes(READ_RESULT_MARKER))
})

test('a plain text turn and a coding turn are neither a read intent nor a read result', () => {
  assert.equal(readTurnKind('Task to carry out:\nfix the failing test'), 'none')
  assert.equal(readTurnKind(codingInstructions([declaredTool])), 'none')
  assert.equal(readTurnKind(undefined), 'none')
  assert.equal(readTurnKind(''), 'none')
})
