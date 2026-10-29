import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createOpenCodeConfig } from '../src/config.mjs'

const pluginDir = fileURLToPath(new URL('..', import.meta.url))
const cli = fileURLToPath(new URL('../bin/generate-config.mjs', import.meta.url))

function fixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-config-test-'))
  const data = path.join(root, 'provider-data')
  const personal = path.join(root, 'personal-data')
  const runtimeExecutable = path.join(root, 'provider.exe')
  mkdirSync(data)
  mkdirSync(personal)
  writeFileSync(runtimeExecutable, '')
  writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const opts = { runtimeExecutable, runtimeData: data, nodeExecutable: process.execPath, pluginDir, personalCoSData: personal }
  try { return run({ ...opts, data, personal, root }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

test('generates installable OpenCode 2 configuration without secrets or profile writes', () => {
  fixture(opts => {
    const conf = createOpenCodeConfig({ ...opts, port: 45617 })
    assert.equal(conf.plugins[0].package, path.join(pluginDir, 'plugin'))
    assert.equal(conf.plugins[0].options.runtimeExecutable, opts.runtimeExecutable)
    assert.equal(conf.plugins[0].options.nodeExecutable, process.execPath)
    assert.equal(conf.plugins[0].options.port, '45617')
    assert.equal(conf.providers['chat-on-opencode'].settings.baseURL, 'http://127.0.0.1:45617/v1')
    assert.equal(conf.providers['chat-on-opencode'].env, undefined)
    const serialized = JSON.stringify(conf)
    assert.equal(serialized.includes('apiKey'), false)
    assert.equal(serialized.includes('CHAT_ON_OPENCODE_GATEWAY_KEY'), false)
    assert.equal(serialized.includes(opts.personal), false)
    assert.equal(conf.providers['chat-on-opencode'].models['chatgpt-default'].capabilities.tools, false)
    assert.equal(conf.providers['chat-on-opencode'].models['chatgpt-default'].limit.context, 65536,
      'OpenCode 2.1.4 must have space above its initial compaction reserve')
    const textAgent = conf.agents['chat-on-opencode-text']
    assert.equal(textAgent.model, 'chat-on-opencode/chatgpt-default')
    assert.equal(textAgent.mode, 'primary')
    assert.ok(textAgent.system.length < 256)
    assert.deepEqual(textAgent.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
    assert.equal(conf.defaultAgent, undefined, 'do not affect other provider workflows')
  })
})

test('CLI emits only configuration and refuses any secret-like argument', () => {
  fixture(opts => {
    const command = [cli, '--runtime', opts.runtimeExecutable, '--data', opts.runtimeData,
      '--node', opts.nodeExecutable, '--plugin-dir', opts.pluginDir]
    const success = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 5000 })
    assert.equal(success.status, 0, success.stderr)
    assert.equal(JSON.parse(success.stdout).plugins[0].options.nodeExecutable, process.execPath)
    const failure = spawnSync(process.execPath, [...command, '--api-key', 'unsafe'], { encoding: 'utf8', timeout: 5000 })
    assert.equal(failure.status, 1)
    assert.equal(failure.stdout, '')
    assert.match(failure.stderr, /unexpected_or_missing_config_argument/)
  })
})

test('explicit native text generates reversible OAuth-only candidate without API key or CoS substitution', () => {
  fixture(opts => {
    const conf=createOpenCodeConfig({...opts,nativeInference:'text',nativeModelID:'synthetic-gpt-model'})
    assert.equal(conf.plugins[0].options.nativeOAuth,'preview')
    assert.equal(conf.plugins[0].options.nativeInference,'text')
    assert.equal(conf.providers['chat-on-opencode'].package,'@opencode/ai/providers/openai')
    assert.equal(conf.providers['chat-on-opencode'].settings.baseURL,'https://api.openai.com/v1')
    assert.ok(conf.providers['chat-on-opencode'].models['synthetic-gpt-model'])
    assert.equal(conf.providers['chat-on-opencode'].models['synthetic-gpt-model'].capabilities.tools,false)
    assert.equal(conf.providers['chat-on-opencode'].models['synthetic-gpt-model'].limit.context,65536)
    assert.equal(conf.agents, undefined, 'native OAuth transport keeps its own consent contract')
    assert.equal(createOpenCodeConfig({...opts,nativeTools:'read'}).agents, undefined,
      'never force a text-only agent on explicitly approved native read')
    assert.equal(JSON.stringify(conf).includes('apiKey'),false)
    assert.throws(()=>createOpenCodeConfig({...opts,nativeInference:'text'}),/native_inference_requires_verified_text_model/)
    assert.throws(()=>createOpenCodeConfig({...opts,nativeInference:'text',nativeModelID:'../../bad'}),/native_inference_requires_verified_text_model/)
    assert.throws(()=>createOpenCodeConfig({...opts,nativeInference:'text',nativeModelID:'safe',nativeTools:'read'}),/native_inference_requires_verified_text_model/)
  })
})

test('native coding mode advertises tools, asks per call and never forces the text-only agent', () => {
  fixture(opts => {
    const conf = createOpenCodeConfig({ ...opts, nativeTools: 'coding' })
    assert.equal(conf.providers['chat-on-opencode'].models['chatgpt-default'].capabilities.tools, true)
    assert.deepEqual(conf.permissions, [{ action: '*', resource: '*', effect: 'ask' }])
    assert.equal(conf.agents, undefined, 'coding mode must not force the text-only agent')
    assert.equal(conf.plugins[0].options.nativeTools, 'coding')
    assert.equal(JSON.stringify(conf).includes('apiKey'), false)
    assert.throws(() => createOpenCodeConfig({ ...opts, nativeTools: 'every' }), /native_tools_mode_invalid/)
    assert.throws(() => createOpenCodeConfig({ ...opts, nativeTools: 'coding', nativeInference: 'text', nativeModelID: 'safe' }),
      /native_inference_requires_verified_text_model/)
  })
})

test('rejects personal alias, invalid profile, missing runtime and unsafe port', () => {
  fixture(opts => {
    assert.throws(() => createOpenCodeConfig({ ...opts, personalCoSData: opts.data }), /profile_overlaps_personal_userdata/)
    assert.throws(() => createOpenCodeConfig({ ...opts, runtimeData: opts.root }), /profile_overlaps_personal_userdata/)
    assert.throws(() => createOpenCodeConfig({ ...opts, port: 70000 }), /provider_port_invalid/)
    assert.throws(() => createOpenCodeConfig({ ...opts, runtimeExecutable: path.join(opts.root, 'missing.exe') }), /ENOENT/)
    writeFileSync(path.join(opts.data, 'config.json'), JSON.stringify({ controlApi: { enabled: true, allowActions: false } }))
    assert.throws(() => createOpenCodeConfig(opts), /isolated_profile_service_opt_in_required/)
  })
})
