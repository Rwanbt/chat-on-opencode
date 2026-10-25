#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { checkInstall, installProvider, rollbackProvider } from '../src/official-install.mjs'

const args = process.argv.slice(2)
const allowed = new Set(['--check', '--install', '--rollback', '--config', '--cli', '--bundle',
  '--runtime', '--data', '--node', '--personal-cos-data', '--port'])
try {
  const operation = args.filter(a => ['--check', '--install', '--rollback'].includes(a))
  if (operation.length !== 1) throw new Error('exactly_one_operation_required')
  const fields = new Map()
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('unknown_install_option')
    if (operation.includes(args[i])) continue
    if (!args[i + 1] || args[i + 1].startsWith('--') || fields.has(args[i])) throw new Error('invalid_install_option')
    fields.set(args[i++], args[i])
  }
  const configFile = fields.get('--config')
  if (!configFile) throw new Error('opencode_config_path_required')
  const opts = {
    configFile, officialCli: fields.get('--cli'),
    bundleDir: fields.get('--bundle') ?? fileURLToPath(new URL('..', import.meta.url)),
    runtimeExecutable: fields.get('--runtime'), runtimeData: fields.get('--data'),
    nodeExecutable: fields.get('--node'), personalCoSData: fields.get('--personal-cos-data'),
    port: fields.has('--port') ? Number(fields.get('--port')) : undefined,
  }
  if (operation[0] === '--rollback') {
    process.stdout.write(JSON.stringify(rollbackProvider(configFile)) + '\n')
  } else if (operation[0] === '--check') {
    const plan = checkInstall(opts)
    process.stdout.write(JSON.stringify({ readyForScopedInstall: true,
      officialCliVersion: plan.version, proposedSha256: plan.installedSha256,
      currentSha256: plan.originalSha256 }) + '\n')
  } else {
    process.stdout.write(JSON.stringify(installProvider(opts)) + '\n')
  }
} catch (error) {
  // Never echo paths, config text, environment variables or bearer tokens.
  process.stderr.write('provider_install_refused: ' + String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
  process.exitCode = 2
}
