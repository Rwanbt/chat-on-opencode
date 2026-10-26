import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const runner = fileURLToPath(new URL('../bin/build-brave-companion.mjs', import.meta.url))
const fixture = t => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'coo-companion-build-'))
  t.after(() => rmSync(parent, {recursive:true,force:true}))
  const target = path.join(parent, 'companion')
  const env = { ...process.env, CHAT_ON_OPENCODE_COMPANION_BUILD_TEST_DIR: target }
  const call = spawnSync(process.execPath, [runner], { encoding:'utf8', timeout:8000, env })
  assert.equal(call.status, 0, call.stderr)
  return { target, env }
}

test('bundled Brave companion can only discover the isolated provider', t => {
  const {target} = fixture(t)
  const manifest = JSON.parse(readFileSync(path.join(target, 'manifest.json'), 'utf8'))
  const background = readFileSync(path.join(target, 'background.js'), 'utf8')
  assert.equal(manifest.name, 'Chat On OpenCode Companion (Brave)')
  assert.deepEqual(manifest.host_permissions, [
    'https://chatgpt.com/*', 'https://chat.openai.com/*', 'http://127.0.0.1:8766/*',
  ])
  assert.deepEqual(manifest.optional_permissions, ['cookies'])
  assert.doesNotMatch(manifest.permissions.join(' '), /debugger/)
  assert.equal(manifest.content_scripts, undefined)
  assert.match(background, /^const PORTS = \[8766\];$/m)
  assert.match(background, /async cos_sign_in_transfer\(/)
  assert.match(background, /\/cos-browser\/sign-in/)
  assert.match(readFileSync(path.join(target, 'popup.html'), 'utf8'), /signInTransferBtn/)
  assert.match(readFileSync(path.join(target, 'popup.js'), 'utf8'), /Bring session to Chat On OpenCode/)
})

test('companion cannot overwrite an existing artifact', t => {
  const {env} = fixture(t)
  const call = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 8000, env })
  assert.notEqual(call.status, 0)
  assert.match(call.stderr, /companion_output_already_exists/)
})
