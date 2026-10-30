import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { GatewayLifecycle } from '../src/lifecycle.mjs'
import { startService } from '../src/service.mjs'

// One process owns both the gateway listener and its isolated CoS runtime.
// If the broker dies, a gateway that keeps its IPC channel but stops listening
// is invisible to GatewayLifecycle: `child.exitCode === null` makes ensure()
// return early, so every later turn talks to a closed port until OpenCode is
// restarted. The owned process must terminate so its parent can respawn both.
function ownedOwner() {
  return Object.assign(new EventEmitter(), { channel: {}, connected: true })
}

test('a crashed CoS runtime terminates the owned gateway so its parent can respawn it', async () => {
  const owner = ownedOwner()
  const activity = []
  const child = new EventEmitter()
  const server = Object.assign(new EventEmitter(), {
    listen: () => activity.push('listen'),
    closeAllConnections: () => activity.push('connections_closed'),
    close: () => activity.push('server_closed'),
  })
  const runtime = {
    child,
    start: async () => ({}),
    stop: () => activity.push('runtime_stopped'),
  }
  await startService({
    runtime, owner, owned: true, port: 45861, key: 'a'.repeat(40),
    gatewayFactory: () => server, exit: code => activity.push('exit_' + code),
  })
  child.emit('exit', 1)
  assert.ok(activity.includes('exit_1'),
    'an owned gateway must not survive its runtime: ' + JSON.stringify(activity))
  assert.deepEqual(activity, ['listen', 'connections_closed', 'server_closed', 'runtime_stopped', 'exit_1'])
})

test('a legacy unowned service still only closes its listener when the runtime exits', async () => {
  const owner = new EventEmitter()
  const activity = []
  const child = new EventEmitter()
  const server = Object.assign(new EventEmitter(), {
    listen: () => activity.push('listen'),
    close: () => activity.push('server_closed'),
  })
  await startService({
    runtime: { child, start: async () => ({}), stop: () => activity.push('runtime_stopped') },
    owner, key: 'q'.repeat(40), port: 45861,
    gatewayFactory: () => server, exit: code => activity.push('exit_' + code),
  })
  child.emit('exit', 1)
  assert.deepEqual(activity, ['listen', 'server_closed'])
})

test('a deliberate stop still exits once when the broker dies as a consequence', async () => {
  // Parent shutdown kills the broker, and that broker exit now also reaches the
  // runtime-exit handler. It must not turn a clean stop into a second exit(1).
  const owner = ownedOwner()
  const activity = []
  const child = new EventEmitter()
  const server = Object.assign(new EventEmitter(), {
    listen: () => activity.push('listen'),
    closeAllConnections: () => activity.push('connections_closed'),
    close: () => activity.push('server_closed'),
  })
  await startService({
    runtime: { child, start: async () => ({}), stop: () => activity.push('runtime_stopped') },
    owner, owned: true, key: 's'.repeat(40), port: 45861,
    gatewayFactory: () => server, exit: code => activity.push('exit_' + code),
  })
  owner.emit('SIGTERM')
  child.emit('exit', 1)
  assert.deepEqual(activity, ['listen', 'connections_closed', 'server_closed', 'runtime_stopped', 'exit_0'])
})

test('after an owned gateway exits, the next ensure launches a fresh process instead of reusing it', async () => {
  const children = []
  const lifecycle = new GatewayLifecycle({
    entry: 'entry.mjs', runtimeExecutable: 'fork.exe', runtimeData: 'isolated',
    key: 'm'.repeat(40), node: process.execPath,
  }, {
    launcher: () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 5000 + children.length, exitCode: null, killed: false,
        kill() { this.killed = true; this.emit('exit', 0) },
      })
      children.push(child)
      return child
    },
    fetcher: async () => Response.json({ ok: true, gateway: 'chat-on-opencode', pid: children.at(-1).pid }),
  })
  await lifecycle.ensure()
  assert.equal(children.length, 1)
  // service.mjs terminates the owned gateway when its broker dies.
  children[0].exitCode = 1
  children[0].emit('exit', 1)
  await lifecycle.ensure()
  assert.equal(children.length, 2, 'a dead owned gateway must be respawned, never adopted')
  lifecycle.stop()
})
