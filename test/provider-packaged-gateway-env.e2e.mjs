/**
 * Real packaged Electron + gateway startup under the environment a standalone
 * official OpenCode CLI uses. No account, cookies, prompts, or personal profile.
 * Do not replace this acceptance gate with the mock CoS fixture.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, connect as connectSocket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../packages/opencode-provider/src/lifecycle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../release/provider/win-unpacked')
const executable = path.join(root, 'Chat On OpenCode Provider.exe')
const entry = path.resolve(here, '../packages/opencode-provider/src/server.mjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function acceptsConnection(port) {
  return await new Promise(resolve => {
    const socket = connectSocket({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false) })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

if (process.argv[2] === '--gateway-worker') {
  const [, , , profile, rawPort] = process.argv
  const port = Number(rawPort)
  const key = randomBytes(32).toString('hex')
  const lifecycle = new GatewayLifecycle({
    entry, runtimeExecutable: executable, runtimeData: profile,
    node: process.execPath, key, port,
  }, {
    // Only the CI fixture: retain the gateway's categorically redacted failure
    // code when the real packaged Electron fails before /health can bind.
    launcher: (exe, args, opts) => spawn(exe, args, {
      ...opts, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
  })
  let endpointEverSeen = false
  let gatewayErrorCode = 'none'
  const endpoint = path.join(profile, 'control-api', 'endpoint.json')
  const monitor = setInterval(() => { endpointEverSeen ||= existsSync(endpoint) }, 300)
  try {
    const starting = lifecycle.ensure()
    lifecycle.child?.stderr?.on('data', chunk => {
      const m = /Chat On OpenCode cannot connect to its CoS runtime:\s+([a-z0-9_]+)/i.exec(String(chunk))
      if (m) gatewayErrorCode = m[1]
    })
    await starting
    const response = await fetch('http://127.0.0.1:' + port + '/health', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.gateway, 'chat-on-opencode')
    assert.equal(await acceptsConnection(8766), true, 'provider bridge must bind exact 8766')
    assert.equal(health.provider?.canAttempt, false, 'unpaired test profile may not accept prompts')
    process.stdout.write('OWNED_PACKAGED_GATEWAY=PASS\\n')
  } catch (error) {
    console.error('OWNED_PACKAGED_GATEWAY_ERROR=' + (error?.code || error?.message || 'unknown') +
      ';CHILD_DIAGNOSTIC=' + gatewayErrorCode + ';ENDPOINT_SEEN=' + endpointEverSeen)
    process.exitCode = 1
  } finally {
    clearInterval(monitor)
    lifecycle.stop()
  }
} else {
  assert.equal(process.platform, 'win32', 'Windows packaged runtime required')
  assert.ok(existsSync(executable), 'packaged Electron must already be built')
  const home = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-gateway-env-'))
  let personalConnections = 0
  const personalPortTrap = createServer(socket => {
    personalConnections++
    socket.destroy()
  })
  await new Promise((resolve, reject) => {
    personalPortTrap.once('error', reject)
    personalPortTrap.listen(8765, '127.0.0.1', resolve)
  })
  try {
    for (const variant of ['native-home', 'isolated-opencode']) {
      const dir = path.join(home, variant)
      const profile = path.join(dir, 'isolated')
      for (const name of ['appdata', 'localappdata', 'config', 'data', 'cache', 'workspace']) {
        await mkdir(path.join(dir, name), { recursive: true })
      }
      const fixture = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', profile], {
        cwd: path.resolve(here, '..'), shell: false, windowsHide: true,
        encoding: 'utf8', timeout: 15000,
      })
      assert.equal(fixture.status, 0, 'isolated profile fixture failed')
      // Preserve Windows' coherent HOME/USERPROFILE and OS process environment.
      // OpenCode and Electron data still live only under this disposable CI root.
      const env = { ...process.env }
      for (const name of Object.keys(env)) {
        if (/^(CHAT_ON_OPENCODE_|COS_|ELECTRON_)/.test(name)) delete env[name]
      }
      // Force a hostile inherited override: only provider's 8766 may bind.
      env.CLF_BRIDGE_PORTS = '8765'
      Object.assign(env, {
        APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'),
      })
      if (variant === 'isolated-opencode') Object.assign(env, {
        XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'),
        XDG_CACHE_HOME: path.join(dir, 'cache'), OPENCODE_CONFIG_DIR: path.join(dir, 'config'),
        OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      })
      const port = await freePort()
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url),
        '--gateway-worker', profile, String(port)], {
        cwd: path.join(dir, 'workspace'), env, windowsHide: true,
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = '', error = ''
      child.stdout.on('data', data => { output = (output + String(data)).slice(-2000) })
      child.stderr.on('data', data => { error = (error + String(data)).slice(-2000) })
      const result = await Promise.race([
        new Promise(resolve => child.once('close', code => resolve({ code, timeout: false }))),
        delay(115000).then(() => ({ code: null, timeout: true })),
      ])
      if (result.timeout && child.pid) {
        // Only this test's child tree, on a disposable CI runner.
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          windowsHide: true, timeout: 8000,
        })
      }
      assert.equal(result.timeout, false, variant + ' packaged worker timed out')
      assert.equal(result.code, 0, variant + ' packaged gateway failure: ' + error.slice(-500))
      assert.match(output, /OWNED_PACKAGED_GATEWAY=PASS/)
      assert.equal(personalConnections, 0, 'provider or extension contacted personal 8765')
      process.stdout.write('PACKAGED_' + variant.toUpperCase().replace('-', '_') + '=PASS\\n')
    }
  } finally {
    await new Promise(resolve => personalPortTrap.close(resolve))
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}
