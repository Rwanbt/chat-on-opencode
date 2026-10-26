import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerEffectSIWC } from '../plugin/siwc-effect-bridge.mjs'

// Deterministic structural Effect interpreter: callbacks MUST yield Effects,
// not Promises; scope finalizers run only when the simulated host scope closes.
class Fx {
  constructor(run) { this.run = run }
  *[Symbol.iterator]() { return yield this }
}
const Effect = {
  gen: fn => new Fx(async scope => {
    const iterator = fn()
    let value
    for (;;) {
      const step = iterator.next(value)
      if (step.done) return step.value
      value = await step.value.run(scope)
    }
  }),
  tryPromise: ({ try: action, catch: onError }) => new Fx(async () => {
    try { return await action() } catch (error) { throw onError(error) }
  }),
  acquireRelease: (acquire, release) => new Fx(async scope => {
    const value = await acquire.run(scope)
    scope.finalizers.push(() => release(value).run(scope))
    return value
  }),
  sync: fn => new Fx(async () => fn()),
}
async function scopeRun(effect, scope = { finalizers: [] }) {
  assert.ok(effect instanceof Fx, 'must return Effect.Effect, never Promise')
  return effect.run(scope)
}
async function dispose(scope) {
  for (const done of scope.finalizers.reverse()) await done()
}

const host = 'urn:uuid:ca5e2c9b-c77c-4d91-8f4b-0e395d3dcb38'
const grant = () => ({ canUsePlan: true, issuer: 'https://auth.openai.com',
  clientID: 'oaiapp_synthetic_999', subject: 'synthetic-sub',
  scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'],
  accessToken: 'synthetic-secret-access', refreshToken: 'synthetic-refresh',
  expiresAt: Date.now() + 120_000 })

function fixture({ missing = false, persistedHost = host, exchange = async () => grant() } = {}) {
  const storage = new Map(persistedHost ? [['siwc.host-id', persistedHost]] : [])
  const methods = [{ type: 'key', id: 'key' }, { type: 'external', id: 'unrelated' }]
  const registered = []
  const events = { started: 0, exchanged: 0, cancelled: 0, transforms: 0 }
  const ctx = {
    storage: {
      get: key => Effect.sync(() => storage.get(key)),
      set: (key, value) => Effect.sync(() => { storage.set(key, value) }),
    },
    integration: {
      transform: mutate => Effect.sync(() => {
        events.transforms++
        mutate({ get: () => missing ? undefined : { name: 'Chat On OpenCode' },
          method: { update: value => registered.push(value),
            list: () => [...methods], remove: (_, value) => methods.splice(methods.indexOf(value), 1) } })
      }),
    },
  }
  const start = async ({ hostID }) => {
    events.started++
    assert.equal(hostID, storage.get('siwc.host-id'))
    return { authorizeURL: 'https://auth.openai.com/api/accounts/authorize?state=fake',
      result: Promise.resolve({ code: 'synthetic_code' }),
      cancel: () => { events.cancelled++ } }
  }
  const exchanged = async arg => { events.exchanged++; assert.equal(arg.callback.code, 'synthetic_code'); return exchange() }
  return { ctx, storage, methods, registered, events, start, exchange: exchanged }
}

test('opt-in false leaves integration and credential store untouched', async () => {
  const f = fixture({ persistedHost: null })
  assert.equal(await scopeRun(registerEffectSIWC({ Effect, ...f, preview: false })), false)
  assert.equal(f.storage.size, 0)
  assert.equal(f.events.transforms, 0)
  assert.equal(f.events.started, 0)
})

test('native OAuth metadata registers in Effect transform and key fallback removed', async () => {
  const f = fixture()
  assert.equal(await scopeRun(registerEffectSIWC({ Effect, ...f, preview: true })), true)
  assert.equal(f.registered.length, 1)
  assert.deepEqual(f.registered[0].method, {
    id: 'chatgpt', type: 'oauth', label: 'Continue with ChatGPT' })
  assert.equal(f.methods.length, 1)
  assert.equal(f.methods[0].id, 'unrelated')
  assert.equal(f.events.started, 0, 'registry setup may not begin login')
  const s = { finalizers: [] }
  const auth = await scopeRun(f.registered[0].authorize(), s)
  assert.equal(auth.mode, 'auto')
  assert.ok(auth.callback instanceof Fx)
  assert.equal(f.events.exchanged, 0)
  const credential = await scopeRun(auth.callback, s)
  assert.equal(credential.type, 'oauth')
  assert.equal(credential.methodID, 'chatgpt')
  assert.deepEqual(credential.metadata, { clientID: 'oaiapp_synthetic_999',
    subject: 'synthetic-sub', issuer: 'https://auth.openai.com',
    scopes: 'resource.invoke chatgpt.tokens.use.direct' })
  await dispose(s)
  assert.deepEqual([f.events.started, f.events.exchanged, f.events.cancelled], [1, 1, 1])
  await assert.rejects(scopeRun(auth.callback, s), /siwc_callback_unverified/)
})

test('spoofed grants and unapproved scopes cannot produce native stored OAuth credential', async () => {
  for (const forged of [{ canUsePlan: false }, { scopes: ['resource.invoke'] },
    { issuer: 'https://attacker.test' }, { clientID: 'dynamic_agent_client' },
    { expiresAt: 0 }, { refreshToken: '' }, { subject: '' }]) {
    const f = fixture({ exchange: async () => ({ ...grant(), ...forged }) })
    await scopeRun(registerEffectSIWC({ Effect, ...f, preview: true }))
    const s = { finalizers: [] }
    const auth = await scopeRun(f.registered[0].authorize(), s)
    await assert.rejects(scopeRun(auth.callback, s), /siwc_callback_unverified/)
    await dispose(s)
    assert.equal(f.events.cancelled, 1)
  }
})

test('unknown native provider and invalid retained host refuse registration', async () => {
  const missing = fixture({ missing: true })
  await assert.rejects(scopeRun(registerEffectSIWC({ Effect, ...missing, preview: true })), /siwc_integration_missing/)
  const forged = fixture({ persistedHost: 'urn:uuid:00000000-0000-0000-0000-000000000000' })
  await assert.rejects(scopeRun(registerEffectSIWC({ Effect, ...forged, preview: true })), /siwc_host_id_invalid/)
  assert.equal(forged.events.transforms, 0)
})

test('stable host UUID is generated once through host Effect storage', async () => {
  const f = fixture({ persistedHost: null })
  await scopeRun(registerEffectSIWC({ Effect, ...f, preview: true }))
  assert.match(f.storage.get('siwc.host-id'), /^urn:uuid:[0-9a-f-]{36}$/)
  const prior = f.storage.get('siwc.host-id')
  await scopeRun(registerEffectSIWC({ Effect, ...f, preview: true }))
  assert.equal(f.storage.get('siwc.host-id'), prior)
})

test('real V2 contexts without storage require a separately provisioned stable host ID', async () => {
  const f = fixture()
  delete f.ctx.storage
  assert.throws(() => registerEffectSIWC({ Effect, ...f, preview: true }), /siwc_effect_capability_missing/)
  assert.equal(await scopeRun(registerEffectSIWC({ Effect, ...f, preview: true, hostID: host })), true)
  assert.equal(f.events.started, 0)
})
