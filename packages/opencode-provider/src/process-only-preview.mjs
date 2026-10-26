import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createOpenCodeConfig } from './config.mjs'
import { inspectPublishedCandidate } from './official-upgrade.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const TARGET = 'chat-on-opencode/chatgpt-default'
const dirs = ['config', 'home', 'data', 'cache', 'appdata', 'localappdata', 'tmp', 'workspace', 'runtime-data']
const invariant = (condition, error) => { if (!condition) throw new Error('preview_' + error) }
const inside = (base, name) => {
  const relative = path.relative(base, name)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function safePath(location, kind) {
  invariant(typeof location === 'string' && path.isAbsolute(location), 'absolute_path_required')
  const resolved = path.resolve(location)
  let cursor = path.parse(resolved).root
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const info = lstatSync(cursor)
    invariant(!info.isSymbolicLink(), 'symlink_or_junction_refused')
  }
  const stat = lstatSync(resolved)
  invariant(kind === 'dir' ? stat.isDirectory() : stat.isFile(), 'incorrect_path_kind')
  return realpathSync(resolved)
}
function safeRoot(location) {
  const root = safePath(location, 'dir')
  const tmp = safePath(os.tmpdir(), 'dir')
  invariant(inside(tmp, root) && path.basename(root).startsWith('coo-process-preview-'), 'root_must_be_disposable')
  for (const name of dirs) safePath(path.join(root, name), 'dir')
  return root
}

/** A process-only model-preview plan; never reads the user's default profile/auth. */
export function createProcessOnlyPreview(options, { runner = spawnSync } = {}) {
  const root = safeRoot(options.root)
  const config = safePath(path.join(root, 'config', 'opencode.jsonc'), 'file')
  const cli = safePath(options.officialCli, 'file')
  const runtime = safePath(path.join(root, 'runtime.exe'), 'file')
  const node = safePath(options.nodeExecutable ?? process.execPath, 'file')
  const runtimeData = path.join(root, 'runtime-data')
  const published = inspectPublishedCandidate(config, options.publishedSha256)
  invariant(published.candidateAvailable && !published.promotionAllowed, 'candidate_invalid')
  const pluginDir = path.join(root, 'config', '.chat-on-opencode-version-' + options.publishedSha256)
  const generated = createOpenCodeConfig({ runtimeExecutable: runtime, runtimeData,
    nodeExecutable: node, pluginDir, nativeTools: 'off' })
  invariant(Object.keys(generated).sort().join() === 'plugins,providers', 'extra_configuration_fields')
  invariant(generated.plugins.length === 1 && Object.keys(generated.providers).join() === 'chat-on-opencode',
    'unexpected_provider')
  const content = JSON.stringify(generated)
  invariant(Buffer.byteLength(content) < 32_768 && !/"(?:apiKey|access_token|refresh_token|authorization|cookie|secret|password)"\s*:/i.test(content),
    'config_contains_credential')
  // Absolute minimal environment. Never inherit auth, gateway keys, model tokens or profiles.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)))
  Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    OPENCODE_CONFIG_DIR: path.join(root, 'config'), OPENCODE_CONFIG_CONTENT: content,
    OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', BUN_INSTALL_CACHE_DIR: path.join(root, 'cache'),
    npm_config_cache: path.join(root, 'cache') })
  const version = runner(cli, ['--version'], { shell: false, windowsHide: true, encoding: 'utf8',
    timeout: 5000, maxBuffer: 4096, env })
  invariant(version?.status === 0 && /^opencode v?2\.1\.4\s*$/i.test(version.stdout?.trim() ?? ''),
    'official_cli_214_required')
  return { cli, cwd: path.join(root, 'workspace'), env, config, root,
    configSha256: sha(readFileSync(config)), publishedSha256: options.publishedSha256,
    args: ['models', '--standalone'] }
}

/** No inference; only the exact official CLI model name is observable in the result. */
export async function smokeProcessOnlyPreview(options, dependencies = {}) {
  const plan = createProcessOnlyPreview(options, dependencies)
  const check = () => {
    invariant(sha(readFileSync(plan.config)) === plan.configSha256, 'config_drift')
    inspectPublishedCandidate(plan.config, plan.publishedSha256)
  }
  check()
  const child = (dependencies.launcher ?? spawn)(plan.cli, plan.args, {
    cwd: plan.cwd, env: plan.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', stderrLength = 0, found = false, stopped = false, ended = false
  const stop = () => {
    if (stopped || ended || child.exitCode !== null && child.exitCode !== undefined) return
    stopped = true
    if (dependencies.stopper) dependencies.stopper(child)
    else if (process.platform === 'win32' && child.pid) {
      const killed = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
        { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 2048 })
      // Windows may return 1 if the exact child exited before taskkill ran;
      // only a bounded 'close' confirms that it is really gone.
      if (killed.status !== 0 && child.exitCode === null) child.kill('SIGTERM')
    } else child.kill('SIGTERM')
  }
  let expired = false
  let code
  try {
    code = await new Promise((resolve, reject) => {
      let shutdownTimer
      const armShutdown = () => { if (!shutdownTimer) shutdownTimer = setTimeout(() => {
        reject(new Error('preview_child_did_not_exit'))
      }, 5000) }
      const requestStop = () => { try { stop(); armShutdown() } catch (e) { reject(e) } }
      const timer = setTimeout(() => { expired = true; requestStop() },
        Math.min(45_000, dependencies.timeoutMs ?? 30_000))
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8')
        if (output.length > 131072) { requestStop(); reject(new Error('preview_output_unbounded')); return }
        if (output.split(/\r?\n/).some(line => line.trim() === TARGET)) {
          found = true
          requestStop()
        }
      })
      child.stderr.on('data', chunk => { stderrLength += chunk.length; if (stderrLength > 131072) {
        requestStop(); reject(new Error('preview_stderr_unbounded'))
      } })
      child.once('error', reject)
      child.once('close', status => { ended = true; clearTimeout(timer); clearTimeout(shutdownTimer); resolve(status) })
    })
  } finally { stop() }
  check()
  invariant(found && !expired && (code === 0 || stopped), 'model_not_confirmed')
  return { modelPresent: true, cliVersion: '2.1.4', configUnchanged: true,
    processOnly: true, promotionAllowed: false }
}
