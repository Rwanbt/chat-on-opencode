import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeOwnedWindows } from '../scripts/provider-window-probe-runner.mjs'

test('cold Add-Type timeout recovers once and still queries exact child PID', () => {
  const calls = []
  const result = probeOwnedWindows({
    pid: 1234, script: 'provider-window-probe.ps1', timeoutMs: 2000,
    runner(executable, args, options) {
      calls.push({ executable, args, options })
      return calls.length === 1
        ? { status: null, error: { code: 'ETIMEDOUT', message: 'cold start' } }
        : { status: 0, stdout: '[{"handle":123,"title":"Chat On Steroids browser"}]' }
    },
  })
  assert.deepEqual(result, [{ handle: 123, title: 'Chat On Steroids browser' }])
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.executable, 'powershell.exe')
    assert.deepEqual(call.args.slice(-4), ['-File', 'provider-window-probe.ps1', '-OwnerProcessId', '1234'])
    assert.equal(call.options.timeout, 2000)
  }
})

test('WM_CLOSE uses only the verified HWND and retries no non-timeout denial', () => {
  let attempts = 0
  assert.throws(() => probeOwnedWindows({
    pid: 1234, handle: -1, script: 'owned-probe.ps1',
    runner(_exe, args) {
      attempts++
      assert.deepEqual(args.slice(-6), [
        '-File', 'owned-probe.ps1', '-OwnerProcessId', '1234', '-CloseHandle', '-1',
      ])
      return { status: 1, stderr: 'Refusing WM_CLOSE: expected owned browser handle not found' }
    },
  }), /Refusing WM_CLOSE/)
  assert.equal(attempts, 1)
})

test('two actual process timeouts fail closed after the bounded retry', () => {
  let attempts = 0
  assert.throws(() => probeOwnedWindows({
    pid: 1234, script: 'owned-probe.ps1',
    runner() {
      attempts++
      return { status: null, error: { code: 'ETIMEDOUT', message: 'timed out' } }
    },
  }), /Windows window probe failed: timed out/)
  assert.equal(attempts, 2)
})

test('malformed probe JSON fails, never synthesizes a window or a close', () => {
  assert.throws(() => probeOwnedWindows({
    pid: 1234, script: 'owned-probe.ps1',
    runner: () => ({ status: 0, stdout: 'not-json' }),
  }), SyntaxError)
})
