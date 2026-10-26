import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { CoSRuntime } from '../src/runtime.mjs'
import { BridgeError } from '../src/control.mjs'
import { runTurn, stableUUID } from '../src/gateway.mjs'

const executable = process.env.CHAT_ON_OPENCODE_TEST_PACKAGED_EXE
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const native = process.platform === 'win32' && executable &&
  path.isAbsolute(executable) && existsSync(executable)

test('actual packaged Electron refuses an unpaired first OpenCode turn before CoS input admission', {
  skip: native ? false : 'Supply an absolute CI-built Windows provider executable; no personal profile is used',
  timeout: 100_000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-'))
  const profile = path.join(temp, 'isolated')
  const runtime = new CoSRuntime({ executable, profile, startupTimeoutMs: 75000 })
  let launched = false
  // Match the production packaged smoke: Windows may require its original
  // USERPROFILE while Electron's application data stays fully isolated.
  const keys = ['APPDATA', 'LOCALAPPDATA', 'ELECTRON_RUN_AS_NODE']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) {
      if (key === 'ELECTRON_RUN_AS_NODE') { delete process.env[key]; continue }
      const folder = path.join(temp, key.toLowerCase())
      await mkdir(folder)
      process.env[key] = folder
    }
    // Use the real schema/defaults and explicitly disable every local capability.
    // A hand-written minimal config is not equivalent to the packaged app's schema.
    const prepared = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', profile], {
      cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false, timeout: 20000,
    })
    assert.equal(prepared.status, 0, 'cannot prepare real-schema offline provider profile')
    const control = await runtime.start()
    launched = true
    assert.equal(control.endpointPid, runtime.child.pid, 'must own exact packaged control endpoint')
    const readiness = await control.readiness()
    assert.equal(readiness.canAttempt, false, 'fresh offline profile must not claim authenticated inference')
    assert.ok(['absent', 'unknown'].includes(readiness.sessionCookie), 'no account was ever added')
    let admitted = 0
    const send = control.send.bind(control)
    control.send = (...args) => { admitted++; return send(...args) }
    const sessionKey = 'ses_offline_first_use'
    await assert.rejects(runTurn(control, {
      model: 'chatgpt-default', messages: [{ role: 'user', content: 'OFFLINE_NO_LOGIN_PROBE' }],
    }, { sessionKey, messageKey: 'msg_offline_first_use', emit: () => {
      throw new Error('unexpected_chatgpt_output_without_auth')
    } }), error => error instanceof BridgeError &&
      ['chatgpt_sign_in_required', 'chatgpt_session_unobserved', 'cos_companion_unpaired',
        'cos_companion_not_connected'].includes(error.code))
    assert.equal(admitted, 0, 'refused prompt must never call CoS durable input admission')
    assert.equal(await control.hasSession(stableUUID('session:' + sessionKey)), false,
      'a rejected first turn must not create a CoS session or enter its outbox')
  } finally {
    const child = runtime.child
    const ended = child && child.exitCode === null
      ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()
    runtime.stop()
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    if (launched) await Promise.race([ended, sleep(5000, undefined, { ref: false })])
    // Only this test-owned profile is eligible for deletion; never sweep sibling folders.
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rm(temp, { recursive: true, force: true, maxRetries: 1, retryDelay: 150 }); break }
      catch (error) {
        if (attempt === 9) throw error
        await sleep(300)
      }
    }
  }
})
