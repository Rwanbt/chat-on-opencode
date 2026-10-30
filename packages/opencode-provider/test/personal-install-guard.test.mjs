import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { guardedPersonalInstall } from '../src/personal-install-guard.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'coo-personal-install-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const configFile = path.join(root, 'opencode.jsonc')
  writeFileSync(configFile, '{ "plugins": [] }\n')
  return { configFile, original: readFileSync(configFile) }
}

test('a running OpenCode process refuses the install and changes no byte', t => {
  const { configFile, original } = fixture(t)
  let installed = false
  const result = guardedPersonalInstall({ configFile }, {
    observe: () => ({ state: 'observed', activeOpenCode: 1, port8765: 0, port8766: 0 }),
    install: () => { installed = true },
  })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'opencode_processes_running')
  assert.equal(result.installed, false)
  assert.equal(installed, false)
  assert.deepEqual(readFileSync(configFile), original)
})

test('an unobservable process state refuses the install', t => {
  const { configFile, original } = fixture(t)
  let installed = false
  const result = guardedPersonalInstall({ configFile }, {
    observe: () => ({ state: 'unknown' }),
    install: () => { installed = true },
  })
  assert.equal(result.status, 'NO_GO')
  assert.equal(result.reason, 'process_and_port_state_unknown')
  assert.equal(installed, false)
  assert.deepEqual(readFileSync(configFile), original)
})
