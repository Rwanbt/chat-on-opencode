#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planOfficialPreview, previewOfficialModel } from '../src/official-preview.mjs'

export function parsePreviewArgs(args) {
  const fields = {}
  for (let i = 0; i < args.length; i++) {
    if (!['--config', '--cli', '--bundle'].includes(args[i]) ||
        fields[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw Error('preview_arguments_invalid')
    }
    fields[args[i++]] = args[i]
  }
  if (!['--config', '--cli', '--bundle'].every(key =>
    typeof fields[key] === 'string' && path.isAbsolute(fields[key]))) {
    throw Error('preview_all_absolute_paths_required')
  }
  return { configFile: fields['--config'], officialCli: fields['--cli'], bundleDir: fields['--bundle'] }
}
async function main() {
  try {
    const options = parsePreviewArgs(process.argv.slice(2))
    const result = await previewOfficialModel(planOfficialPreview(options))
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.status !== 'PREVIEW_MODEL_AVAILABLE') process.exitCode = 2
  } catch (error) {
    const message = String(error?.message ?? '')
    const code = /^[a-z][a-z0-9_]{2,96}$/.test(message) ? message : 'preview_validation_failed'
    process.stderr.write(JSON.stringify({ status: 'NO_GO_PREVIEW', error: code }) + '\n')
    process.exitCode = 2
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
