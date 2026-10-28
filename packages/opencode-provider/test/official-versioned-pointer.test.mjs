import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { publishRestartOnlyPointer, inspectRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

const sha = b => createHash('sha256').update(b).digest('hex')
test('Windows disposable versioned pointer publishes at one config rename and rolls back by reverse CAS', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const a = path.join(root, 'A'), g = path.join(root, 'G')
  for (const dir of [a, g]) {
    mkdirSync(dir)
    for (const sub of ['bin', 'plugin', 'src']) mkdirSync(path.join(dir, sub))
    writeFileSync(path.join(dir, 'plugin', 'index.ts'), dir)
  }
  const config = path.join(root, 'opencode.jsonc')
  writeFileSync(config, JSON.stringify({ plugins: [{ package: path.join(a, 'plugin') }], keepForeign: true }))
  const initial = readFileSync(config), oldSha = sha(initial)
  const opts = { configSha: oldSha, fromSha: candidateDigest(a), toSha: candidateDigest(g),
    probe: () => ({ status: 0, stdout: '0\r\n' }) }
  assert.throws(() => publishRestartOnlyPointer(config, a, g, { ...opts, fault: stage => {
    if (stage === 'before_publish') throw Error('RED_before_publication')
  } }), /RED_before_publication/)
  assert.deepEqual(readFileSync(config), initial)
  const result = publishRestartOnlyPointer(config, a, g, opts)
  assert.equal(result.status, 'RESTART_REQUIRED_ONLY')
  assert.equal(result.activationAuthorized, false)
  assert.equal(inspectRestartOnlyPointer(config, oldSha, result.publishedConfigSha256).state, 'NEW')
  assert.equal(JSON.parse(readFileSync(config)).keepForeign, true)
  assert.equal(candidateDigest(a), opts.fromSha)
  // Failure injected after the single commit point leaves COMPLETE new bytes,
  // not an absent or partially renamed active directory.
  assert.throws(() => publishRestartOnlyPointer(config, g, a, {
    configSha: result.publishedConfigSha256, fromSha: opts.toSha, toSha: opts.fromSha,
    probe: opts.probe, fault: stage => { if (stage === 'after_publish') throw Error('after_commit') },
  }), /after_commit/)
  assert.equal(inspectRestartOnlyPointer(config, oldSha, result.publishedConfigSha256).state, 'OLD')
  // Re-publish new before checking an ordinary reverse-CAS rollback.
  publishRestartOnlyPointer(config, a, g, opts)
  const revert = publishRestartOnlyPointer(config, g, a, { configSha: result.publishedConfigSha256,
    fromSha: opts.toSha, toSha: opts.fromSha, probe: opts.probe })
  assert.equal(revert.status, 'RESTART_REQUIRED_ONLY')
  assert.deepEqual(readFileSync(config), initial)
  assert.throws(() => publishRestartOnlyPointer(config, a, g, { ...opts, configSha: '0'.repeat(64) }), /cas_changed/)
  assert.throws(() => publishRestartOnlyPointer(config, a, g, { ...opts,
    probe: () => ({ status: 0, stdout: '1\r\n' }) }), /busy_or_unknown/)
})
