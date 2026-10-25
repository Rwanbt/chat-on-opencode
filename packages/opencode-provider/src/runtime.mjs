import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoSControl, BridgeError } from './control.mjs'

const SERVICE_SWITCH = '--chat-on-opencode-provider-service'

/** Only start an explicitly configured fork binary in an existing, separate profile. */
export async function validateRuntime({ executable, profile, personalProfile }) {
  if (!executable || !profile || !path.isAbsolute(executable) || !path.isAbsolute(profile)) {
    throw new BridgeError('isolated_runtime_not_configured', 503)
  }
  const [binary, folder] = await Promise.all([realpath(executable), realpath(profile)])
    .catch(() => { throw new BridgeError('runtime_path_not_found', 503) })
  if (!(await stat(binary)).isFile() || !(await stat(folder)).isDirectory()) {
    throw new BridgeError('runtime_path_invalid', 503)
  }
  if (personalProfile) {
    const personal = await realpath(personalProfile).catch(() => { throw new BridgeError('personal_profile_unknown', 503) })
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value
    const a = normalize(folder)
    const b = normalize(personal)
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
      throw new BridgeError('runtime_profile_overlaps_personal', 403)
    }
  }
  return { binary, folder }
}

export class CoSRuntime {
  constructor(options, { launcher = spawn, clock = delay } = {}) {
    this.options = options
    this.launcher = launcher
    this.clock = clock
    this.child = null
  }

  async start() {
    if (this.child) throw new BridgeError('runtime_already_started', 409)
    const { binary, folder } = await validateRuntime(this.options)
    const child = this.launcher(binary, [SERVICE_SWITCH], {
      cwd: path.dirname(binary),
      shell: false, windowsHide: true, stdio: 'ignore', detached: false,
      env: { ...process.env, CHAT_ON_OPENCODE_USERDATA_DIR: folder },
    })
    this.child = child
    const control = new CoSControl({ directory: path.join(folder, 'control-api') })
    const signal = new AbortController()
    child.once('exit', () => signal.abort())
    child.once('error', () => signal.abort())
    const timeoutMs = Math.min(Math.max(Number(this.options.startupTimeoutMs ?? 60000), 1000), 120000)
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        if (signal.signal.aborted || child.exitCode !== null) throw new BridgeError('runtime_process_exited', 503)
        try {
          await control.connect()
          if (control.endpointPid !== child.pid) throw new BridgeError('runtime_endpoint_pid_mismatch', 503)
          return control
        } catch (error) {
          // Invalid identity may indicate an unrelated stale endpoint: never adopt it.
          if (error instanceof BridgeError && error.code === 'runtime_endpoint_pid_mismatch') throw error
        }
        if (Date.now() >= deadline) throw new BridgeError('runtime_start_timeout', 503)
        await this.clock(250, undefined, { signal: signal.signal }).catch(() => {
          throw new BridgeError('runtime_process_exited', 503)
        })
      }
    } catch (error) {
      this.stop()
      throw error
    }
  }

  stop() {
    if (!this.child) return
    const child = this.child
    this.child = null
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  }
}
