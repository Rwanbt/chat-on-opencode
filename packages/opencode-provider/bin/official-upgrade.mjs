#!/usr/bin/env node
import { inspectUpgrade, stageUpgrade, publishVersionedCandidate, recoverStagedUpgrade } from '../src/official-upgrade.mjs'

const args = process.argv.slice(2)
const operations = new Set(['--check', '--stage', '--publish-candidate', '--recover'])
const allowed = new Set([...operations, '--config', '--cli', '--bundle'])
try {
  const operation = args.filter(x => operations.has(x))
  if (operation.length !== 1) throw new Error('upgrade_exactly_one_operation_required')
  const fields = new Map()
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error('upgrade_unknown_argument')
    if (operations.has(args[i])) continue
    if (fields.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('upgrade_bad_argument')
    fields.set(args[i++], args[i])
  }
  if (!fields.get('--config')) throw new Error('upgrade_config_required')
  if (['--check', '--stage'].includes(operation[0]) && (!fields.get('--cli') || !fields.get('--bundle'))) {
    throw new Error('upgrade_cli_and_bundle_required')
  }
  const options = { configFile: fields.get('--config'), officialCli: fields.get('--cli'),
    bundleDir: fields.get('--bundle') }
  const result = operation[0] === '--check' ? inspectUpgrade(options)
    : operation[0] === '--stage' ? stageUpgrade(options)
      : operation[0] === '--publish-candidate' ? publishVersionedCandidate(options.configFile)
        : recoverStagedUpgrade(options.configFile)
  // No paths, config bytes, account data, or environment variables in CLI output.
  process.stdout.write(JSON.stringify(operation[0] === '--check'
    ? { status: result.status, promotionAllowed: false, cliVersion: result.cliVersion,
      candidateVersion: result.candidateVersion } : result) + '\n')
} catch (error) {
  process.stderr.write('provider_upgrade_refused: ' +
    String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
  process.exitCode = 2
}
