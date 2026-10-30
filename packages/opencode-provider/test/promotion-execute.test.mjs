import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJSONC } from '../src/jsonc-scoped.mjs'
import { createAuthorisationChallenge, issueAuthorisationReceipt } from '../src/promotion-authorisation.mjs'
import { executeAuthorisedTransition } from '../src/promotion-transition.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const idle = () => ({ status: 0, stdout: '0\r\n' })
const hex = c => c.repeat(64)

const CONFIG = [
  '{',
  '  // a foreign comment must survive',
  '  "plugins": [',
  '    { "package": "C:\\\\ours\\\\plugin", "options": { "nativeTools": "off" }, },',
  '  ],',
  '}',
  '',
].join('\r\n')

function nativeToolsEdit(bytes, value) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const root = readJSONC(text)
  const plugins = root.members.find(member => member.key === 'plugins').node
  const own = plugins.members.map(member => member.node)
    .find(node => node.type === 'object' && node.members.some(member => member.key === 'options'))
  const options = own.members.find(member => member.key === 'options').node
  const tools = options.members.find(member => member.key === 'nativeTools').node
  return { at: tools.start, end: tools.end, data: JSON.stringify(value) }
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-promotion-execute-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = path.join(root, 'opencode.jsonc')
  const authorisationDir = path.join(root, 'authorisation')
  mkdirSync(authorisationDir)
  writeFileSync(config, Buffer.from(CONFIG, 'utf8'))
  return { config, authorisationDir, bytes: readFileSync(config) }
}

function receiptFor(configSha, authorisationDir) {
  const snapshot = { config: configSha, scope: hex('a'), activeGeneration: hex('b'), candidateGeneration: hex('c') }
  const challenge = createAuthorisationChallenge(snapshot, { authorisationDir })
  return issueAuthorisationReceipt(challenge,
    { reviewedAllComposers: true, draftsSavedOrDiscarded: true }, snapshot,
    { processIdle: true, authorisationDir })
}

test('an authorised receipt publishes exactly the scoped edit and nothing else', { skip: process.platform !== 'win32' }, t => {
  const { config, authorisationDir, bytes } = fixture(t)
  const oldSha = sha(bytes)
  const receipt = receiptFor(oldSha, authorisationDir)
  assert.equal(receipt.status, 'ACTIVATION_AUTHORISED')
  const current = { config: oldSha, scope: hex('a'), activeGeneration: hex('b'), candidateGeneration: hex('c') }
  const result = executeAuthorisedTransition({
    config, edits: [nativeToolsEdit(bytes, 'coding')], configSha: oldSha, receipt, current,
    authorisationDir, probe: idle,
  })
  assert.equal(result.status, 'RESTART_REQUIRED_ONLY')
  assert.equal(result.changed, true)
  assert.equal(result.promotionAllowed, false)
  assert.equal(result.activationAuthorized, false)
  assert.deepEqual(readFileSync(config),
    Buffer.from(CONFIG.replace('"nativeTools": "off"', '"nativeTools": "coding"'), 'utf8'))
})

test('a receipt is single-use: a replay changes nothing', { skip: process.platform !== 'win32' }, t => {
  const { config, authorisationDir, bytes } = fixture(t)
  const oldSha = sha(bytes)
  const receipt = receiptFor(oldSha, authorisationDir)
  const current = { config: oldSha, scope: hex('a'), activeGeneration: hex('b'), candidateGeneration: hex('c') }
  const first = executeAuthorisedTransition({
    config, edits: [nativeToolsEdit(bytes, 'coding')], configSha: oldSha, receipt, current, authorisationDir, probe: idle,
  })
  assert.equal(first.changed, true)
  const afterFirst = readFileSync(config)
  const replay = executeAuthorisedTransition({
    config, edits: [nativeToolsEdit(bytes, 'coding')], configSha: oldSha, receipt, current, authorisationDir, probe: idle,
  })
  assert.equal(replay.status, 'NO_GO')
  assert.equal(replay.reason, 'authorisation_receipt_consumed')
  assert.equal(replay.changed, false)
  assert.deepEqual(readFileSync(config), afterFirst)
})

test('without an authorised receipt the transition changes no byte', { skip: process.platform !== 'win32' }, t => {
  const { config, authorisationDir, bytes } = fixture(t)
  const oldSha = sha(bytes)
  const current = { config: oldSha, scope: hex('a'), activeGeneration: hex('b'), candidateGeneration: hex('c') }
  const result = executeAuthorisedTransition({
    config, edits: [nativeToolsEdit(bytes, 'coding')], configSha: oldSha, receipt: null, current,
    authorisationDir, probe: idle,
  })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.changed, false)
  assert.deepEqual(readFileSync(config), bytes)
})
