#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledProvider } from '../src/official-install.mjs'

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const TARGET = 'chat-on-opencode/chatgpt-default'

export function parseOptions(args) {
  const options = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--smoke') {
      if (options.smoke) throw new Error('duplicate_smoke_mode')
      options.smoke = true
    } else if (['--config', '--cli'].includes(args[i])) {
      const key = args[i++].slice(2)
      if (options[key] || !args[i] || args[i].startsWith('--')) throw new Error('invalid_model_check_argument')
      options[key] = args[i]
    } else throw new Error('unknown_model_check_argument')
  }
  if (!options.config || !options.cli) throw new Error('explicit_config_and_cli_required')
  return options
}

/** Does not read any personal auth data; validates only the install manifest and CLI version. */
export function checkOfficialModel(options, { runner = spawnSync } = {}) {
  const { config, manifest } = inspectInstalledProvider(options.config)
  if (!['2.0.29', '2.0.32', '2.1.4'].includes(manifest.version)) {
    throw new Error('provider_installed_cli_version_unqualified')
  }
  if (!path.isAbsolute(options.cli)) throw new Error('official_cli_absolute_path_required')
  const stat = lstatSync(options.cli)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('official_cli_unsafe_file')
  const cli = realpathSync(options.cli)
  const result = runner(cli, ['--version'], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' },
  })
  const version = /^opencode v?(\d+\.\d+\.\d+)\s*$/i.exec(result.stdout?.trim() ?? '')?.[1]
  if (result.status !== 0 || !['2.0.29', '2.0.32', '2.1.4'].includes(version) ||
      version !== manifest.version) throw new Error('official_cli_version_mismatch')
  return { cli, config, version, configSha256: sha(config) }
}

/** An actual official CLI model picker smoke, never an AI request or account login. */
export async function smokeOfficialModel(plan, {
  launcher = spawn, stopper, startupTimeoutMs = 30000, shutdownTimeoutMs = 5000,
} = {}) {
  inspectInstalledProvider(plan.config)
  // The plan's premise is the exact config bytes it inspected. A config that
  // moved since then invalidates the check, whatever the manifest format is.
  if (!plan.configSha256 || sha(plan.config) !== plan.configSha256) {
    throw new Error('official_model_config_changed_since_plan')
  }
  const before = sha(plan.config)
  const key = randomBytes(32).toString('hex')
  const env = {
    ...process.env, CHAT_ON_OPENCODE_GATEWAY_KEY: key,
    OPENCODE_CONFIG_DIR: path.dirname(plan.config),
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  }
  const child = launcher(plan.cli, ['models', '--standalone'], {
    cwd: os.tmpdir(), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let pendingLine = ''
  let found = false
  let stderrSeen = false
  let stopped = false
  let closed = false
  let exited = false
  let stoppedAfterMatch = false
  let timedOut = false
  let stopGrace
  let rejectPending
  const armShutdown = () => {
    if (closed || stopGrace) return
    stopGrace = setTimeout(() => rejectPending?.(new Error('official_model_child_did_not_exit')),
      shutdownTimeoutMs)
  }
  const stop = (matched = false) => {
    // Never signal a PID after the child has exited; Windows can reuse PIDs.
    if (stopped || closed || exited) { armShutdown(); return }
    stopped = true
    stoppedAfterMatch = matched
    if (stopper) stopper(child)
    else if (process.platform === 'win32' && child.pid) {
      const killed = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
        { shell: false, windowsHide: true, timeout: 5000 })
      if (killed.status !== 0) throw new Error('official_model_child_termination_failed')
    } else if (!child.killed) child.kill('SIGTERM')
    // Start the bound on shutdown immediately, not another 30s after a match.
    armShutdown()
  }
  const timer = setTimeout(() => {
    timedOut = true
    try { stop() } catch (error) { rejectPending?.(error) }
  }, startupTimeoutMs)
  try {
    const result = await new Promise((resolve, reject) => {
      rejectPending = reject
      child.stdout?.on('data', chunk => {
        // Inspect every complete line *before* clipping memory. On real CLI
        // profiles the model list can be many thousands of bytes in one chunk.
        const lines = (pendingLine + chunk.toString('utf8')).split(/\r?\n/)
        pendingLine = (lines.pop() ?? '').slice(-256)
        if (lines.some(line => line.trim() === TARGET) && !timedOut) {
          found = true
          try { stop(true) } catch (error) { reject(error) }
        }
      })
      child.stderr?.on('data', chunk => { if (String(chunk).trim()) stderrSeen = true })
      child.once('exit', () => { exited = true })
      child.once('error', error => { closed = true; reject(error) })
      child.once('close', (code, signal) => {
        closed = true
        if (pendingLine.trim() === TARGET && !timedOut) found = true
        resolve({ code, signal })
      })
    })
    const unchanged = before === sha(plan.config)
    return { officialCliVersion: plan.version, modelPresent: found,
      configUnchanged: unchanged, hadStderr: stderrSeen,
      processExit: result.code, processSignal: result.signal,
      terminatedAfterMatch: stoppedAfterMatch, timedOut }
  } finally { try { stop() } finally { clearTimeout(timer); clearTimeout(stopGrace) } }
}

export const smokePassed = result => result.modelPresent && result.configUnchanged &&
  !result.timedOut && (result.processExit === 0 || result.terminatedAfterMatch)

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2))
    const plan = checkOfficialModel(options)
    if (!options.smoke) {
      process.stdout.write(JSON.stringify({ installed: true, cliVersion: plan.version, modelNotYetProbed: true }) + '\n')
      return
    }
    const result = await smokeOfficialModel(plan)
    process.stdout.write(JSON.stringify(result) + '\n')
    if (!smokePassed(result)) process.exitCode = 2
  } catch (error) {
    process.stderr.write('provider_model_check_refused: ' +
      String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
    process.exitCode = 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
