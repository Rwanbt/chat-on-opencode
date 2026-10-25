import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { installProvider, rollbackProvider } from '../src/official-install.mjs'

const bundleDir = fileURLToPath(new URL('..', import.meta.url))

test('offline scoped install persists no gateway credential and preserves unrelated providers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-ephemeral-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = path.join(root, 'opencode')
  const runtimeData = path.join(root, 'provider-profile')
  await mkdir(configDir)
  await mkdir(runtimeData)
  await writeFile(path.join(runtimeData, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const original = '{"plugins":[{"package":"other-plugin"}],"providers":{"other":{"models":{"another":{"name":"Unrelated"}}}}}\n'
  const configFile = path.join(configDir, 'opencode.jsonc')
  await writeFile(configFile, original)
  const officialCli = path.join(root, 'official-opencode.exe')
  const runtimeExecutable = path.join(root, 'fork-runtime.exe')
  await writeFile(officialCli, '')
  await writeFile(runtimeExecutable, '')
  const options = { configFile, officialCli, bundleDir, runtimeExecutable,
    runtimeData, nodeExecutable: process.execPath }
  const installed = installProvider(options, { runner: () => ({ status: 0, stdout: 'opencode v2.1.4\n' }) })
  const active = await readFile(configFile, 'utf8')
  const manifest = await readFile(path.join(configDir, '.chat-on-opencode-managed', 'install-manifest.json'), 'utf8')
  assert.ok(active.includes('"other":{"models":{"another":{"name":"Unrelated"}}}'))
  assert.ok(active.includes('"package":"other-plugin"'))
  assert.ok(active.includes('"chat-on-opencode"'))
  for (const document of [active, manifest]) {
    assert.ok(!document.includes('CHAT_ON_OPENCODE_GATEWAY_KEY'))
    assert.ok(!document.includes('"apiKey"'))
    assert.ok(!document.includes('Bearer '))
  }
  assert.equal(typeof installed.installedSha256, 'string')
  assert.equal(rollbackProvider(configFile).rolledBack, true)
  assert.equal(await readFile(configFile, 'utf8'), original)
})
