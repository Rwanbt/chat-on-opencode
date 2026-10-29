import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { publishRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

// A Windows CRT read handle (what Node's readFileSync/openSync uses) does not
// grant FILE_SHARE_DELETE, so MoveFileExW cannot replace the file while such a
// reader holds it. An independent reader that only samples the file, an
// antivirus scan or the search indexer all produce that very short-lived
// handle. Publication must survive that transient window, and must still fail
// closed when the incompatible handle never goes away.
const sha = data => createHash('sha256').update(data).digest('hex')
const probe = () => ({ status: 0, stdout: '0\r\n' })

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-transient-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const a = path.join(root, 'A'), b = path.join(root, 'B')
  for (const dir of [a, b]) {
    mkdirSync(dir)
    for (const sub of ['bin', 'plugin', 'src']) mkdirSync(path.join(dir, sub))
    writeFileSync(path.join(dir, 'plugin', 'index.ts'), dir)
  }
  const config = path.join(root, 'opencode.jsonc')
  const original = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(a, 'plugin') }], largeForeign: 'X'.repeat(1024 * 256) }))
  const updated = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(b, 'plugin') }], largeForeign: 'X'.repeat(1024 * 256) }))
  writeFileSync(config, original)
  return { root, a, b, config, original, updated,
    oldSha: sha(original), newSha: sha(updated),
    aSha: candidateDigest(a), bSha: candidateDigest(b) }
}

// Separate real process: a CRT handle held for a bounded window, then released.
function startTransientHolder(t, config, holdMs) {
  const child = spawn(process.execPath, ['-e', `
    const { openSync, closeSync } = require('node:fs')
    const fd = openSync(process.argv[1], 'r')
    process.stdout.write('LOCKED\\n')
    setTimeout(() => { closeSync(fd); process.exit(0) }, ${holdMs})
  `, config], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (!child.killed) child.kill() })
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(Error('holder_timeout')), 10000)
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (output.includes('LOCKED')) { clearTimeout(timer); resolve(child) }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(Error('holder_exited_' + code + '_' + signal))
    })
  })
}

test('a briefly held CRT read handle cannot block native pointer publication', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = fixture(t)
  await startTransientHolder(t, f.config, 2500)
  // The incompatible handle is provably open when the first MoveFileExW runs:
  // the whole publish path reaches it in well under the hold window.
  const result = publishRestartOnlyPointer(f.config, f.a, f.b, {
    configSha: f.oldSha, fromSha: f.aSha, toSha: f.bSha, probe,
  })
  assert.equal(result.publishMethod, 'win32_MoveFileExW_REPLACE_EXISTING_WRITE_THROUGH')
  assert.equal(result.activationAuthorized, false)
  assert.equal(result.promotionAllowed, false)
  assert.deepEqual(readFileSync(f.config), f.updated, 'exactly one rename published the complete new bytes')
  assert.equal(existsSync(path.join(f.root, '.chat-on-opencode-versioned-pointer.lock')), false)
})
