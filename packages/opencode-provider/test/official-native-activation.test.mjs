import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { installProvider, inspectInstalledProvider } from '../src/official-install.mjs'
import { previewNativeActivation } from '../src/official-native-activation.mjs'
import { parseNativePlan } from '../bin/official-native-activation.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const bundleDir = fileURLToPath(new URL('..', import.meta.url))
const script = fileURLToPath(new URL('../bin/official-native-activation.mjs', import.meta.url))
function installed(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coo-native-plan-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of ['opencode', 'isolated']) mkdirSync(path.join(dir, name))
  const config = path.join(dir, 'opencode', 'opencode.jsonc')
  const original = '{\r\n// preserve my Goal/Loop/Daemon\r\n"plugins":["goal","loop"],"providers":{"other":5},"daemon":{"enabled":true}\r\n}\r\n'
  writeFileSync(config, original)
  writeFileSync(path.join(dir, 'cli.exe'), 'synthetic CLI')
  writeFileSync(path.join(dir, 'runtime.exe'), 'synthetic runtime')
  writeFileSync(path.join(dir, 'isolated', 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  installProvider({
    configFile: config, officialCli: path.join(dir, 'cli.exe'), bundleDir,
    runtimeExecutable: path.join(dir, 'runtime.exe'), runtimeData: path.join(dir, 'isolated'),
    nodeExecutable: process.execPath,
  }, { runner: () => ({ status: 0, stdout: 'opencode v2.1.4\n' }) })
  return { dir, config, manifest: path.join(dir, 'opencode', '.chat-on-opencode-managed', 'install-manifest.json') }
}

test('OAuth JSONC preview preserves every noninsertion byte and does not mutate installed files', t => {
  const v = installed(t)
  const configBefore = readFileSync(v.config), manifestBefore = readFileSync(v.manifest)
  const outcome = previewNativeActivation(v.config)
  assert.equal(outcome.status, 'NO_GO_ATOMIC_CONFIG_CAS_UNPROVEN')
  assert.equal(outcome.promotionAllowed, false)
  assert.equal(outcome.currentSha256, sha(configBefore))
  assert.equal(outcome.proposedSha256, sha(outcome.proposed))
  assert.equal(outcome.proposed.includes('"nativeOAuth":"preview"'), true)
  assert.equal(outcome.proposed.replace(',"nativeOAuth":"preview"', ''), configBefore.toString('utf8'))
  assert.deepEqual(readFileSync(v.config), configBefore)
  assert.deepEqual(readFileSync(v.manifest), manifestBefore)
  inspectInstalledProvider(v.config)
  const cli = spawnSync(process.execPath, [script, '--plan', '--config', v.config, '--mode', 'oauth'],
    { encoding: 'utf8', timeout: 5000 })
  assert.equal(cli.status, 0, cli.stderr)
  const safe = JSON.parse(cli.stdout)
  assert.equal(safe.proposed, undefined)
  assert.equal(JSON.stringify(safe).includes('runtime.exe'), false)
  assert.equal(JSON.stringify(safe).includes('goal'), false)
})

test('text-only proposal rejects missing OAuth/catalog and requires exact account-visible model', t => {
  const v = installed(t)
  assert.throws(() => previewNativeActivation(v.config, { mode: 'text' }),
    /native_activation_oauth_bootstrap_required/)
  const oauth = previewNativeActivation(v.config)
  // Build an entirely synthetic OAuth-enabled installed fixture for read-only planning.
  writeFileSync(v.config, oauth.proposed)
  const manifest = JSON.parse(readFileSync(v.manifest, 'utf8'))
  manifest.installedSha256 = sha(oauth.proposed)
  writeFileSync(v.manifest, JSON.stringify(manifest))
  const opts = { mode: 'text', modelID: 'synthetic-gpt', accountID: 'subject-fixture',
    catalog: { accountID: 'subject-fixture', models: [{ slug: 'synthetic-gpt', displayName: 'Fixture' }] } }
  assert.throws(() => previewNativeActivation(v.config, { ...opts, catalog: undefined }),
    /catalog_model_not_authorized/)
  assert.throws(() => previewNativeActivation(v.config, { ...opts, accountID: 'wrong' }),
    /catalog_model_not_authorized/)
  const current = readFileSync(v.config), beforeManifest = readFileSync(v.manifest)
  const text = previewNativeActivation(v.config, opts)
  assert.ok(text.proposed.includes('"nativeInference":"text"'))
  assert.ok(text.proposed.includes('"synthetic-gpt"'))
  assert.ok(text.proposed.includes('"baseURL":"https://api.openai.com/v1"'))
  assert.ok(text.proposed.includes('"daemon":{"enabled":true}'))
  assert.equal(text.promotionAllowed, false)
  assert.deepEqual(readFileSync(v.config), current)
  assert.deepEqual(readFileSync(v.manifest), beforeManifest)
  assert.throws(() => parseNativePlan(['--plan', '--config', v.config, '--mode', 'text']),
    /native_activation_verified_catalog_required_for_text/)
})

test('pending directory swap blocks preview; unknown CLI edits are never accepted', t => {
  const v = installed(t)
  writeFileSync(path.join(v.dir, 'opencode', '.chat-on-opencode-directory-switch.json'), '{}')
  assert.throws(() => previewNativeActivation(v.config), /native_activation_managed_transaction_pending/)
  assert.throws(() => parseNativePlan(['--activate', '--config', v.config, '--mode', 'oauth']),
    /native_activation_dry_run_only/)
  assert.throws(() => parseNativePlan(['--plan', '--config', v.config, '--mode', 'oauth', '--token', 'synthetic']),
    /native_activation_dry_run_only/)
})
