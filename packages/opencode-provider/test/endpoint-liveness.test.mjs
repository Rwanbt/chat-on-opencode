import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CoSRuntime } from '../src/runtime.mjs'
import { endpointHasLiveOwner, probeLoopbackPort } from '../src/endpoint-liveness.mjs'

const validProviderConfig = JSON.parse(await readFile(new URL('./fixtures/valid-provider-config.json', import.meta.url), 'utf8'))

const profile = async (t, name) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), name))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await writeFile(path.join(folder, 'config.json'), JSON.stringify(validProviderConfig))
  const controlDir = path.join(folder, 'control-api')
  await mkdir(controlDir)
  return { folder, controlDir }
}

test('a control API that answers on its port is a live owner', async t => {
  const server = createServer((request, response) => response.end('{}'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  assert.equal(await endpointHasLiveOwner({ port: server.address().port }), true)
})

test('nothing listening on the recorded port means the endpoint is stale', async () => {
  const server = createServer(() => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  assert.equal(await endpointHasLiveOwner({ port }), false)
})

test('an endpoint without a usable port is treated as live', async () => {
  assert.equal(await endpointHasLiveOwner({ port: 0 }), true)
  assert.equal(await endpointHasLiveOwner({ port: 70000 }), true)
  assert.equal(await endpointHasLiveOwner({}), true)
})

test('the port probe never leaves a socket open and never crashes on a late error', async () => {
  const server = createServer(() => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  assert.equal(await probeLoopbackPort(port), true)
  await new Promise(resolve => server.close(resolve))
  assert.equal(await probeLoopbackPort(port), false)
})

test('a stale endpoint whose pid was recycled does not brick the isolated profile', async t => {
  const { folder, controlDir } = await profile(t, 'cos-recycled-pid-')
  // The recorded pid is alive, but it belongs to an unrelated process: the
  // helper was terminated and the pid was reused. The control API it named is
  // gone, so the endpoint is stale and must not refuse a new runtime.
  await writeFile(path.join(controlDir, 'endpoint.json'),
    JSON.stringify({ protocol: 1, pid: process.pid, port: 23001 }))
  let launched = false
  const runtime = new CoSRuntime({ executable: process.execPath, profile: folder }, {
    launcher: () => { launched = true; throw new Error('must_not_spawn_in_this_test') },
    probe: async () => false,
  })
  await assert.rejects(runtime.start(), /must_not_spawn_in_this_test/)
  assert.equal(launched, true, 'a stale endpoint must not block the profile')
})

test('a live control API still refuses a second runtime before a child is launched', async t => {
  const { folder, controlDir } = await profile(t, 'cos-live-owner-')
  await writeFile(path.join(controlDir, 'endpoint.json'),
    JSON.stringify({ protocol: 1, pid: process.pid, port: 23001 }))
  let launched = false
  const runtime = new CoSRuntime({ executable: process.execPath, profile: folder }, {
    launcher: () => { launched = true; throw new Error('must_not_spawn') },
    probe: async () => true,
  })
  await assert.rejects(runtime.start(), /runtime_profile_endpoint_occupied/)
  assert.equal(launched, false)
  assert.equal(JSON.parse(await readFile(path.join(controlDir, 'endpoint.json'), 'utf8')).pid, process.pid)
})

test('the default probe finds a real live control API and a real dead one', async t => {
  const server = createServer(() => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  t.after(() => server.close())
  assert.equal(await endpointHasLiveOwner({ port }), true)
  await new Promise(resolve => server.close(resolve))
  assert.equal(await endpointHasLiveOwner({ port }), false)
})
