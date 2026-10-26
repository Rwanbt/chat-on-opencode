import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { cp, copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createOpenCodeConfig } from './config.mjs'
import { classifyGatewayPlugin, extractOwnedEntry } from './official-doctor.mjs'
import { inspectInstalledProvider, payloadDigest, validateBundle } from './official-install.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const sha = source => createHash('sha256').update(source).digest('hex')
const MODEL = 'chat-on-opencode/chatgpt-default'
const VERSION = '2.1.4'
const file = filename => path.isAbsolute(filename) && existsSync(filename) &&
  lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink()
const systemEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key) &&
  typeof value === 'string'))

/** Managed config overrides process-local config; never silently load it. */
export function hasMachineConfig({ platform = process.platform, env = process.env,
  unixSystemDir } = {}) {
  const location = platform === 'win32'
    ? path.join(env.ProgramData ?? env.PROGRAMDATA ?? 'C:\\ProgramData', 'opencode')
    : platform === 'darwin' ? (unixSystemDir ?? '/Library/Application Support/opencode')
      : (unixSystemDir ?? '/etc/opencode')
  return ['opencode.json', 'opencode.jsonc', 'plugins'].some(name =>
    existsSync(path.join(location, name)))
}

/** Does not copy personal config, tokens, plugins or account state into the child. */
export function planOfficialPreview({ configFile, bundleDir, officialCli }, { runner = spawnSync } = {}) {
  if (hasMachineConfig()) throw Error('preview_managed_system_config_unisolatable')
  const { config, managed } = inspectInstalledProvider(configFile)
  const current = readFileSync(config)
  const options = extractOwnedEntry(current.toString('utf8'), managed)
  const source = validateBundle(bundleDir)
  if (classifyGatewayPlugin(readFileSync(path.join(source, 'plugin', 'index.ts'), 'utf8')) !== 'ephemeral') {
    throw Error('preview_candidate_ephemeral_key_required')
  }
  if (!file(officialCli)) throw Error('preview_official_cli_required')
  const cli = path.resolve(officialCli)
  const probe = runner(cli, ['--version'], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, cwd: os.tmpdir(),
    env: { ...systemEnvironment(), OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1' },
  })
  if (probe.status !== 0 || probe.stdout?.trim() !== 'opencode v' + VERSION) {
    throw Error('preview_official_cli_unqualified')
  }
  if (!options || !['off', 'read'].includes(options.nativeTools ?? 'off')) {
    throw Error('preview_plugin_options_invalid')
  }
  // The installed profile's *separate* runtime is referenced only. 'models'
  // never starts it, invokes prompts or reads the companion's account state.
  const generated = createOpenCodeConfig({
    runtimeExecutable: options.runtimeExecutable, runtimeData: options.runtimeData,
    nodeExecutable: options.nodeExecutable, pluginDir: source,
    nativeTools: options.nativeTools ?? 'off', port: Number(options.port),
  })
  return {
    cli, generated, config, managed, configDigest: sha(current),
    managedDigest: payloadDigest(managed), bundleDigest: candidateDigest(source),
    source, version: VERSION,
  }
}

function minimalEnvironment(root, generated) {
  const env = systemEnvironment()
  Object.assign(env, {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(generated), OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  })
  return env
}

/** Official CLI model discovery in a disposable home, never a live prompt. */
export async function previewOfficialModel(plan, {
  launcher = spawn, timeoutMs = 25000, terminator = null,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 45000) {
    throw Error('preview_timeout_invalid')
  }
  if (sha(readFileSync(plan.config)) !== plan.configDigest ||
      payloadDigest(plan.managed) !== plan.managedDigest ||
      candidateDigest(plan.source) !== plan.bundleDigest) throw Error('preview_source_changed')
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-preview-'))
  let child
  let childClosed = false
  let terminate = () => {}
  try {
    for (const name of ['home','appdata','localappdata','config','data','cache','workspace','tmp','bundle']) {
      await mkdir(path.join(root, name))
    }
    const staged = path.join(root, 'bundle')
    for (const folder of ['bin', 'plugin', 'src']) {
      await cp(path.join(plan.source, folder), path.join(staged, folder), { recursive: true })
    }
    for (const filename of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      const sourceFile = path.join(plan.source, filename)
      if (existsSync(sourceFile)) await copyFile(sourceFile, path.join(staged, filename))
    }
    if (payloadDigest(staged) !== plan.bundleDigest ||
        candidateDigest(plan.source) !== plan.bundleDigest) throw Error('preview_candidate_copy_drift')
    validateBundle(staged)
    // The CLI sees only the self-contained immutable candidate copy, not a
    // mutable development worktree or the currently managed plugin folder.
    const configuration = structuredClone(plan.generated)
    configuration.plugins[0].package = path.join(staged, 'plugin')
    // The standalone model command may initialize a config directory before
    // applying its in-memory overlay. Both contain ONLY the generated provider
    // settings; never copy the user's personal configuration file.
    await writeFile(path.join(root, 'config', 'opencode.jsonc'), JSON.stringify(configuration),
      { flag: 'wx', mode: 0o600 })
    // V2 CLI 2.1.4 does not accept an extra provider selector here.
    child = launcher(plan.cli, ['models', '--standalone'], {
      cwd: path.join(root, 'workspace'), env: minimalEnvironment(root, configuration),
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let total = 0, stdoutBytes = 0, stderrBytes = 0
    let line = '', outputTail = '', found = false, killIssued = false
    terminate = () => {
      if (killIssued || childClosed || !child?.pid) return
      killIssued = true
      if (terminator) terminator(child)
      else if (process.platform === 'win32') spawnSync('taskkill',
        ['/F', '/T', '/PID', String(child.pid)], {
          windowsHide: true, shell: false, timeout: 5000, stdio: 'ignore',
        })
      else child.kill('SIGTERM')
    }
    const outcome = await new Promise((resolve, reject) => {
      let timedOutError
      const timer = setTimeout(() => {
        timedOutError = Error(stdoutBytes ? 'preview_cli_timeout_model_unlisted' :
          stderrBytes ? 'preview_cli_timeout_with_stderr' : 'preview_cli_timeout_no_output')
        terminate()
        // A process termination request is not a proof of process exit.
        // Bound the wait; the outer cleanup gate refuses to delete a live tree.
        setTimeout(() => { if (!childClosed) reject(timedOutError) }, 2500)
      }, timeoutMs)
      const finish = (error, code) => {
        clearTimeout(timer)
        if (!error) childClosed = true
        if (error || timedOutError) reject(error ?? timedOutError)
        else resolve(code)
      }
      child.stdout?.on('data', chunk => {
        total += chunk.byteLength
        stdoutBytes += chunk.byteLength
        if (total > 262144) { terminate(); finish(Error('preview_cli_output_excess')); return }
        const raw = chunk.toString('utf8')
        // The official CLI can decorate a model row, and transports can split
        // its exact ID between writes. Accept the literal registered ID
        // anywhere in its bounded output, as the existing real CLI E2E does.
        outputTail = (outputTail + raw).slice(-1024)
        const lines = (line + raw).split(/\r?\n/)
        line = (lines.pop() ?? '').slice(-256)
        // OpenCode can hold its last model entry without a terminal newline
        // while its standalone process stays alive. Admit the exact pending
        // token as soon as it arrives; waiting for EOF would deadlock.
        if (outputTail.includes(MODEL) ||
            lines.some(value => value.trim() === MODEL) || line.trim() === MODEL) {
          found = true
          terminate()
        }
      })
      child.stderr?.on('data', chunk => {
        total += chunk.byteLength
        stderrBytes += chunk.byteLength
        if (total > 262144) { terminate(); finish(Error('preview_cli_output_excess')) }
      })
      child.once('error', () => finish(Error('preview_cli_failed')))
      child.once('close', code => finish(null, code))
    })
    if (!found && line.trim() === MODEL) found = true
    const unchanged = sha(readFileSync(plan.config)) === plan.configDigest &&
      payloadDigest(plan.managed) === plan.managedDigest
    return { modelPresent: found, originalUnchanged: unchanged,
      officialCliVersion: plan.version, isolatedHome: true, inferenceAuthenticated: false,
      activeInstallationUpgraded: false, status: found && unchanged ? 'PREVIEW_MODEL_AVAILABLE' : 'NO_GO_PREVIEW',
      exitCode: outcome === 0 ? 0 : null }
  } finally {
    // Only own disposable files are deleted. Never operate on the official
    // config, managed bundle, Desktop process or user account.
    if (child && !childClosed) {
      terminate()
      // The Windows process tree may still exit after taskkill returns.
      // Never delete a profile that our child may still be reading.
      await Promise.race([
        new Promise(resolve => child.once('close', () => { childClosed = true; resolve() })),
        new Promise(resolve => setTimeout(resolve, 2500)),
      ])
    }
    if (!child || childClosed) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } else {
      // Keep only disposable, synthetic settings; do not assert cleanup.
      throw Error('preview_child_termination_unconfirmed')
    }
  }
}
