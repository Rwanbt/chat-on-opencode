import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const parentEntry = fileURLToPath(new URL('fixtures/gateway-parent.mjs', import.meta.url))
const fixtureEntry = fileURLToPath(new URL('fixtures/mock-cos.ts', import.meta.url))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function freePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

test('OS-killed OpenCode parent closes gateway IPC and removes owned runtime process', {
  timeout: 70000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-parent-death-'))
  const profile = path.join(root, 'isolated')
  const personal = path.join(root, 'untouched-personal')
  await mkdir(profile)
  await mkdir(personal)
  await writeFile(path.join(profile, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
  }))
  const executable = path.join(root, process.platform === 'win32' ? 'fixture-cos.exe' : 'fixture-cos')
  const compiled = spawnSync('bun', ['build', fixtureEntry, '--compile', '--outfile', executable], {
    cwd: packageDir, encoding: 'utf8', timeout: 35000, windowsHide: true, shell: false,
  })
  assert.equal(compiled.status, 0, (compiled.stderr ?? '').slice(-1000))
  const port = await freePort()
  const token = randomBytes(32).toString('hex')
  const parent = spawn(process.execPath, [parentEntry], {
    cwd: packageDir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHAT_ON_OPENCODE_RUNTIME_EXE: executable, CHAT_ON_OPENCODE_RUNTIME_DATA: profile,
      CHAT_ON_OPENCODE_PERSONAL_COS_DATA: personal, CHAT_ON_OPENCODE_GATEWAY_KEY: token,
      CHAT_ON_OPENCODE_PORT: String(port) },
  })
  let owned
  try {
    owned = await new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => reject(new Error('offline_gateway_start_timeout: ' + stderr.slice(-200))), 25000)
      const fail = error => { clearTimeout(timeout); reject(error) }
      parent.once('error', fail)
      parent.once('exit', code => fail(new Error('offline_parent_exited_' + code + ': ' + stderr.slice(-200))))
      parent.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500) })
      parent.stdout.on('data', chunk => {
        stdout += chunk
        const index = stdout.indexOf('\n')
        if (index < 0) return
        clearTimeout(timeout)
        try { resolve(JSON.parse(stdout.slice(0, index))) } catch (error) { reject(error) }
      })
    })
    assert.ok(Number.isSafeInteger(owned.gatewayPID) && owned.gatewayPID > 1)
    assert.ok(Number.isSafeInteger(owned.servicePID) && owned.servicePID > 1)
    assert.notEqual(parent.pid, owned.gatewayPID)
    assert.notEqual(owned.servicePID, owned.gatewayPID)
    assert.ok(alive(owned.gatewayPID) && alive(owned.servicePID))
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1500),
    })
    assert.equal(health.status, 200)
    const parentClosed = new Promise(resolve => parent.once('close', resolve))
    assert.equal(parent.kill('SIGKILL'), true)
    await parentClosed
    const deadline = Date.now() + 9000
    while (Date.now() < deadline && (alive(owned.gatewayPID) || alive(owned.servicePID))) await wait(100)
    assert.ok(!alive(owned.gatewayPID), 'gateway orphaned after OS-killed OpenCode parent')
    assert.ok(!alive(owned.servicePID), 'CoS child orphaned after OS-killed OpenCode parent')
    assert.deepEqual(await readdir(personal), [])
  } finally {
    if (parent.exitCode === null) parent.kill('SIGKILL')
    // Only kill PIDs observed from this sacrificial test host, never a real profile.
    if (owned?.gatewayPID && alive(owned.gatewayPID)) process.kill(owned.gatewayPID, 'SIGKILL')
    if (owned?.servicePID && alive(owned.servicePID)) process.kill(owned.servicePID, 'SIGKILL')
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
