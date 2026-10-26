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
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GatewayLifecycle } from '../packages/opencode-provider/src/lifecycle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../release/provider/win-unpacked')
const executable = path.join(root, 'Chat On OpenCode Provider.exe')
const entry = path.resolve(here, '../packages/opencode-provider/src/server.mjs')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  })
  try {
    await lifecycle.ensure()
    const response = await fetch('http://127.0.0.1:' + port + '/health', {
      headers: { Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 200)
    const health = await response.json()
    assert.equal(health.gateway, 'chat-on-opencode')
    assert.equal(health.provider?.canAttempt, false, 'unpaired test profile may not accept prompts')
    process.stdout.write('OWNED_PACKAGED_GATEWAY=PASS\\n')
  } catch (error) {
    console.error('OWNED_PACKAGED_GATEWAY_ERROR=' + (error?.code || error?.message || 'unknown'))
    process.exitCode = 1
  } finally {
    lifecycle.stop()
  }
} else {
  assert.equal(process.platform, 'win32', 'Windows packaged runtime required')
  assert.ok(existsSync(executable), 'packaged Electron must already be built')
  const home = await mkdtemp(path.join(os.tmpdir(), 'coo-packaged-gateway-env-'))
  try {
    for (const variant of ['full', 'standalone-cli']) {
      const dir = path.join(home, variant)
      const profile = path.join(dir, 'isolated')
      for (const name of ['home', 'appdata', 'localappdata', 'config', 'data', 'cache', 'workspace']) {
        await mkdir(path.join(dir, name), { recursive: true })
      }
      const fixture = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', profile], {
        cwd: path.resolve(here, '..'), shell: false, windowsHide: true,
        encoding: 'utf8', timeout: 15000,
      })
      assert.equal(fixture.status, 0, 'isolated profile fixture failed')
      // The CLI runner deliberately replaces HOME/APPDATA and removes unrelated
      // process variables. Both cases must start the SAME real packaged helper.
      const env = variant === 'full' ? { ...process.env } : {}
      if (variant !== 'full') {
        for (const [name, value] of Object.entries(process.env)) {
          if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)) env[name] = value
        }
      }
      for (const name of Object.keys(env)) {
        if (/^(CHAT_ON_OPENCODE_|COS_|ELECTRON_)/.test(name)) delete env[name]
      }
      Object.assign(env, {
        HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'),
        APPDATA: path.join(dir, 'appdata'), LOCALAPPDATA: path.join(dir, 'localappdata'),
        XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'),
        XDG_CACHE_HOME: path.join(dir, 'cache'),
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
      process.stdout.write('PACKAGED_' + variant.toUpperCase().replace('-', '_') + '=PASS\\n')
    }
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
}
