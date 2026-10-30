import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { installProvider } from '../src/official-install.mjs'
import { classifyGatewayPlugin, diagnoseInstalledProvider } from '../src/official-doctor.mjs'
import { parseDoctorArgs } from '../bin/official-doctor.mjs'

const bundleDir = fileURLToPath(new URL('..', import.meta.url))
const version = () => ({ status: 0, stdout: 'opencode v2.1.4\n' })

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-doctor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = path.join(root, 'config'), runtimeData = path.join(root, 'runtime-data')
  await mkdir(configDir)
  await mkdir(runtimeData)
  const configFile = path.join(configDir, 'opencode.jsonc')
  const original = '{/*user settings*/ "plugins":[{"package":"goal"}],"providers":{"other":{"models":{}}},"loop":true,"daemon":true}'
  await writeFile(configFile, original)
  await writeFile(path.join(runtimeData, 'config.json'), JSON.stringify({
    ui: { chatBrowser: 'cos' }, controlApi: { enabled: true, allowActions: true },
    personalSecretFixture: 'SECRET_DO_NOT_SHOW',
  }))
  const runtimeExecutable = path.join(root, 'runtime.exe'), officialCli = path.join(root, 'cli.exe')
  await writeFile(runtimeExecutable, 'nonexecuted fixture')
  await writeFile(officialCli, 'nonexecuted fixture')
  const args = { configFile, officialCli, bundleDir, runtimeExecutable, runtimeData,
    nodeExecutable: process.execPath }
  installProvider(args, { runner: version })
  return { root, args, original }
}

test('gateway mode strictly distinguishes old environment-only and current generated secret', () => {
  assert.equal(classifyGatewayPlugin('const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY'), 'legacy_environment')
  assert.equal(classifyGatewayPlugin('const key = randomBytes(32).toString("hex")'), 'ephemeral')
  assert.equal(classifyGatewayPlugin('CHAT_ON_OPENCODE_GATEWAY_KEY const key = randomBytes(32)'), 'ephemeral')
  assert.equal(classifyGatewayPlugin('const key = "static"'), 'unknown')
})

test('read-only doctor proves intact live format1 install and synthetic 127.0.0.1 gate', async t => {
  const ctx = await fixture(t)
  const before = await readFile(ctx.args.configFile)
  let probes = 0
  const report = await diagnoseInstalledProvider(ctx.args.configFile, {
    bundleDir, checkSocket: true, socketProbe: async port => { probes++; assert.equal(port, 45861); return false },
  })
  assert.equal(report.status, 'NO_GO_PROVIDER_NOT_READY')
  assert.equal(report.backupHashVerified, true)
  assert.equal(report.configOwnershipVerified, true)
  assert.equal(report.configDrift, null)
  assert.equal(report.candidateMatches, true)
  assert.equal(report.keyMode, 'ephemeral')
  assert.equal(report.runtimeAvailable, true)
  assert.equal(report.isolatedConsent, true)
  assert.deepEqual(report.blockers, ['configured_gateway_not_listening'])
  assert.equal(report.inferenceAuthenticated, false)
  assert.equal(report.activeUpgradePerformed, false)
  assert.equal(probes, 1)
  assert.deepEqual(await readFile(ctx.args.configFile), before)
  assert.doesNotMatch(JSON.stringify(report), /SECRET_DO_NOT_SHOW|runtime-data|coo-doctor-/)
})

test('without a socket probe doctor makes no network calls and never claims authenticated inference', async t => {
  const ctx = await fixture(t)
  const report = await diagnoseInstalledProvider(ctx.args.configFile, {
    bundleDir, socketProbe: () => { throw new Error('network probe forbidden') },
  })
  assert.equal(report.status, 'PREFLIGHT_ONLY')
  assert.equal(report.gatewayListening, null)
  assert.equal(report.inferenceAuthenticated, false)
  assert.equal(report.nativeReadRequested, false)
})

test('candidate matching covers source gateway implementation, not only plugin index', async t => {
  const ctx = await fixture(t)
  const candidate = path.join(ctx.root, 'candidate')
  await mkdir(candidate)
  for (const folder of ['bin', 'plugin', 'src']) {
    await cp(path.join(bundleDir, folder), path.join(candidate, folder), { recursive: true })
  }
  for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
    await copyFile(path.join(bundleDir, name), path.join(candidate, name))
  }
  const gateway = path.join(candidate, 'src', 'gateway.mjs')
  await writeFile(gateway, (await readFile(gateway, 'utf8')) + '\n// stale gateway fixture\n')
  const report = await diagnoseInstalledProvider(ctx.args.configFile, { bundleDir: candidate })
  assert.equal(report.keyMode, 'ephemeral')
  assert.equal(report.candidateMatches, false)
  assert.ok(report.blockers.includes('installed_bundle_outdated'))
})

test('a foreign config edit is reported as drift and never exposed, and a broken owned scope still refuses', async t => {
  const ctx = await fixture(t)
  const original = await readFile(ctx.args.configFile, 'utf8')
  await writeFile(ctx.args.configFile, original + '\n// PRIVATE_CHAT_CONTENT_AND_TOKEN')
  // A foreign edit is not damage to the installation: the doctor reports it.
  const report = await diagnoseInstalledProvider(ctx.args.configFile)
  assert.equal(report.configDrift, 'foreign_edit')
  assert.equal(report.configOwnershipVerified, true)
  assert.doesNotMatch(JSON.stringify(report), /SECRET_DO_NOT_SHOW|runtime-data|coo-doctor-|PRIVATE_CHAT_CONTENT_AND_TOKEN/)
  // The owned entries are gone: the doctor refuses rather than guessing.
  await writeFile(ctx.args.configFile, '{}')
  await assert.rejects(() => diagnoseInstalledProvider(ctx.args.configFile),
    /provider_scope_mismatch/)
})

test('missing runtime consent is a specific safe blocker instead of launching browser or network', async t => {
  const ctx = await fixture(t)
  const settings = path.join(ctx.args.runtimeData, 'config.json')
  await writeFile(settings, JSON.stringify({ ui: { chatBrowser: 'chromium' }, controlApi: { enabled: false } }))
  const report = await diagnoseInstalledProvider(ctx.args.configFile)
  assert.equal(report.runtimeAvailable, true)
  assert.equal(report.isolatedConsent, false)
  assert.ok(report.blockers.includes('isolated_runtime_consent_missing'))
})

test('reject malicious arguments and sanitize CLI output without secret or profile path', async t => {
  const ctx = await fixture(t)
  assert.deepEqual(parseDoctorArgs(['--config', ctx.args.configFile, '--check-socket']),
    { config: ctx.args.configFile, checkSocket: true })
  assert.throws(() => parseDoctorArgs(['--config', 'relative']), /doctor_config_absolute_required/)
  assert.throws(() => parseDoctorArgs(['--config', ctx.args.configFile, '--config', ctx.args.configFile]),
    /doctor_argument_invalid/)
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../bin/official-doctor.mjs', import.meta.url)),
    '--config', ctx.args.configFile, '--bundle', bundleDir,
  ], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0)
  assert.equal(JSON.parse(result.stdout).status, 'PREFLIGHT_ONLY')
  assert.doesNotMatch(result.stdout + result.stderr, /coo-doctor-|SECRET_DO_NOT_SHOW|runtime-data/)
})
