#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { previewNativeActivation } from '../src/official-native-activation.mjs'

export function parseNativePlan(args) {
  if (args.length !== 5 || args[0] !== '--plan' ||
      !['--config', '--mode'].includes(args[1]) ||
      !['--config', '--mode'].includes(args[3]) || args[1] === args[3]) {
    throw Error('native_activation_dry_run_only')
  }
  const fields = new Map([[args[1], args[2]], [args[3], args[4]]])
  if (!fields.get('--config') || fields.get('--mode') !== 'oauth') {
    throw Error('native_activation_verified_catalog_required_for_text')
  }
  return fields.get('--config')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = parseNativePlan(process.argv.slice(2))
    const result = previewNativeActivation(config)
    // Only fingerprints and changed field names: never print private JSONC bytes.
    const { proposed, ...safe } = result
    process.stdout.write(JSON.stringify(safe) + '\n')
  } catch (error) {
    process.stderr.write('native_activation_refused: ' +
      String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
    process.exitCode = 2
  }
}
