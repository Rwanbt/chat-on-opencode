import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { CoSControl } from '../src/control.mjs'

function endpointFrom(chunks) {
  const bytes = chunks.map(chunk => new TextEncoder().encode(chunk))
  const body = new ReadableStream({
    start(controller) {
      for (const bytesPart of bytes) controller.enqueue(bytesPart)
      controller.close()
    },
  })
  const instance = new CoSControl({
    directory: path.resolve('disposable-provider-control-test'),
    fetcher: async () => new Response(body, { status: 200, headers: {
      'content-type': 'text/event-stream',
    } }),
  })
  instance.base = 'http://127.0.0.1:1'
  instance.token = 'nonsecret-test-scope'
  return instance
}

async function firstEvent(chunks) {
  const instance = endpointFrom(chunks)
  const stream = instance.events('00000000-0000-5000-8000-000000000001')
  try {
    return await stream.next()
  } finally {
    await stream.return()
  }
}

for (const [name, separator] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR-only', '\r'],
]) {
  test('CoS event journal parses '+name+' SSE frame separators without spinning/replaying', async () => {
    const event = { seq: 7, kind: 'assistant_message', message: { text: 'progress' } }
    const source = 'event: assistant_message' + separator +
      'data: ' + JSON.stringify(event) + separator + separator
    const result = await firstEvent([source])
    assert.equal(result.done, false)
    assert.deepEqual(result.value, event)
  })
}

test('CoS event decoder preserves CRLF delimiters split at every byte boundary', async () => {
  const event = { seq: 5, kind: 'user_message', inputId: 'test-input' }
  const source = 'event: user_message\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n'
  const result = await firstEvent([...source])
  assert.deepEqual(result, { value: event, done: false })
})
