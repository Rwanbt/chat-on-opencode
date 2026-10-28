import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureAttestationCAS, windowsProcessIdle, runAttestation } from '../bin/human-draft-attestation.mjs'

test('Windows CIM must conclusively report zero processes; unknown and busy fail closed', () => {
  const invoke = result => windowsProcessIdle({ platform: 'win32', runner: (_exe, args) => {
    assert.ok(args.join(' ').includes('Get-CimInstance Win32_Process'))
    return result
  } })
  assert.equal(invoke({ status: 0, stdout: '0\r\n' }), true)
  assert.equal(invoke({ status: 0, stdout: '1\r\n' }), false)
  assert.equal(invoke({ status: null, error: new Error('timeout') }), false)
  assert.equal(invoke({ status: 0, stdout: '' }), false)
  assert.equal(windowsProcessIdle({ platform: 'linux' }), false)
})

test('CAS captures config journal and exact A/B/C trees; mismatches are detectable', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'coo-attestation-test-'))
  try {
    const paths = { config: path.join(root, 'config'), journal: path.join(root, 'journal'),
      originalA: path.join(root, 'A'), activeB: path.join(root, 'B'), candidateC: path.join(root, 'C') }
    writeFileSync(paths.config, 'config'); writeFileSync(paths.journal, 'journal')
    for (const key of ['originalA','activeB','candidateC']) {
      mkdirSync(paths[key]); writeFileSync(path.join(paths[key], 'plugin'), key)
    }
    const before = captureAttestationCAS(paths)
    assert.equal(Object.keys(before).length, 5)
    writeFileSync(path.join(paths.candidateC, 'plugin'), 'changed')
    assert.notEqual(captureAttestationCAS(paths).candidateC, before.candidateC)
    assert.deepEqual(captureAttestationCAS(paths).config, before.config)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('no interactive terminal never yields approval, even with idle mock', async () => {
  const result = await runAttestation({}, { input: { isTTY: false }, output: { isTTY: false } })
  assert.deepEqual(result, { status: 'NO_GO', activationAuthorized: false,
    reason: 'attestation_interactive_terminal_required' })
})
