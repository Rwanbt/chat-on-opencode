import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { publishRestartOnlyPointer, inspectRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const probe = () => ({ status: 0, stdout: '0\r\n' })
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-native-pointer-os-'))
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
function waitMessage(child, predicate, ms = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(Error('child_event_timeout')) }, ms)
    const onMessage = msg => { if (predicate(msg)) { cleanup(); resolve(msg) } }
    const onExit = (code, signal) => { cleanup(); reject(Error('child_early_exit_' + code + '_' + signal)) }
    function cleanup() { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit) }
    child.on('message', onMessage)
    child.on('exit', onExit)
  })
}
async function startReader(config, oldSha, newSha) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./official-versioned-pointer-reader-child.mjs', import.meta.url)),
    config, oldSha, newSha], { windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] })
  await waitMessage(child, msg => msg.type === 'ready')
  return child
}

test('Windows native write-through publication is one rename with an independent OS reader polling full old/new bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t)
  const reader = await startReader(f.config, f.oldSha, f.newSha)
  t.after(() => { if (!reader.killed) reader.kill() })
  const result = publishRestartOnlyPointer(f.config, f.a, f.b, {
    configSha: f.oldSha, fromSha: f.aSha, toSha: f.bSha, probe,
  })
  assert.equal(result.publishMethod, 'win32_MoveFileExW_REPLACE_EXISTING_WRITE_THROUGH')
  assert.equal(result.activationAuthorized, false)
  assert.equal(inspectRestartOnlyPointer(f.config, f.oldSha, f.newSha).state, 'NEW')
  assert.deepEqual(readFileSync(f.config), f.updated)
  await new Promise(resolve => setTimeout(resolve, 100))
  const done = waitMessage(reader, msg => msg.type === 'result')
  reader.send({ type: 'stop' })
  const observation = await done
  assert.equal(observation.invalid, 0, 'no missing/partially-written file from a second process')
  assert.ok(observation.oldCount > 0, 'reader observed the previous generation')
  assert.ok(observation.newCount > 0, 'reader observed the new generation')
})

test('Windows actual no-FILE_SHARE_DELETE OS handle makes native publication fail closed, then permits retry', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t)
  const command = `$ErrorActionPreference='Stop'; $p=$env:COO_NATIVE_TEST_CONFIG; $h=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); Start-Sleep -Seconds 15; $h.Dispose()`
  const holder = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', command], {
    windowsHide: true, env: { ...process.env, COO_NATIVE_TEST_CONFIG: f.config },
    stdio: ['ignore','pipe','pipe'],
  })
  t.after(() => { if (!holder.killed) holder.kill() })
  let output = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('handle_holder_timeout')), 10000)
    holder.stdout.on('data', b => { output += b.toString(); if (output.includes('LOCKED')) { clearTimeout(timer); resolve() } })
    holder.once('exit', (c,s) => { clearTimeout(timer); reject(Error('holder_exited_' + c + '_' + s)) })
  })
  assert.throws(() => publishRestartOnlyPointer(f.config, f.a, f.b, {
    configSha: f.oldSha, fromSha: f.aSha, toSha: f.bSha, probe,
  }), /versioned_pointer_native_publish_refused_win32_(5|32)/,
  'incompatible Windows handle must fail closed with a categorized native code')
  assert.deepEqual(readFileSync(f.config), f.original)
  assert.equal(existsSync(path.join(f.root, '.chat-on-opencode-versioned-pointer.lock')), false)
  holder.kill()
  await new Promise(resolve => holder.once('exit', resolve))
  const success = publishRestartOnlyPointer(f.config, f.a, f.b, {
    configSha: f.oldSha, fromSha: f.aSha, toSha: f.bSha, probe,
  })
  assert.equal(success.publishMethod, 'win32_MoveFileExW_REPLACE_EXISTING_WRITE_THROUGH')
  assert.deepEqual(readFileSync(f.config), f.updated)
})

test('OS child edits after the JS preflight: native held-handle CAS must reject rather than overwrite', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const competing = Buffer.from(f.original.toString('utf8').replace('"largeForeign":"', '"largeForeign":"FOREIGN_EDIT_'))
  let injected = false
  assert.throws(() => publishRestartOnlyPointer(f.config, f.a, f.b, {
    configSha: f.oldSha, fromSha: f.aSha, toSha: f.bSha, probe,
    fault: stage => {
      if (stage !== 'after_preflight_before_native') return
      injected = true
      const child = spawnSync(process.execPath, ['-e',
        `const fs=require('node:fs'); const p=process.argv[1]; const b=fs.readFileSync(p,'utf8'); fs.writeFileSync(p,b.replace('"largeForeign":"','"largeForeign":"FOREIGN_EDIT_'))`,
        f.config], { windowsHide: true, timeout: 5000 })
      assert.equal(child.status, 0, 'independent OS writer must complete after JS SHA check')
    },
  }), /versioned_pointer_native_cas_changed/)
  assert.equal(injected, true, 'test must force real second-process write inside the widened native helper window')
  assert.deepEqual(readFileSync(f.config), competing)
})
