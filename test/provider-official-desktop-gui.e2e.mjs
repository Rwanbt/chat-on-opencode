/**
 * Real, unmodified vendor Desktop 2.1.4 GUI smoke on a disposable GitHub Windows
 * runner. The upstream-supported OPENCODE_DESKTOP_TEST_ROOT isolates all app
 * storage. Only the owned process PID/HWND is inspected and closed gracefully.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'runner_only')
const runner = process.env.RUNNER_TEMP
const desktop = process.env.CHAT_ON_OPENCODE_TEST_DESKTOP_EXE
assert.ok(runner && desktop && path.isAbsolute(desktop) && existsSync(desktop))
assert.ok(path.resolve(desktop).toLowerCase().startsWith(path.resolve(runner).toLowerCase() + path.sep),
  'never launch a personal installed OpenCode executable')
const probe = path.resolve('scripts/probe-official-desktop-window.ps1')
const root = await mkdtemp(path.join(os.tmpdir(), 'coo-official-desktop-ui-e2e-'))
const testRoot = path.join(root, 'official-desktop-test-root')
const appdata = path.join(root, 'appdata')
const localappdata = path.join(root, 'localappdata')
await Promise.all([testRoot, appdata, localappdata].map(p => mkdir(p, { recursive: true })))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const env = { ...process.env }
for (const name of Object.keys(env)) {
  if (/^(CHAT_ON_OPENCODE_|COS_|ELECTRON_|OPENAI_API_KEY$|OPENCODE_SERVER_PASSWORD$)/i.test(name)) delete env[name]
}
Object.assign(env, {
  OPENCODE_DESKTOP_TEST_ROOT: testRoot,
  APPDATA: appdata, LOCALAPPDATA: localappdata,
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
  OPENCODE_CONFIG_PROJECT_DISABLE: '1',
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: '127.0.0.1,localhost',
})
let child
// The official Desktop is an independently packaged GUI; bound the entire CI
// smoke even when Electron keeps native handles alive after the owned window
// has closed. This watchdog never runs on, or targets, a personal Windows PC.
const watchdog = setTimeout(() => {
  process.stderr.write('OFFICIAL_DESKTOP_GUI_TEST_WALL_TIMEOUT\n')
  if (child?.exitCode === null) child.kill('SIGTERM')
  child?.unref()
  process.exit(1)
}, 115_000)
function ownedProbe(close = false) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', probe, '-OwnerProcessId', String(child.pid)]
  if (close) args.push('-CloseOwnedWindow')
  const result = spawnSync('powershell.exe', args, {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 25000,
  })
  if (result.status !== 0) throw Error('official_desktop_owned_window_probe_failed_' +
    (result.error?.code ?? 'refusal'))
  return result.stdout.trim()
}
try {
  child = spawn(desktop, [
    '--disable-quic', '--disable-background-networking',
    '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
  ], {
    cwd: path.dirname(desktop), env, shell: false, windowsHide: false,
    stdio: 'ignore',
  })
  assert.ok(child.pid, 'official_desktop_gui_start_failed')
  const deadline = Date.now() + 45000
  let visible = false
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'official_desktop_gui_exited_before_window')
    const result = ownedProbe()
    if (result === 'OWNED_OPEN_CODE_WINDOW_VISIBLE') { visible = true; break }
    assert.equal(result, 'NO_WINDOW')
    await delay(400)
  }
  assert.equal(visible, true, 'official_desktop_gui_owned_window_never_visible')
  assert.equal(existsSync(path.join(testRoot, 'desktop')), true,
    'official_desktop_test_root_not_used')
  assert.equal(ownedProbe(true), 'OWNED_WM_CLOSE_SENT')
  const exited = child.exitCode !== null || await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    delay(15000).then(() => false),
  ])
  assert.equal(exited, true, 'official_desktop_gui_refused_graceful_owned_close')
  process.stdout.write('OFFICIAL_UNMODIFIED_DESKTOP_GUI_2_1_4=PASS\n')
  process.stdout.write('OFFICIAL_DESKTOP_PROFILE_ISOLATION=PASS\n')
} finally {
  if (child?.exitCode === null) {
    // CI-owned disposable process only. No kill or signal to any personal app.
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3500)])
    if (child.exitCode === null) {
      process.stderr.write('OFFICIAL_DESKTOP_GUI_CHILD_STILL_LIVE_AFTER_TERM\n')
      child.unref()
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  clearTimeout(watchdog)
}
