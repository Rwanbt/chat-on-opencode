import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const binary = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
const EXPECTED = 'offline-control/visible-model'

test('official CLI offline baseline lists a static model WITHOUT the CoS plugin', {
  skip: !binary, timeout: 40000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-bare-cli-'))
  let safeToCleanup = true
  t.after(() => safeToCleanup
    ? rm(root, { force: true, recursive: true, maxRetries: 3, retryDelay: 200 })
    : undefined)
  for (const name of ['home', 'config', 'data', 'cache', 'appdata', 'localappdata', 'tmp', 'workspace']) {
    await mkdir(path.join(root, name))
  }
  const config = { plugins: [], providers: { 'offline-control': {
    name: 'Offline Control', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:1/v1' },
    models: { 'visible-model': {
      name: 'Model registration only', capabilities: { tools: false, input: ['text'], output: ['text'] },
      limit: { context: 16384, output: 2048 },
    } },
  } } }
  await writeFile(path.join(root, 'config', 'opencode.jsonc'), JSON.stringify(config),
    { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key) &&
    typeof value === 'string'))
  Object.assign(env, {
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
    TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_PROJECT_DISABLE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  })
  const version = spawnSync(binary, ['--version'], { env, cwd: path.join(root, 'workspace'),
    windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000 })
  assert.match(version.stdout, /^opencode v2\.1\.4\s*$/i)
  assert.equal(version.status, 0)
  const child = spawn(binary, ['models', '--standalone'], {
    env, cwd: path.join(root, 'workspace'), windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  })
  safeToCleanup = false
  let found = false, bytes = 0, errBytes = 0, tail = '', errorTail = ''
  let terminated = false
  const stop = () => {
    if (terminated || child.exitCode !== null || !child.pid) return
    terminated = true
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
      { shell: false, windowsHide: true, timeout: 5000, stdio: 'ignore' })
    else child.kill('SIGTERM')
  }
  let timedOut = false, closed = false
  try {
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true
        stop()
        resolve('timeout')
      }, 15000)
      child.stdout.on('data', value => {
        bytes += value.byteLength
        tail = (tail + value.toString('utf8')).slice(-1024)
        if (tail.includes(EXPECTED)) { found = true; stop() }
      })
      child.stderr.on('data', value => {
        errBytes += value.byteLength
        errorTail = (errorTail + value.toString('utf8')).slice(-4096)
      })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', () => {
        clearTimeout(timer)
        closed = true
        safeToCleanup = true
        resolve('closed')
      })
    })
    if (outcome !== 'closed') {
      await Promise.race([
        new Promise(resolve => child.once('close', () => {
          closed = true
          safeToCleanup = true
          resolve()
        })),
        new Promise(resolve => setTimeout(resolve, 2500)),
      ])
    }
    assert.equal(closed, true, 'offline_control_child_exit_unconfirmed')
    assert.equal(found, true,
      `offline_control_model_missing_stdout_${bytes ? 'nonzero' : 'zero'}_stderr_${errBytes ? 'nonzero' : 'zero'}_${timedOut ? 'timeout' : 'exit'}_${/unknown|unrecognized|unexpected/i.test(errorTail) ? 'unrecognized' : /provider.*not.*found|provider.*invalid/i.test(errorTail) ? 'provider_unavailable' : /error|failed|invalid/i.test(errorTail) ? 'error' : 'other'}`)
  } finally { stop() }
})
