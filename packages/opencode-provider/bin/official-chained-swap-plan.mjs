#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { planChainedManagedSwap } from '../src/official-chained-swap-plan.mjs'

export function parseChainArgs(args) {
  if (args.length !== 7 || args[0] !== '--inspect') throw Error('chained_swap_inspection_only')
  const inputs = new Map()
  for (let i = 1; i < args.length; i += 2) {
    if (!['--config', '--candidate', '--expected-sha256'].includes(args[i]) ||
        !args[i + 1] || args[i + 1].startsWith('--') || inputs.has(args[i])) {
      throw Error('chained_swap_invalid_option')
    }
    inputs.set(args[i], args[i + 1])
  }
  if (inputs.size !== 3 || !path.isAbsolute(inputs.get('--config')) ||
      !path.isAbsolute(inputs.get('--candidate')) ||
      !/^[a-f0-9]{64}$/.test(inputs.get('--expected-sha256'))) {
    throw Error('chained_swap_absolute_pinned_paths_required')
  }
  return inputs
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseChainArgs(process.argv.slice(2))
    const plan = planChainedManagedSwap(opts.get('--config'),
      opts.get('--candidate'), opts.get('--expected-sha256'))
    process.stdout.write(JSON.stringify(plan) + '\n')
  } catch (error) {
    // Never echo configuration text, user paths, account data or profile contents.
    process.stderr.write('chained_swap_refused: ' +
      String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
    process.exitCode = 2
  }
}
