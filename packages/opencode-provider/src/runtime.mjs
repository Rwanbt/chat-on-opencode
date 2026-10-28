import { spawn } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoSControl, BridgeError } from './control.mjs'

const SERVICE_SWITCH = '--chat-on-opencode-provider-service'

/** The helper must not boot Chromium with CoS's implicit first-launch defaults. */
export async function validateProfileConsent(folder) {
  const file = path.join(folder, 'config.json')
  let info
  try { info = await lstat(file) }
  catch { throw new BridgeError('isolated_profile_not_initialized', 503) }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_097_152) {
    throw new BridgeError('isolated_profile_config_unsafe', 403)
  }
  let config
  try { config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
  catch { throw new BridgeError('isolated_profile_config_unreadable', 503) }
  if (!config || config.ui?.chatBrowser !== 'cos' || config.controlApi?.enabled !== true ||
      config.controlApi?.allowActions !== true) {
    throw new BridgeError('isolated_profile_has_no_provider_consent', 403)
  }
}

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
  await validateProfileConsent(folder)
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
    traceStage('runtime_start')
    if (this.child) throw new BridgeError('runtime_already_started', 409)
    const { binary, folder } = await validateRuntime(this.options)
    // A live provider control endpoint is already owned. Refuse before spawning
    // a second Electron runtime; never connect to, overwrite or terminate it.
    // PID reuse can yield a conservative refusal, never unsafe adoption.
    try {
      const info = JSON.parse(await readFile(path.join(folder, 'control-api', 'endpoint.json'), 'utf8'))
      if (Number.isSafeInteger(info?.pid) && info.pid > 0) {
        let live = false
        try { process.kill(info.pid, 0); live = true }
        catch (error) { if (error?.code === 'EPERM') live = true }
        if (live) throw new BridgeError('runtime_profile_endpoint_occupied', 409)
      }
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'runtime_profile_endpoint_occupied') throw error
      // Missing or malformed prior endpoint is not proof of ownership. The
      // exact child-PID check after spawn remains mandatory and fail-closed.
    }
    // The official OpenCode CLI may be an Electron/Bun host. Its process-only
    // runtime switches must not turn our packaged Electron helper into Node.
    const { CHAT_ON_OPENCODE_GATEWAY_KEY: _gatewaySecret,
      ELECTRON_RUN_AS_NODE: _electronNode, ELECTRON_NO_ASAR: _noAsar,
      NODE_OPTIONS: _nodeOptions, ...childEnvironment } = process.env
    const child = this.launcher(binary, [SERVICE_SWITCH], {
      cwd: path.dirname(binary),
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], detached: false,
      // No gateway bearer token or long-running helper without its gateway owner.
      env: { ...childEnvironment, CHAT_ON_OPENCODE_USERDATA_DIR: folder,
        CHAT_ON_OPENCODE_OWNER_PID: String(process.pid) },
    })
    this.child = child
    traceStage('runtime_child_spawned')
    const control = new CoSControl({ directory: path.join(folder, 'control-api') })
    // A previously packaged Electron can refuse its isolated profile before
    // creating the control endpoint. Consume its stderr but retain only this
    // fixed category: arbitrary native output may contain private data.
    const profileRefusal = 'Provider service refused: invalid isolated profile'
    let stderrSuffix = ''
    let profileRefused = false
    child.stderr?.on('data', chunk => {
      if (profileRefused) return
      stderrSuffix = (stderrSuffix + String(chunk)).slice(-256)
      if (stderrSuffix.includes(profileRefusal)) {
        profileRefused = true
        traceStage('runtime_profile_refused')
      }
    })
    const exited = () => new BridgeError(profileRefused ? 'runtime_profile_refused' : 'runtime_process_exited', 503)
    const signal = new AbortController()
    child.once('exit', () => signal.abort())
    child.once('error', () => signal.abort())
    child.once('exit', () => traceStage('runtime_child_exited'))
    child.once('error', () => traceStage('runtime_child_error'))
    const timeoutMs = Math.min(Math.max(Number(this.options.startupTimeoutMs ?? 60000), 1000), 120000)
    const deadline = Date.now() + timeoutMs
    let lastFailure = ''
    try {
      for (;;) {
        if (signal.signal.aborted || child.exitCode !== null) throw exited()
        try {
          await control.connect({ expectedPid: child.pid })
          if (control.endpointPid !== child.pid) throw new BridgeError('runtime_endpoint_pid_mismatch', 503)
          traceStage('control_connected')
          return control
        } catch (error) {
          const category = error instanceof BridgeError && error.code === 'cos_runtime_unavailable'
            ? 'control_endpoint_unavailable'
            : error instanceof BridgeError && error.code === 'cos_transport_unavailable'
              ? 'control_transport_unavailable'
              : error instanceof BridgeError && error.code === 'runtime_endpoint_pid_mismatch'
                ? 'control_pid_mismatch'
                : error instanceof BridgeError && error.code === 'cos_provider_runtime_incompatible'
                  ? 'control_protocol_mismatch' : 'control_other_unavailable'
          if (category !== lastFailure) { traceStage(category); lastFailure = category }
          // Invalid identity may indicate an unrelated stale endpoint: never adopt it.
          if (error instanceof BridgeError &&
              ['runtime_endpoint_pid_mismatch', 'cos_provider_runtime_incompatible'].includes(error.code)) throw error
        }
        if (Date.now() >= deadline) {
          traceStage('runtime_start_timeout')
          throw new BridgeError('runtime_start_timeout', 503)
        }
        await this.clock(250, undefined, { signal: signal.signal }).catch(() => {
          throw exited()
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
import { traceStage } from './stage-trace.mjs'
