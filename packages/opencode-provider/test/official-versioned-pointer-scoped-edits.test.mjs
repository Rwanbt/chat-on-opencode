import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJSONC } from '../src/jsonc-scoped.mjs'
import { publishScopedConfigEdits, inspectRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const idle = () => ({ status: 0, stdout: '0\r\n' })
const LOCK = '.chat-on-opencode-versioned-pointer.lock'

const CONFIG = [
  '{',
  '  // a foreign comment must survive, including CRLF',
  '  "plugins": [',
  '    "foreign-plugin",',
  '    { "package": "C:\\\\foreign\\\\plugin", "settings": { "enabled": true, }, },',
  '    { "package": "C:\\\\ours\\\\plugin", "options": { "nativeTools": "off" }, },',
  '  ],',
  '  "providers": { "foreign": { "enabled": true, }, },',
  '}',
  '',
].join('\r\n')

function fixture(t, bytes = Buffer.from(CONFIG, 'utf8')) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-pointer-scoped-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = path.join(root, 'opencode.jsonc')
  writeFileSync(config, bytes)
  return { root, config, bytes }
}

/** The edit is computed from the exact bytes the publisher will pin. */
function nativeToolsEdit(bytes, value) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const root = readJSONC(text)
  const plugins = root.members.find(member => member.key === 'plugins')?.node
  const own = plugins.members.map(member => member.node)
    .find(node => node.type === 'object' && node.members.some(member => member.key === 'options'))
  const options = own.members.find(member => member.key === 'options')?.node
  const tools = options.members.find(member => member.key === 'nativeTools')?.node
  if (tools?.type !== 'scalar') throw Error('fixture_must_own_one_nativeTools_scalar')
  return { at: tools.start, end: tools.end, data: JSON.stringify(value) }
}

test('a scoped option edit publishes under the same CAS owner and preserves every foreign byte',
  { skip: process.platform !== 'win32' }, t => {
    const { config, bytes } = fixture(t)
    const oldSha = sha(bytes)
    const edit = nativeToolsEdit(bytes, 'coding')
    const result = publishScopedConfigEdits(config, [edit], { configSha: oldSha, probe: idle })
    assert.equal(result.status, 'RESTART_REQUIRED_ONLY')
    assert.equal(result.promotionAllowed, false)
    assert.equal(result.activationAuthorized, false)
    assert.equal(result.previousConfigSha256, oldSha)
    const published = readFileSync(config)
    assert.equal(result.publishedConfigSha256, sha(published))
    // Every byte except the one owned scalar survives, comments and CRLF included.
    const expected = Buffer.from(CONFIG.replace('"nativeTools": "off"', '"nativeTools": "coding"'), 'utf8')
    assert.deepEqual(published, expected)
    assert.ok(published.toString('utf8').includes('// a foreign comment must survive'))
    assert.equal(inspectRestartOnlyPointer(config, oldSha, result.publishedConfigSha256).state, 'NEW')
    // The inverse edit restores the original bytes exactly.
    const revert = publishScopedConfigEdits(config, [nativeToolsEdit(published, 'off')], {
      configSha: result.publishedConfigSha256, probe: idle,
    })
    assert.equal(revert.status, 'RESTART_REQUIRED_ONLY')
    assert.deepEqual(readFileSync(config), bytes)
    assert.equal(existsSync(path.join(path.dirname(config), LOCK)), false)
  })

test('a competing edit at the last pre-rename checkpoint is never overwritten',
  { skip: process.platform !== 'win32' }, t => {
    const { config, bytes } = fixture(t)
    const oldSha = sha(bytes)
    const competitor = Buffer.from(CONFIG.replace('"foreign": { "enabled": true, }', '"foreign": "competitor"'), 'utf8')
    assert.throws(() => publishScopedConfigEdits(config, [nativeToolsEdit(bytes, 'coding')], {
      configSha: oldSha, probe: idle,
      fault: stage => { if (stage === 'before_publish') writeFileSync(config, competitor) },
    }), /versioned_pointer_cas_changed/)
    assert.deepEqual(readFileSync(config), competitor)
    assert.equal(existsSync(path.join(path.dirname(config), LOCK)), false)
  })

test('a scoped publication refuses a moved config, an invalid edit and an unreadable config',
  { skip: process.platform !== 'win32' }, t => {
    const { config, bytes } = fixture(t)
    const oldSha = sha(bytes)
    // A digest that does not match the file refuses before any write.
    assert.throws(() => publishScopedConfigEdits(config, [nativeToolsEdit(bytes, 'coding')], {
      configSha: '0'.repeat(64), probe: idle,
    }), /versioned_pointer_cas_changed/)
    assert.deepEqual(readFileSync(config), bytes)
    // Overlapping edits are refused: the result could not be what the caller meant.
    const edit = nativeToolsEdit(bytes, 'coding')
    assert.throws(() => publishScopedConfigEdits(config, [edit, { at: edit.at + 1, end: edit.end, data: '"read"' }], {
      configSha: oldSha, probe: idle,
    }), /versioned_pointer_edit_invalid/)
    assert.deepEqual(readFileSync(config), bytes)
    // An edit that would produce invalid JSONC is refused before publication.
    assert.throws(() => publishScopedConfigEdits(config, [{ at: edit.at, end: edit.end, data: '{' }], {
      configSha: oldSha, probe: idle,
    }), /versioned_pointer_edit_invalid/)
    assert.deepEqual(readFileSync(config), bytes)
    assert.equal(existsSync(path.join(path.dirname(config), LOCK)), false)
  })

test('a BOM config is refused for a scoped publication: caller offsets would shift',
  { skip: process.platform !== 'win32' }, t => {
    const bytes = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CONFIG, 'utf8')])
    const { config } = fixture(t, bytes)
    assert.throws(() => publishScopedConfigEdits(config, [{ at: 0, end: 1, data: '{' }], {
      configSha: sha(bytes), probe: idle,
    }), /versioned_pointer_bom_requires_manual_review/)
    assert.deepEqual(readFileSync(config), bytes)
  })

test('invalid UTF-8 and a pending managed transition block a scoped publication',
  { skip: process.platform !== 'win32' }, t => {
    const invalid = Buffer.concat([
      Buffer.from('{"plugins":[{"package":"C:\\\\ours\\\\plugin","options":{"nativeTools":"off"}}],"foreign":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ])
    const { config, bytes } = fixture(t, invalid)
    assert.throws(() => publishScopedConfigEdits(config, [{ at: 0, end: 1, data: '{' }], {
      configSha: sha(bytes), probe: idle,
    }), /versioned_pointer_invalid_utf8/)
    assert.deepEqual(readFileSync(config), bytes)
    const clean = fixture(t)
    const marker = path.join(path.dirname(clean.config), '.chat-on-opencode-directory-switch.json')
    writeFileSync(marker, JSON.stringify({ version: 1, configSha: sha(clean.bytes) }))
    assert.throws(() => publishScopedConfigEdits(clean.config, [nativeToolsEdit(clean.bytes, 'coding')], {
      configSha: sha(clean.bytes), probe: idle,
    }), /versioned_pointer_managed_transition_pending/)
    assert.deepEqual(readFileSync(clean.config), clean.bytes)
  })
