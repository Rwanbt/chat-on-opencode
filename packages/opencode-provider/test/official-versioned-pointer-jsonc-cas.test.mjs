import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { publishRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const idle = () => ({ status: 0, stdout: '0\r\n' })
function fixture(t, bytes) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-jsonc-cas-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const from = path.join(root, 'A'), to = path.join(root, 'G')
  for (const dir of [from, to]) {
    mkdirSync(dir)
    for (const folder of ['bin', 'plugin', 'src']) mkdirSync(path.join(dir, folder))
    writeFileSync(path.join(dir, 'plugin', 'index.ts'), dir)
  }
  const config = path.join(root, 'opencode.jsonc')
  const original = bytes(from)
  writeFileSync(config, original)
  const options = {
    configSha: sha(original), fromSha: candidateDigest(from), toSha: candidateDigest(to), probe: idle,
  }
  return { root, from, to, config, original, options }
}

test('real Windows JSONC with foreign plugins and repeated path edits only owned package member, byte-exact reversible CAS', { skip: process.platform !== 'win32' }, t => {
  const { root, from, to, config, original, options } = fixture(t, from => Buffer.from(
    '{\r\n' +
    '  // user comments MUST survive, including CRLF\r\n' +
    '  "plugins": [\r\n' +
    '    "foreign-plugin",\r\n' +
    '    { "package": ' + JSON.stringify(path.join(from, 'plugin')) + ', "settings": { "enabled": true, }, },\r\n' +
    '    { "package": "another-plugin", },\r\n' +
    '  ],\r\n' +
    '  "other": { "literal": ' + JSON.stringify(path.join(from, 'plugin')) + ', },\r\n' +
    '  "providers": { "foreign": { "enabled": true, }, },\r\n' +
    '}\r\n', 'utf8'))
  const current = JSON.stringify(path.join(from, 'plugin'))
  const replacement = JSON.stringify(path.join(to, 'plugin'))
  const expected = Buffer.from(original.toString('utf8').replace(current, replacement))
  assert.ok(original.toString('utf8').includes('// user comments'))
  assert.equal(original.toString('utf8').split(current).length, 3,
    'fixture must have old path twice: the original implementation refuses this')
  const published = publishRestartOnlyPointer(config, from, to, options)
  assert.equal(published.status, 'RESTART_REQUIRED_ONLY')
  assert.equal(published.activationAuthorized, false)
  assert.equal(published.publishedConfigSha256, sha(expected))
  assert.deepEqual(readFileSync(config), expected)
  assert.equal(expected.toString('utf8').split(current).length, 2,
    'unrelated foreign path must remain byte-for-byte unchanged')
  const reversed = publishRestartOnlyPointer(config, to, from, {
    configSha: sha(expected), fromSha: options.toSha, toSha: options.fromSha, probe: idle,
  })
  assert.equal(reversed.status, 'RESTART_REQUIRED_ONLY')
  assert.deepEqual(readFileSync(config), original)
  assert.equal(readdirSync(root).filter(x => x.includes('versioned-')).length, 0)
})

test('a competing file edit at the last before_publish checkpoint is never overwritten', { skip: process.platform !== 'win32' }, t => {
  const { from, to, config, original, options } = fixture(t, from =>
    Buffer.from(JSON.stringify({ plugins: [{ package: path.join(from, 'plugin') }], untouched: true })))
  const competitor = Buffer.from(original.toString('utf8').replace('"untouched":true', '"untouched":"competitor"'))
  assert.notEqual(sha(original), sha(competitor))
  assert.throws(() => publishRestartOnlyPointer(config, from, to, {
    ...options,
    fault: stage => { if (stage === 'before_publish') writeFileSync(config, competitor) },
  }), /versioned_pointer_cas_changed/)
  assert.deepEqual(readFileSync(config), competitor)
  assert.equal(existsSync(path.join(path.dirname(config), '.chat-on-opencode-versioned-pointer.lock')), false)
})

test('invalid UTF-8 in foreign JSONC is rejected rather than silently rewritten', { skip: process.platform !== 'win32' }, t => {
  const { from, to, config, original, options } = fixture(t, from =>
    Buffer.concat([
      Buffer.from('{"plugins":[{"package":' + JSON.stringify(path.join(from, 'plugin')) + '}],"foreign":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]))
  assert.throws(() => publishRestartOnlyPointer(config, from, to, options), /versioned_pointer_invalid_utf8/)
  assert.deepEqual(readFileSync(config), original)
})

test('a managed-swap or chained-swap journal blocks direct pointer publication even with valid digests', { skip: process.platform !== 'win32' }, t => {
  const { root, from, to, config, original, options } = fixture(t, from =>
    Buffer.from(JSON.stringify({ plugins: [{ package: path.join(from, 'plugin') }] })))
  for (const marker of [
    '.chat-on-opencode-directory-switch.json',
    '.chat-on-opencode-directory-next',
    '.chat-on-opencode-chain-prepare.json',
    '.chat-on-opencode-chain-active-previous',
  ]) {
    const file = path.join(root, marker)
    writeFileSync(file, JSON.stringify({ version: 1, configSha: options.configSha }))
    assert.throws(() => publishRestartOnlyPointer(config, from, to, options),
      /versioned_pointer_managed_transition_pending/, marker)
    assert.deepEqual(readFileSync(config), original, marker)
    rmSync(file)
  }
  const added = path.join(root, '.chat-on-opencode-directory-switch.json')
  assert.throws(() => publishRestartOnlyPointer(config, from, to, {
    ...options, fault: stage => {
      if (stage === 'before_publish') writeFileSync(added, 'concurrent owned transaction')
    },
  }), /versioned_pointer_managed_transition_pending/)
  assert.deepEqual(readFileSync(config), original)
  assert.equal(existsSync(path.join(root, '.chat-on-opencode-versioned-pointer.lock')), false)
})
