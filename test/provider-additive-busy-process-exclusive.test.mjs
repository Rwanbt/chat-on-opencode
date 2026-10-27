import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { additiveSourceDigest, installAdditive } from '../packages/opencode-provider/src/context-overlay/additive-install.mjs'

const source = fileURLToPath(new URL('../packages/opencode-provider', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('Windows official opencode.exe-name process blocks real additive publication', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-busy-real-opencode-name-'))
  const copiedExecutable = path.join(root, 'opencode.exe')
  const config = path.join(root, 'opencode.jsonc')
  const original = Buffer.from('{ // protect unsent user drafts; readonly only\n}\n')
  let child
  try {
    copyFileSync(process.execPath, copiedExecutable)
    writeFileSync(config, original)
    child = spawn(copiedExecutable, [
      '-e', "process.stdout.write('READY\\n'); setInterval(() => {}, 25000)",
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const [ready] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_resolve, reject) => setTimeout(() => reject(Error('fake_cli_start_timeout')), 6000)),
    ])
    assert.match(String(ready), /READY/)
    const expectedConfig = sha(original)
    assert.throws(() => installAdditive(config, source,
      expectedConfig, additiveSourceDigest(source)), /additive_opencode_processes_active_or_unknown/)
    assert.equal(sha(readFileSync(config)), expectedConfig)
    assert.equal(existsSync(path.join(root, '.chat-on-opencode-context-overlay.pending.json')), false)
    assert.equal(existsSync(path.join(root, '.chat-on-opencode-context-overlay.receipt.json')), false)
    assert.equal(existsSync(path.join(root, 'plugins', 'chat-on-opencode-context-overlay')), false)
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGTERM') // only this disposable test-owned, renamed Node child
      await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 1500))])
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  }
})
