import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = process.env.CHAT_ON_OPENCODE_TEST_CLI
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginPackage = process.env.CHAT_ON_OPENCODE_TEST_PLUGIN_PACKAGE || packageRoot
const fixture = fileURLToPath(new URL('fixtures/mock-cos.ts', import.meta.url))
const nodeExe = process.execPath

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function stopTree(child) {
  if (!child) return
  if (child.pid && child.exitCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve))
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 5000 })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ }
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))])
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

test('actual OpenCode V2 CLI loads provider plugin, starts owned gateway and receives offline streamed text',
  { skip: !cli ? 'Set CHAT_ON_OPENCODE_TEST_CLI to an actual absolute OpenCode 2 executable' : false,
    timeout: 80_000 }, async () => {
    assert.ok(path.isAbsolute(cli) && existsSync(cli), 'OpenCode V2 executable missing')
    const root = await mkdtemp(path.join(os.tmpdir(), 'coo-opencode-cli-'))
    const names = ['home', 'config', 'data', 'cache', 'appdata', 'localappdata', 'workspace', 'provider-data']
    for (const name of names) await mkdir(path.join(root, name))
    const executable = path.join(root, process.platform === 'win32' ? 'mock-cos.exe' : 'mock-cos')
    const compiled = spawnSync('bun', ['build', fixture, '--compile', '--outfile', executable], {
      cwd: packageRoot, encoding: 'utf8', timeout: 30_000, shell: false, windowsHide: true,
    })
    assert.equal(compiled.status, 0, `offline CoS fixture failed to build: ${compiled.stderr?.slice(-1500)}`)
    const profile = path.join(root, 'provider-data')
    await writeFile(path.join(profile, 'config.json'), JSON.stringify({
      ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
    }))
    const port = await freePort()
    // Exercise the same shipped configuration generator as a real offline installation.
    // The plugin must create its own transient bearer key without a process env secret.
    const generated = spawnSync(nodeExe, [path.join(pluginPackage, 'bin', 'generate-config.mjs'),
      '--runtime', executable, '--data', profile, '--node', nodeExe,
      '--plugin-dir', pluginPackage, '--port', String(port)], {
      cwd: path.join(root, 'workspace'), encoding: 'utf8', timeout: 5000, shell: false,
    })
    assert.equal(generated.status, 0, `config generation failed: ${generated.stderr?.slice(-500)}`)
    const configuration = JSON.parse(generated.stdout)
    assert.equal(configuration.providers['chat-on-opencode'].settings.apiKey, undefined)
    assert.equal(configuration.providers['chat-on-opencode'].env, undefined)
    const safeEnv = {}
    for (const [name, value] of Object.entries(process.env)) {
      if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name) && typeof value === 'string') safeEnv[name] = value
    }
    Object.assign(safeEnv, {
      HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration), OPENCODE_CONFIG_PROJECT_DISABLE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      CHAT_ON_OPENCODE_TEST_TRACE_DIR: root,
    })
    assert.equal(safeEnv.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
    const args = ['run', '--standalone', '--format', 'json', '--model', 'chat-on-opencode/chatgpt-default',
      'Say exactly OFFLINE_FORK_OK']
    let child
    const stdout = []
    const stderr = []
    let found = false
    try {
      child = spawn(cli, args, {
        cwd: path.join(root, 'workspace'), env: safeEnv,
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', chunk => { if (stdout.join('').length < 200_000) stdout.push(chunk.toString()) })
      child.stderr.on('data', chunk => { if (stderr.join('').length < 100_000) stderr.push(chunk.toString()) })
      // A newly installed official CLI may cold-start its isolated Bun server
      // and plugin loader slowly, even when the native model turn is healthy.
      const end = Date.now() + 30_000
      for (;;) {
        if (stdout.join('').includes('OFFLINE_FORK_OK')) { found = true; break }
        if (child.exitCode !== null || Date.now() >= end) break
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (!found) {
        let journal = ''
        try { journal = await readFile(path.join(root, 'data', 'opencode', 'log', 'opencode.log'), 'utf8') } catch { /* optional */ }
        let routes = ''
        try { routes = await readFile(path.join(profile, 'fixture-routes.txt'), 'utf8') } catch { /* optional */ }
        console.error('ISOLATED_CLI_DIAGNOSTIC', JSON.stringify({ exit: child.exitCode,
          stderr: stderr.join('').slice(-300), stdout: stdout.join('').slice(-350),
          journal: journal.slice(-350), routes }))
      }
      assert.ok(found, 'Native OpenCode model request did not produce offline fixture reply')
      const parts = stdout.join('').split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      assert.ok(parts.some(item => item.type === 'text' && item.part?.text?.includes('OFFLINE_FORK_OK')),
        'only an actual assistant text part counts as a valid streamed reply')
      // The plugin-owned bearer must never be projected into user-facing CLI output or logs.
      let log = ''
      try { log = await readFile(path.join(root, 'data', 'opencode', 'log', 'opencode.log'), 'utf8') } catch { /* optional */ }
      assert.doesNotMatch([stdout.join(''), stderr.join(''), log].join('\n'), /Bearer\s+[a-f0-9]{64}/i)
      const homeContents = await readdir(path.join(root, 'home'))
      assert.ok(homeContents.every(name => name === '.local'), 'unknown files in isolated HOME')
    } finally {
      await stopTree(child)
      for (let attempt = 0; attempt < 45; attempt++) {
        try { await rm(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 }); break }
        catch (error) {
          if (attempt === 44) console.error('ISOLATED_CLEANUP_BLOCKED', String(error).slice(0,250))
          else await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
    }
  })
