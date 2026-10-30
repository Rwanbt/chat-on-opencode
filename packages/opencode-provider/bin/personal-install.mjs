#!/usr/bin/env node
// Run from a terminal, with OpenCode closed. Refuses while any OpenCode process runs.
// Usage: node bin/personal-install.mjs <options.json>
import { readFileSync } from 'node:fs'
import { guardedPersonalInstall } from '../src/personal-install-guard.mjs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: personal-install.mjs <options.json>\n')
  process.exit(2)
}
const options = JSON.parse(readFileSync(file, 'utf8'))
const result = guardedPersonalInstall(options)
process.stdout.write(JSON.stringify(result) + '\n')
process.exit(result.status === 'INSTALLED' ? 0 : 1)
