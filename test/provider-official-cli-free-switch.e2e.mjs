/**
 * Real official OpenCode 2.1.4 provider-switch E2E, with local synthetic OTHER
 * provider. A passing test does not count as authenticated third-party inference.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32', 'real official Windows CLI only')
const cli = process.env.CHAT_ON_OPENCODE_TEST_CLI
assert.ok(cli && path.isAbsolute(cli) && existsSync(cli), 'official CLI executable missing')
const root = fileURLToPath(new URL('..', import.meta.url))
const exe = path.join(root, 'release', 'provider', 'win-unpacked', 'Chat On OpenCode Provider.exe')
const plugin = path.join(root, 'release', 'provider', 'opencode-plugin')
assert.ok(existsSync(exe) && existsSync(path.join(plugin, 'plugin', 'index.ts')))
const temp = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-foreign-'))
const folder = name => path.join(temp, name)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function listen(server, port) {
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve))
}
let client
let thirdParty
const sentinels = []
let unwantedContacts = 0
let foreignCalls = 0
let foreignHeaders = []
try {
  for (const name of ['appdata', 'localappdata', 'config', 'data', 'cache', 'workspace', 'isolated']) {
    await mkdir(folder(name), { recursive: true })
  }
  const fixture = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', folder('isolated')], {
    cwd: root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(fixture.status, 0, 'isolated provider fixture invalid')
  for (const port of [8765, 8766]) {
    const sentinel = createServer(socket => { unwantedContacts++; socket.destroy() })
    await listen(sentinel, port)
    sentinels.push(sentinel)
  }
  thirdParty = http.createServer(async (req, res) => {
    foreignCalls++
    foreignHeaders.push({
      route: req.url, method: req.method,
      injectedMessageIdentity: Boolean(req.headers['x-opencode-message-id']),
      injectedSessionIdentity: Boolean(req.headers['x-opencode-session-id']),
    })
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.byteLength
      if (bytes > 1_048_576) { res.writeHead(413); res.end(); return }
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404); res.end(); return
    }
    const data = (delta, done = null) => JSON.stringify({
      id: 'local-foreign-fixture', object: 'chat.completion.chunk',
      model: 'safe-text', created: 1, choices: [{ index: 0, delta, finish_reason: done }],
    })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    res.end('data: ' + data({ role: 'assistant', content: 'FOREIGN_FIXTURE_ONLY' }) + '\\n\\n' +
      'data: ' + data({}, 'stop') + '\\n\\ndata: [DONE]\\n\\n')
  })
  await listen(thirdParty, 0)
  const thirdPort = thirdParty.address().port
  const gatewayPort = await freePort()
  const generate = spawnSync(process.execPath, [
    path.join(root, 'packages', 'opencode-provider', 'bin', 'generate-config.mjs'),
    '--runtime', exe, '--data', folder('isolated'), '--node', process.execPath,
    '--plugin-dir', plugin, '--port', String(gatewayPort),
  ], { cwd: folder('workspace'), shell: false, windowsHide: true, encoding: 'utf8', timeout: 8000 })
  assert.equal(generate.status, 0, 'failed to generate scoped Chat On OpenCode plugin')
  const config = JSON.parse(generate.stdout)
  config.plugins[0].options.nativeOAuth = 'off'
  config.providers['foreign-fixture'] = {
    name: 'Local foreign provider proof only',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:' + thirdPort + '/v1' },
    models: { 'safe-text': {
      name: 'Independent local model proof',
      capabilities: { tools: false, input: ['text'], output: ['text'] },
      limit: { context: 65536, output: 2048 },
    } },
  }
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(CHAT_ON_OPENCODE_|COS_|ELECTRON_|OPENAI_API_KEY$|OPENCODE_SERVER_PASSWORD$)/i.test(key)) delete env[key]
  }
  Object.assign(env, {
    APPDATA: folder('appdata'), LOCALAPPDATA: folder('localappdata'),
    XDG_CONFIG_HOME: folder('config'), XDG_DATA_HOME: folder('data'),
    XDG_CACHE_HOME: folder('cache'), OPENCODE_CONFIG_DIR: folder('config'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1',
  })
  const stdout = []
  let stderrBytes = 0
  client = spawn(cli, ['run', '--standalone', '--format', 'json',
    '--model', 'foreign-fixture/safe-text', '--agent', 'build',
    'Reply with FOREIGN_FIXTURE_ONLY'], {
    cwd: folder('workspace'), env, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  client.stdout.on('data', bytes => { if (stdout.join('').length < 120000) stdout.push(String(bytes)) })
  client.stderr.on('data', bytes => { stderrBytes += bytes.length })
  const end = Date.now() + 45000
  let sawText = false
  while (Date.now() < end && client.exitCode === null) {
    if (stdout.join('').includes('FOREIGN_FIXTURE_ONLY')) { sawText = true; break }
    await pause(150)
  }
  const items = stdout.join('').split(/\\r?\\n/).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const text = items.filter(event => event.type === 'text')
    .map(event => event.part?.text ?? '').join('')
  process.stdout.write('FOREIGN_PROVIDER_CATEGORICAL=' + JSON.stringify({
    outputSeen: sawText, parsedText: text.length > 0, calls: foreignCalls,
    unwantedConnections: unwantedContacts, stderrNonempty: stderrBytes > 0,
    eventTypes: [...new Set(items.map(event => event.type))].sort(),
  }) + '\\n')
  assert.equal(text, 'FOREIGN_FIXTURE_ONLY', 'official CLI did not stream the selected other provider')
  assert.ok(foreignCalls >= 1, 'foreign provider was never reached')
  assert.ok(foreignHeaders.some(x => x.route === '/v1/chat/completions' && x.method === 'POST'))
  assert.ok(foreignHeaders.every(x => !x.injectedMessageIdentity && !x.injectedSessionIdentity),
    'Chat On OpenCode hijacked the unrelated provider request headers')
  assert.equal(unwantedContacts, 0, 'switching providers contacted CoS personal/provider bridge')
  process.stdout.write('OFFICIAL_CLI_FREE_PROVIDER_SWITCH=PASS\\n')
} finally {
  if (client && client.exitCode === null) {
    client.kill('SIGTERM')
    await Promise.race([new Promise(resolve => client.once('close', resolve)), pause(2500)])
    if (client.exitCode === null && client.pid) {
      // Only the disposable job-owned child tree on GitHub Windows Actions.
      spawnSync('taskkill', ['/F', '/T', '/PID', String(client.pid)], {
        shell: false, windowsHide: true, timeout: 8000,
      })
    }
  }
  if (thirdParty) await new Promise(resolve => thirdParty.close(resolve))
  for (const sentinel of sentinels) await new Promise(resolve => sentinel.close(resolve))
  for (let n = 0; n < 20; n++) {
    try { await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); break }
    catch (error) { if (n === 19) throw error; await pause(400) }
  }
}
