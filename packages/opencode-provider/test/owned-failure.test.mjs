import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { reportOwnedFailure, GATEWAY_FAILURE_MESSAGE } from '../src/owned-failure.mjs'

test('an owned gateway reports its cause to the parent and then terminates', () => {
  const sent = []
  const exits = []
  const reported = reportOwnedFailure('runtime_profile_endpoint_occupied', {
    owned: true,
    send: (message, callback) => { sent.push(message); callback() },
    exit: code => exits.push(code),
  })
  assert.equal(reported, true)
  assert.deepEqual(sent, [{ type: GATEWAY_FAILURE_MESSAGE, code: 'runtime_profile_endpoint_occupied' }])
  assert.deepEqual(exits, [1])
})

test('an unowned gateway keeps its own exit policy', () => {
  const exits = []
  const reported = reportOwnedFailure('runtime_profile_endpoint_occupied', {
    owned: false,
    send: () => { throw new Error('must_not_send') },
    exit: code => exits.push(code),
  })
  assert.equal(reported, false)
  assert.deepEqual(exits, [])
})

test('a cause that is not a fixed category is never forwarded', () => {
  const sent = []
  reportOwnedFailure('secret value with spaces', {
    owned: true,
    send: (message, callback) => { sent.push(message); callback() },
    exit: () => {},
  })
  assert.deepEqual(sent, [{ type: GATEWAY_FAILURE_MESSAGE, code: 'invalid_configuration' }])
})

test('a gateway that cannot report still terminates', () => {
  const exits = []
  reportOwnedFailure('runtime_process_exited', {
    owned: true,
    send: () => { throw new Error('channel closed') },
    exit: code => exits.push(code),
  })
  assert.deepEqual(exits, [1])
})

test('the parent surfaces the cause its child reported instead of a timeout', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 43210, exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) },
  })
  const lifecycle = new GatewayLifecycle({ entry: 'entry.mjs', runtimeExecutable: 'fork.exe',
    runtimeData: 'isolated', key: 'm'.repeat(40), port: 45861, node: process.execPath }, {
    launcher: () => child,
    fetcher: async () => { throw new Error('not_listening_yet') },
    clock: async () => {
      child.emit('message', { type: GATEWAY_FAILURE_MESSAGE, code: 'runtime_profile_endpoint_occupied' })
      child.exitCode = 1
      child.emit('exit', 1)
    },
  })
  await assert.rejects(lifecycle.ensure(), /provider_runtime_exited:runtime_profile_endpoint_occupied/)
})

test('a child that reports nothing keeps the plain exit category', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: 43211, exitCode: null, killed: false,
    kill() { this.killed = true; this.emit('exit', 0) },
  })
  const lifecycle = new GatewayLifecycle({ entry: 'entry.mjs', runtimeExecutable: 'fork.exe',
    runtimeData: 'isolated', key: 'm'.repeat(40), port: 45861, node: process.execPath }, {
    launcher: () => child,
    fetcher: async () => { throw new Error('not_listening_yet') },
    clock: async () => { child.exitCode = 1; child.emit('exit', 1) },
  })
  await assert.rejects(lifecycle.ensure(), error => error.message === 'provider_runtime_exited')
})
