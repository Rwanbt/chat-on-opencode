#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseInstalledProvider } from '../src/official-doctor.mjs'

export function parseDoctorArgs(args) {
  const result = { checkSocket: false }
  for (let index = 0; index < args.length; index++) {
    const token = args[index]
    if (token === '--check-socket' && !result.checkSocket) result.checkSocket = true
    else if (['--config', '--bundle'].includes(token)) {
      const key = token.slice(2)
      if (result[key] || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('doctor_argument_invalid')
      result[key] = args[++index]
    } else throw Error('doctor_argument_invalid')
  }
  if (!result.config || !path.isAbsolute(result.config) ||
      (result.bundle && !path.isAbsolute(result.bundle))) throw Error('doctor_config_absolute_required')
  return result
}

async function main() {
  try {
    const { config, bundle, checkSocket } = parseDoctorArgs(process.argv.slice(2))
    const report = await diagnoseInstalledProvider(config, { bundleDir: bundle, checkSocket })
    process.stdout.write(JSON.stringify(report) + '\n')
    if (report.blockers.length) process.exitCode = 2
  } catch (error) {
    // Do not expose personal filesystem paths, configuration, bearer material or API errors.
    const allow = /^[a-z][a-z0-9_]{2,96}$/
    const code = allow.test(String(error?.message)) ? error.message : 'doctor_integrity_check_failed'
    process.stderr.write(JSON.stringify({ status: 'NO_GO_PROVIDER_NOT_READY', code }) + '\n')
    process.exitCode = 2
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
