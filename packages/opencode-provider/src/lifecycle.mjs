import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Owned gateway process: never ask OpenCode to find/attach to an unrelated CoS instance. */
export class GatewayLifecycle {
  constructor({ entry, runtimeExecutable, runtimeData, key, port = 45861, node },
    { launcher = spawn, fetcher = fetch, clock = delay } = {}) {
    this.options = { entry, runtimeExecutable, runtimeData, key, port, node }
    this.launcher = launcher
    this.fetcher = fetcher
    this.clock = clock
    this.child = null
    this.opening = null
  }

  async ensure() {
    if (this.opening) return this.opening
    this.opening = this.open()
    try { return await this.opening }
    catch (error) { this.stop(); throw error }
    finally { this.opening = null }
  }

  async open() {
    const { entry, runtimeExecutable, runtimeData, key, port, node } = this.options
    // OpenCode 2 is often a packaged Bun executable. process.execPath would relaunch OpenCode,
    // NOT run this Node server. Require a known absolute Node executable instead.
    if (!entry || !runtimeExecutable || !runtimeData || !node || !path.isAbsolute(node) ||
      typeof key !== 'string' || key.length < 32 ||
      !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('provider_runtime_not_configured')
    if (this.child && this.child.exitCode === null && !this.child.killed) return
    this.child = null
    // An OS kill of OpenCode skips JS cleanup hooks. The IPC channel is the
    // ownership lease: closing it forces the gateway to stop its CoS child.
    const child = this.launcher(node, [entry, '--owned-ipc'], {
      shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        CHAT_ON_OPENCODE_RUNTIME_EXE: runtimeExecutable,
        CHAT_ON_OPENCODE_RUNTIME_DATA: runtimeData,
        CHAT_ON_OPENCODE_GATEWAY_KEY: key,
        CHAT_ON_OPENCODE_PORT: String(port),
      },
    })
    this.child = child
    const signal = new AbortController()
    child.once('exit', () => signal.abort())
    child.once('error', () => signal.abort())
    const url = `http://127.0.0.1:${port}/health`
    const start = Date.now()
    while (Date.now() - start < 90000) {
      if (signal.signal.aborted || child.exitCode !== null) throw new Error('provider_runtime_exited')
      try {
        const response = await this.fetcher(url, {
          headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
          signal: AbortSignal.timeout(1000),
        })
        if (response.ok) {
          const health = await response.json()
          // A prior crashed gateway may still own this fixed local port. Its health and
          // bearer key are insufficient proof; only the child WE spawned may be adopted.
          if (health.gateway === 'chat-on-opencode' && health.pid !== child.pid) {
            throw new Error('provider_gateway_owner_mismatch')
          }
          if (health.gateway === 'chat-on-opencode' && health.pid === child.pid) return
        }
      } catch (error) {
        if (error?.message === 'provider_gateway_owner_mismatch') throw error
        // The local listener may not yet have started.
      }
      await this.clock(250, undefined, { signal: signal.signal }).catch(() => { throw new Error('provider_runtime_exited') })
    }
    throw new Error('provider_runtime_start_timeout')
  }

  stop() {
    this.opening = null
    const child = this.child
    this.child = null
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
}
