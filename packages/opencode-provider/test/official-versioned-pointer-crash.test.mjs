import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { inspectRestartOnlyPointer, publishRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const probe = () => ({ status: 0, stdout: '0\r\n' })

test('a process crash before or after pointer publication cannot permanently prevent a pinned recovery',
  { skip: process.platform !== 'win32' }, t => {
    for (const crashAt of ['before_publish', 'after_publish']) {
      const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-crash-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const a = path.join(root, 'A'), b = path.join(root, 'B')
      for (const directory of [a, b]) {
        mkdirSync(directory)
        for (const folder of ['bin', 'plugin', 'src']) mkdirSync(path.join(directory, folder))
        writeFileSync(path.join(directory, 'plugin', 'index.ts'), directory)
      }
      const config = path.join(root, 'opencode.jsonc')
      const original = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(a, 'plugin') }] }))
      const updated = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(b, 'plugin') }] }))
      writeFileSync(config, original)
      const oldSha = sha(original), newSha = sha(updated)
      const aSha = candidateDigest(a), bSha = candidateDigest(b)
      const moduleUrl = new URL('../src/official-versioned-pointer.mjs', import.meta.url).href
      const digestUrl = new URL('../src/official-upgrade.mjs', import.meta.url).href
      const script = `
        const { publishRestartOnlyPointer } = await import(${JSON.stringify(moduleUrl)})
        const { candidateDigest } = await import(${JSON.stringify(digestUrl)})
        publishRestartOnlyPointer(${JSON.stringify(config)}, ${JSON.stringify(a)}, ${JSON.stringify(b)}, {
          configSha: ${JSON.stringify(oldSha)}, fromSha: candidateDigest(${JSON.stringify(a)}),
          toSha: candidateDigest(${JSON.stringify(b)}),
          probe: () => ({ status: 0, stdout: '0\\r\\n' }),
          fault: point => { if (point === ${JSON.stringify(crashAt)}) process.exit(73) }
        })
        process.exit(74)
      `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 10000, windowsHide: true })
      assert.equal(child.status, 73, `expected abrupt ${crashAt} crash: ${child.stderr}`)
      const afterCrashState = crashAt === 'before_publish' ? 'OLD' : 'NEW'
      assert.equal(inspectRestartOnlyPointer(config, oldSha, newSha).state, afterCrashState)
      assert.equal(existsSync(path.join(root, '.chat-on-opencode-versioned-pointer.lock')), true,
        'abrupt process termination must leave an orphaned lock for recovery')
      const from = crashAt === 'before_publish' ? a : b
      const to = crashAt === 'before_publish' ? b : a
      const promoted = publishRestartOnlyPointer(config, from, to, {
        configSha: crashAt === 'before_publish' ? oldSha : newSha,
        fromSha: crashAt === 'before_publish' ? aSha : bSha,
        toSha: crashAt === 'before_publish' ? bSha : aSha, probe,
      })
      assert.equal(promoted.status, 'RESTART_REQUIRED_ONLY')
      assert.equal(inspectRestartOnlyPointer(config, oldSha, newSha).state,
        crashAt === 'before_publish' ? 'NEW' : 'OLD')
      assert.equal(existsSync(path.join(root, '.chat-on-opencode-versioned-pointer.lock')), false)
    }
  })

test('recovery rejects active/unknown locks, but detects a reused PID by OS creation time',
  { skip: process.platform !== 'win32' }, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-locked-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const from = path.join(root, 'A'), to = path.join(root, 'B')
    for (const directory of [from, to]) {
      mkdirSync(directory)
      for (const folder of ['bin', 'plugin', 'src']) mkdirSync(path.join(directory, folder))
      writeFileSync(path.join(directory, 'plugin', 'index.ts'), directory)
    }
    const config = path.join(root, 'opencode.jsonc')
    const original = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(from, 'plugin') }] }))
    writeFileSync(config, original)
    const opts = { configSha: sha(original), fromSha: candidateDigest(from), toSha: candidateDigest(to), probe }
    const lock = path.join(root, '.chat-on-opencode-versioned-pointer.lock')
    writeFileSync(lock, 'unowned-legacy-lock')
    assert.throws(() => publishRestartOnlyPointer(config, from, to, opts), /lock_unverifiable/)
    assert.equal(readFileSync(lock, 'utf8'), 'unowned-legacy-lock')
    const script = `$ErrorActionPreference='Stop'; (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`
    const identity = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8', timeout: 7000 })
    assert.equal(identity.status, 0)
    assert.match(identity.stdout.trim(), /^\d+$/)
    writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid,
      start: identity.stdout.trim(), nonce: '11111111-2222-4333-8444-555555555555' }))
    assert.throws(() => publishRestartOnlyPointer(config, from, to, opts), /lock_owner_active/)
    assert.deepEqual(readFileSync(config), original)
    assert.equal(existsSync(lock), true)
    assert.equal(existsSync(lock + '.recover'), false)
    writeFileSync(lock + '.recover', 'interrupted-recovery-owner-unverified')
    assert.throws(() => publishRestartOnlyPointer(config, from, to, opts), /recovery_active/)
    assert.deepEqual(readFileSync(config), original)
    rmSync(lock + '.recover')
    // The numeric PID is currently live, but cannot be this former owner:
    // the OS creation timestamp differs. Blind PID-based recovery would fail.
    writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid,
      start: '1', nonce: '11111111-2222-4333-8444-555555555555' }))
    const result = publishRestartOnlyPointer(config, from, to, opts)
    assert.equal(result.status, 'RESTART_REQUIRED_ONLY')
    assert.equal(existsSync(lock), false)
  })

test('non-Windows refuses pointer writes before creating any lock',
  { skip: process.platform === 'win32' }, t => {
    const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-other-os-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const from = path.join(root, 'A'), to = path.join(root, 'B')
    for (const directory of [from, to]) {
      mkdirSync(directory)
      for (const folder of ['bin', 'plugin', 'src']) mkdirSync(path.join(directory, folder))
      writeFileSync(path.join(directory, 'plugin', 'index.ts'), directory)
    }
    const config = path.join(root, 'opencode.jsonc')
    const before = Buffer.from(JSON.stringify({ plugins: [{ package: path.join(from, 'plugin') }] }))
    writeFileSync(config, before)
    assert.throws(() => publishRestartOnlyPointer(config, from, to, {
      configSha: sha(before), fromSha: candidateDigest(from), toSha: candidateDigest(to), probe,
    }), /versioned_pointer_windows_only/)
    assert.deepEqual(readFileSync(config), before)
    assert.equal(existsSync(path.join(root, '.chat-on-opencode-versioned-pointer.lock')), false)
  })
