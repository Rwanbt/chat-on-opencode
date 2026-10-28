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

for (const decision of ['allow', 'deny']) test('actual OpenCode V2 native read ' + decision + ' is enforced by its own permission engine',
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
    const toolFile = path.join(root, 'workspace', 'explicitly-approved.txt')
    await writeFile(toolFile, 'NATIVE_READ_PROOF_8729', { flag: 'wx' })
    await writeFile(path.join(profile, 'config.json'), await readFile(new URL('./fixtures/valid-provider-config.json', import.meta.url)))
    const port = await freePort()
    // Exercise the same shipped configuration generator as a real offline installation.
    // The native SDK must receive the plugin-generated bearer without a launcher secret.
    const generated = spawnSync(nodeExe, [path.join(pluginPackage, 'bin', 'generate-config.mjs'),
      '--runtime', executable, '--data', profile, '--node', nodeExe,
      '--plugin-dir', pluginPackage, '--port', String(port), '--native-tools', 'read'], {
      cwd: path.join(root, 'workspace'), encoding: 'utf8', timeout: 5000, shell: false,
    })
    assert.equal(generated.status, 0, `config generation failed: ${generated.stderr?.slice(-500)}`)
    const configuration = JSON.parse(generated.stdout)
    assert.equal(configuration.providers['chat-on-opencode'].settings.apiKey, undefined)
    assert.equal(configuration.providers['chat-on-opencode'].env, undefined)
    assert.equal(configuration.providers['chat-on-opencode'].models['chatgpt-default'].capabilities.tools, true)
    assert.deepEqual(configuration.permissions, [{ action: 'read', resource: '*', effect: 'ask' }])
    // The fixture is isolated and the real test file was just created. Explicit
    // approval in this throwaway workspace models explicit native consent;
    // normal generated configuration retains ASK, not ALLOW, by default.
    configuration.permissions = [{ action: 'read', resource: '*', effect: decision }]
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
      CHAT_ON_OPENCODE_TEST_NATIVE_READ_FILE: toolFile,
    })
    assert.equal(safeEnv.CHAT_ON_OPENCODE_GATEWAY_KEY, undefined)
    const args = ['run', '--standalone', '--format', 'json', '--model', 'chat-on-opencode/chatgpt-default',
      'Read the file provided to the native read tool, then answer with its verification marker.']
    let child
    const stdout = []
    const stderr = []
    let found = false
    // 2.0.32 prunes DENY tools before the model HTTP request is sent. That is
    // stronger than a tool-time denial: no native read call is available at all.
    const expected = decision === 'allow' ? 'NATIVE_FILE_READ_OK' : 'OFFLINE_FORK_OK'
    try {
      child = spawn(cli, args, {
        cwd: path.join(root, 'workspace'), env: safeEnv,
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', chunk => { if (stdout.join('').length < 200_000) stdout.push(chunk.toString()) })
      child.stderr.on('data', chunk => { if (stderr.join('').length < 100_000) stderr.push(chunk.toString()) })
      // Pin a bounded cold-start budget for both tested official CLI versions.
      // A slow first launch is not evidence that the native read was denied.
      const end = Date.now() + 30_000
      for (;;) {
        if (stdout.join('').includes(expected)) { found = true; break }
        if (child.exitCode !== null || Date.now() >= end) break
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (!found) {
        let journal = ''
        try { journal = await readFile(path.join(root, 'data', 'opencode', 'log', 'opencode.log'), 'utf8') } catch { /* optional */ }
        const clip = input => String(input).replace(/\b[a-f0-9]{64}\b/gi, '[redacted-hex]').slice(-7000)
        let routes = ''
        try { routes = await readFile(path.join(profile, 'fixture-routes.txt'), 'utf8') } catch { /* optional */ }
        console.error('ISOLATED_CLI_DIAGNOSTIC', JSON.stringify({ exit: child.exitCode,
          stderr: clip(stderr.join('')).slice(-1000), stdout: clip(stdout.join('')).slice(-5000),
          journal: clip(journal).slice(-350), routes }))
      }
      assert.ok(found, 'Native OpenCode did not finish real native read/permission flow')
      const parts = stdout.join('').split(/\r?\n/).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      assert.ok(parts.some(item => item.type === 'text' && item.part?.text?.includes(expected)),
        'only an actual assistant text part following native permission counts')
      const native = parts.find(item => item.type === 'tool_use' && item.part?.tool === 'read')
      if (decision === 'allow') {
        assert.ok(native, 'native OpenCode tool event not emitted')
        assert.equal(native.part.state.status, 'completed', 'read never executed natively')
        assert.match(JSON.stringify(native.part.state), /NATIVE_READ_PROOF_8729/,
          'native read did not return contents of actual test file')
      } else {
        assert.equal(native, undefined, 'native read executed despite denied permission')
        assert.ok(!stdout.join('').includes('NATIVE_READ_PROOF_8729'), 'denied read contents leaked')
      }
      let log = ''
      try { log = await readFile(path.join(root, 'data', 'opencode', 'log', 'opencode.log'), 'utf8') } catch { /* optional */ }
      assert.doesNotMatch([stdout.join(''), stderr.join(''), log].join('\n'), /Bearer\s+[a-f0-9]{64}/i)
      // The real tool_use event plus fixture's final marker proves native read
      // and result follow-up. Do not probe gateway health after CLI completion:
      // parent IPC may already have terminated the helper, correctly. The
      // optional fixture trace also varies under Windows RUNNER~1 aliases.
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
