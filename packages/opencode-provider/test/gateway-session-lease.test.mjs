import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createGateway } from '../src/gateway.mjs'

test('busy request cannot release a different active turn session lease', async t => {
  let entered
  const firstEntered = new Promise(resolve => { entered = resolve })
  let unblock
  const held = new Promise(resolve => { unblock = resolve })
  const control = { async hasSession() { entered(); await held; return false } }
  const server = createGateway({ control, key: 'k'.repeat(40) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { unblock(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  const request = id => fetch(url, { method: 'POST', headers: {
    authorization: `Bearer ${'k'.repeat(40)}`, 'x-opencode-session-id': 'same-session',
    'x-opencode-message-id': id, 'content-type': 'application/json',
  }, body: JSON.stringify({ model: 'chatgpt-default', messages: [{ role: 'user', content: 'synthetic' }] }) })
  const first = request('message-one')
  await firstEntered
  assert.equal((await request('message-two')).status, 409)
  assert.equal((await request('message-three')).status, 409,
    'a refused second request must not remove the first request ownership')
  unblock(); await first
})
