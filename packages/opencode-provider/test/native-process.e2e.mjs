import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const serverEntry = fileURLToPath(new URL('../src/server.mjs', import.meta.url))
const fixtureEntry = fileURLToPath(new URL('fixtures/mock-cos.ts', import.meta.url))

const freePort = async () => new Promise((resolve, reject) => {
  const server = createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(() => resolve(port))
  })
})

async function poll(url, key, child, deadline = Date.now() + 25000) {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`gateway_exited_${child.exitCode}`)
    try {
      const reply = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(600) })
      if (reply.ok) return reply.json()
    } catch { /* process still booting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('native_process_gateway_timeout')
}

const stop = async child => {
  if (!child || child.exitCode !== null) return
  let timer
  const closed = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
  clearTimeout(timer)
  if (child.exitCode === null) child.kill('SIGKILL')
}

const exited = pid => {
  try { process.kill(pid, 0); return false } catch { return true }
}

test('real Node gateway launches owned Bun service and streams two correlated native turns offline',
  { timeout: 60000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chat-on-opencode-native-'))
    const profile = path.join(root, 'isolated-provider-userdata')
    const personal = path.join(root, 'untouched-personal')
    await mkdir(profile)
    await mkdir(personal)
    await writeFile(path.join(profile, 'config.json'), JSON.stringify({
      ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
    }))
    const executable = path.join(root, process.platform === 'win32' ? 'offline-cos.exe' : 'offline-cos')
    const compiled = spawnSync('bun', ['build', fixtureEntry, '--compile', '--outfile', executable], {
      cwd: packageDir, encoding: 'utf8', timeout: 35000, windowsHide: true, shell: false,
    })
    assert.equal(compiled.status, 0, (compiled.stderr ?? '').slice(-1500))

    const key = randomBytes(32).toString('hex')
    const port = await freePort()
    const gateway = spawn(process.execPath, [serverEntry], {
      cwd: packageDir, windowsHide: true, shell: false, stdio: 'ignore',
      env: {
        ...process.env,
        CHAT_ON_OPENCODE_GATEWAY_KEY: key,
        CHAT_ON_OPENCODE_RUNTIME_EXE: executable,
        CHAT_ON_OPENCODE_RUNTIME_DATA: profile,
        CHAT_ON_OPENCODE_PERSONAL_COS_DATA: personal,
        CHAT_ON_OPENCODE_PORT: String(port),
      },
    })
    let servicePID
    t.after(async () => {
      await stop(gateway)
      // Windows can terminate the Node gateway without running its signal handlers.
      // The isolated service's gateway-owner watchdog must still terminate Chromium.
      if (servicePID) {
        const end = Date.now() + 6000
        while (Date.now() < end && !exited(servicePID)) await new Promise(r => setTimeout(r, 100))
        assert.ok(exited(servicePID), 'service subprocess orphaned after gateway shutdown')
      }
      // The native fixture receives an independent process ID from the endpoint file.
      // Never send a signal to an unverified PID: the child may already have quit.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 })
    })
    const base = `http://127.0.0.1:${port}`
    assert.equal((await poll(`${base}/health`, key, gateway)).gateway, 'chat-on-opencode')
    const descriptor = JSON.parse(await readFile(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'))
    servicePID = descriptor.pid
    assert.notEqual(descriptor.pid, gateway.pid)
    assert.equal(descriptor.protocol, 1)
    assert.equal((await poll(`${base}/health`, key, gateway)).pid, gateway.pid)
    const send = async messageID => {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'x-opencode-session-id': 'ses_native123',
          'x-opencode-message-id': messageID,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stream: true, model: 'chatgpt-default', messages: [{ role: 'user', content: 'same text' }] }),
        signal: AbortSignal.timeout(12000),
      })
      assert.equal(response.status, 200)
      const answer = await response.text()
      assert.match(answer, /OFFLINE_FORK_OK/)
      assert.match(answer, /data: \[DONE\]/)
    }
    await send('msg_first_native1')
    await send('msg_second_native2')
    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401)
    // Explicitly demonstrate that no fixture or test wrote to a personal CoS profile.
    const { readdir } = await import('node:fs/promises')
    assert.deepEqual(await readdir(personal), [])
  })
