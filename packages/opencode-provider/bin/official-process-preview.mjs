#!/usr/bin/env node
import { smokeProcessOnlyPreview } from '../src/process-only-preview.mjs'

const allowed = new Set(['--root', '--cli', '--sha'])
try {
  const args = process.argv.slice(2)
  if (args.length !== 6) throw new Error('preview_three_explicit_arguments_required')
  const fields = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || fields.has(args[i]) ||
        !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('preview_invalid_argument')
    fields.set(args[i], args[i + 1])
  }
  const result = await smokeProcessOnlyPreview({
    root: fields.get('--root'), officialCli: fields.get('--cli'),
    publishedSha256: fields.get('--sha'),
  })
  process.stdout.write(JSON.stringify(result) + '\n')
} catch (error) {
  // No paths or child output; no real account state should enter this process.
  process.stderr.write('provider_preview_refused: ' +
    String(error?.message ?? 'unknown').replace(/[^a-zA-Z0-9_]/g, '_') + '\n')
  process.exitCode = 2
}
