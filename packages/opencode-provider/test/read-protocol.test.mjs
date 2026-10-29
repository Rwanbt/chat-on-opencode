import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  readInstructions, readResultPrompt, READ_PROTOCOL_MARKER, READ_RESULT_MARKER,
} from '../src/native-read.mjs'
import { codingInstructions } from '../src/native-tools.mjs'

// The offline CoS fixture stands in for ChatGPT and recognises the read
// protocol by its markers. It once keyed on a sentence of the instructions,
// and the hosted native-read E2E then failed for a cause that had nothing to
// do with the read path.
//
// The fixture is compiled as a STANDALONE program by five tests, and the
// official Desktop acceptance test relocates it into a directory of its own
// before compiling it. A fixture that imports a sibling module therefore
// builds everywhere except there, and fails there with
// `mock_runtime_build_failed`. So the fixture holds its own copy of the two
// markers, and this test is the guard that keeps that copy equal to the
// product's: the product remains the authority for what the protocol is, and
// a change to a marker fails here.

const fixtureSource = await readFile(new URL('./fixtures/mock-cos.ts', import.meta.url), 'utf8')

const declaredTool = { name: 'read', description: 'read a file', schema: { type: 'object' } }
const nativeCall = {
  id: 'call_abcdefgh', type: 'function',
  function: { name: 'read', arguments: '{"path":"C:\\\\project\\\\a.js"}' },
}

// The fixture's own copy, read from its source.
function fixtureConstant(name) {
  const match = fixtureSource.match(new RegExp("const " + name + " = '([^']*)'"))
  return match ? match[1] : null
}

// The fixture's own classifier, which the test below pins by text.
function classify(text) {
  if (typeof text !== 'string') return 'none'
  if (text.includes(READ_RESULT_MARKER)) return 'result'
  if (text.includes(READ_PROTOCOL_MARKER)) return 'intent'
  return 'none'
}

test("the fixture's copy of the protocol markers is the product's markers", () => {
  assert.equal(fixtureConstant('READ_PROTOCOL_MARKER'), READ_PROTOCOL_MARKER)
  assert.equal(fixtureConstant('READ_RESULT_MARKER'), READ_RESULT_MARKER)
})

test('the fixture keys on the markers, never on a sentence of the instructions', () => {
  const flattened = fixtureSource.replace(/\s+/g, ' ')
  assert.ok(flattened.includes("if (text.includes(READ_RESULT_MARKER)) return 'result'"),
    'the fixture no longer recognises the result marker')
  assert.ok(flattened.includes("if (text.includes(READ_PROTOCOL_MARKER)) return 'intent'"),
    'the fixture no longer recognises the protocol marker')
  assert.ok(!fixtureSource.includes('ONE native read tool'),
    'the fixture went back to keying on a sentence of the instructions')
  assert.ok(!fixtureSource.includes('UNTRUSTED file content'),
    'the fixture went back to keying on a sentence of the result prompt')
})

test('the fixture imports nothing but node builtins, so it compiles when relocated', () => {
  const specifiers = [...fixtureSource.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1])
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'),
      'the fixture must stay standalone, it is compiled from a directory of its own: ' + specifier)
  }
})

test('the shipped read instructions are a read intent', () => {
  const instructions = readInstructions()
  assert.ok(instructions.includes(READ_PROTOCOL_MARKER), 'the protocol marker left the instructions')
  assert.equal(classify(instructions), 'intent')
  assert.equal(classify(instructions + '\n\nTask to carry out:\nread that file'), 'intent')
})

test('the shipped read result prompt is a result, never an intent', () => {
  const result = readResultPrompt([
    { role: 'assistant', tool_calls: [nativeCall] },
    { role: 'tool', tool_call_id: nativeCall.id, content: 'READ_CONTENT' },
  ])
  assert.ok(result.text.includes(READ_RESULT_MARKER), 'the result marker left the result prompt')
  assert.ok(!result.text.includes(READ_PROTOCOL_MARKER),
    'the result prompt must not look like a read intent')
  assert.equal(classify(result.text), 'result')
})

test('a coding turn and a plain text turn are neither a read intent nor a read result', () => {
  assert.equal(classify('Task to carry out:\nfix the failing test'), 'none')
  assert.equal(classify(codingInstructions([declaredTool])), 'none')
  assert.equal(classify(undefined), 'none')
  assert.equal(classify(''), 'none')
})
