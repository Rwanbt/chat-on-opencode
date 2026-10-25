// Explicit opt-in smoke for an ALREADY INSTALLED isolated, real OpenCode CLI
// profile. No ChatGPT sign-in, prompts, Desktop, registry or personal profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = process.env.CHAT_ON_OPENCODE_TEST_INSTALLED_ROOT
const cli = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
assert.ok(root && path.isAbsolute(root) && cli && path.isAbsolute(cli),
  'explicit_synthetic_install_root_and_official_cli_required')
const config = path.join(root, 'opencode', 'opencode.jsonc')
assert.ok(existsSync(config) && existsSync(cli))
const sha = b => createHash('sha256').update(b).digest('hex')
const prior = sha(readFileSync(config))
const env = {}
for (const [name, value] of Object.entries(process.env)) {
  if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name))
    env[name] = value
}
for (const [name, dirname] of Object.entries({
  HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
  XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache',
  XDG_STATE_HOME: 'state',
})) {
  env[name] = path.join(root, dirname)
  mkdirSync(env[name], { recursive: true })
}
Object.assign(env, {
  OPENCODE_CONFIG_DIR: path.join(root, 'opencode'),
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  CHAT_ON_OPENCODE_GATEWAY_KEY: randomBytes(32).toString('hex'),
})
const workspace = path.join(root, 'workspace')
mkdirSync(workspace, { recursive: true })
const result = await new Promise(resolve => {
  const child = spawn(cli, ['models', '--standalone'], {
    env, cwd: workspace, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = '', observed = false, timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (!child.killed) child.kill('SIGTERM') // Only this exact test-owned child.
  }, 15000)
  child.stdout.on('data', data => {
    stdout += data.toString('utf8')
    if (stdout.length > 100000) stdout = stdout.slice(-100000)
    if (!observed && /^chat-on-opencode\/chatgpt-default\s*$/m.test(stdout)) {
      observed = true
      child.kill('SIGTERM') // Listing receipt is the test boundary, not server idleness.
    }
  })
  child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-3000) })
  child.on('error', error => { stderr += '\n' + String(error.code ?? 'child_error') })
  child.once('close', (status, signal) => {
    clearTimeout(timer)
    resolve({ status, signal, timedOut, stdout, stderr, observed })
  })
})
const present = result.observed
if (process.env.CHAT_ON_OPENCODE_SMOKE_DIAGNOSTIC === '1') {
  const scrub = text => String(text ?? '').replaceAll(env.CHAT_ON_OPENCODE_GATEWAY_KEY, '[redacted]')
    .replace(/[A-Za-z]:\\[^\s'"\x60]+/g, '[path]').slice(-2000)
  process.stderr.write('SMOKE_DIAGNOSTIC ' + JSON.stringify({
    stdout: scrub(result.stdout), stderr: scrub(result.stderr),
  }) + '\n')
}
assert.equal(sha(readFileSync(config)), prior, 'model_listing_changed_installed_config')
process.stdout.write(JSON.stringify({ status: result.status, signal: result.signal,
  timedOut: result.timedOut, modelPresent: present,
  outputLines: (result.stdout ?? '').split(/\r?\n/).filter(Boolean).length,
  hadStderr: Boolean((result.stderr ?? '').trim()), profileConfigUnchanged: true }) + '\n')
// SIGTERM was requested only after the exact model receipt; a standalone
// provider enumeration may otherwise keep its embedded server alive.
if (!present || result.timedOut || !result.signal && result.status !== 0) process.exitCode = 2
