import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createOpenCodeConfig } from '../src/config.mjs'
import { installProvider } from '../src/official-install.mjs'
import { stageUpgrade, publishVersionedCandidate, recoverStagedUpgrade } from '../src/official-upgrade.mjs'
import { candidateDigest } from '../src/official-upgrade.mjs'
import { publishRestartOnlyPointer, inspectRestartOnlyPointer } from '../src/official-versioned-pointer.mjs'
import { createHash } from 'node:crypto'

const official = process.env.CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI
const bundle = fileURLToPath(new URL('..', import.meta.url))
test('official OpenCode CLI actually imports generation G and returns to A after pointer rollback',
  { skip: !official ? 'Set CHAT_ON_OPENCODE_TEST_OFFICIAL_CLI to installed official 2.1.4' : false,
    timeout: 90000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'coo-immutable-real-cli-'))
    t.after(async () => rm(root, { recursive: true, force: true }))
    for (const d of ['config','home','data','cache','appdata','localappdata','provider','future','workspace']) {
      await mkdir(path.join(root, d))
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)))
    Object.assign(env, { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
      APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
      XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'), OPENCODE_CONFIG_DIR: path.join(root, 'config'),
      OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' })
    const version = spawnSync(official, ['--version'], {
      windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, env })
    // The CI job pins 2.1.4; a local 2.0.29 check uses only an explicit opt-in.
    const expected = process.env.CHAT_ON_OPENCODE_TEST_LOCAL_CLI_VERSION === '2.0.29' ? '2.0.29' : '2.1.4'
    assert.match(version.stdout, new RegExp(`opencode v?${expected.replaceAll('.', '\\.')}\\s*$`, 'i'))
    assert.equal(version.status, 0)
    const configFile = path.join(root, 'config', 'opencode.jsonc')
    const runtime = path.join(root, 'runtime.exe')
    await writeFile(runtime, 'offline fixture; never executed')
    await writeFile(configFile, '{"plugins":[],"providers":{},"goal":"preserved","loop":"preserved","daemon":true}')
    await writeFile(path.join(root, 'provider', 'config.json'), JSON.stringify({
      ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
    }))
    const install = { configFile, officialCli: official, bundleDir: bundle,
      runtimeExecutable: runtime, runtimeData: path.join(root, 'provider'), nodeExecutable: process.execPath }
    const runner = () => version
    installProvider(install, { runner })
    for (const dir of ['bin', 'plugin', 'src']) cpSync(path.join(bundle, dir), path.join(root, 'future', dir), { recursive: true })
    for (const file of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      cpSync(path.join(bundle, file), path.join(root, 'future', file))
    }
    // A and G otherwise expose exactly the same model id. Make G observable
    // only when the real bundled CLI imports its configured plugin package.
    const gLoaded = path.join(root, 'candidate-g-loaded')
    const candidateEntry = path.join(root, 'future', 'plugin', 'index.ts')
    const source = await readFile(candidateEntry, 'utf8')
    await writeFile(candidateEntry,
      `import { writeFileSync as markCandidateLoaded } from 'node:fs'\n` +
      `markCandidateLoaded(${JSON.stringify(gLoaded)}, 'G')\n` + source)
    const options = { configFile, officialCli: official, bundleDir: path.join(root, 'future') }
    const { stagedDigest } = stageUpgrade(options, { runner })
    const result = publishVersionedCandidate(configFile)
    assert.equal(result.publishedSha256, stagedDigest)
    const published = path.join(root, 'config', '.chat-on-opencode-version-' + stagedDigest)
    const managed = path.join(root, 'config', '.chat-on-opencode-managed')
    const before = await readFile(configFile)
    const configSha = createHash('sha256').update(before).digest('hex')
    const proof = { configSha, fromSha: candidateDigest(managed), toSha: candidateDigest(published),
      probe: () => ({ status: 0, stdout: '0\r\n' }) }
    assert.throws(() => publishRestartOnlyPointer(configFile, managed, published, {
      ...proof, fault: step => { if (step === 'before_publish') throw Error('before_commit') },
    }), /before_commit/)
    assert.deepEqual(await readFile(configFile), before)
    const switched = publishRestartOnlyPointer(configFile, managed, published, proof)
    assert.equal(switched.activationAuthorized, false)
    assert.equal(inspectRestartOnlyPointer(configFile, configSha, switched.publishedConfigSha256).state, 'NEW')
    async function listModel() {
      const child = spawn(official, ['models', '--standalone'], {
        cwd: path.join(root, 'workspace'), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', error = ''
      let matched = false
      const resultCode = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { shutdown(); reject(new Error('offline_cli_model_timeout')) }, 45000)
        const shutdown = () => {
          if (!child.pid || child.exitCode !== null) return
          if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)],
            { windowsHide: true, shell: false, timeout: 5000 })
          else child.kill('SIGTERM')
        }
        child.stdout.on('data', chunk => {
          output += chunk.toString('utf8')
          if (output.length > 100000) { shutdown(); reject(new Error('offline_cli_output_excess')) }
          if (output.includes('chat-on-opencode/chatgpt-default')) { matched = true; shutdown() }
        })
        child.stderr.on('data', chunk => { if (error.length < 3000) error += chunk.toString('utf8') })
        child.once('error', e => { clearTimeout(timer); reject(e) })
        child.once('close', code => { clearTimeout(timer); resolve(code) })
      })
      assert.equal(matched, true, 'official CLI did not list provider model (exit ' + resultCode + ')')
    }
    await listModel()
    assert.equal(existsSync(gLoaded), true, 'official CLI did not import generation G')
    assert.equal(await readFile(gLoaded, 'utf8'), 'G')
    assert.equal(inspectRestartOnlyPointer(configFile, configSha, switched.publishedConfigSha256).state, 'NEW')
    const rollback = publishRestartOnlyPointer(configFile, published, managed, {
      configSha: switched.publishedConfigSha256, fromSha: proof.toSha, toSha: proof.fromSha,
      probe: proof.probe })
    assert.equal(rollback.status, 'RESTART_REQUIRED_ONLY')
    assert.deepEqual(await readFile(configFile), before)
    await rm(gLoaded)
    await listModel()
    assert.equal(existsSync(gLoaded), false, 'official CLI still imported G after rollback to A')
    assert.equal(recoverStagedUpgrade(configFile).originalInstallUnchanged, true)
  })
