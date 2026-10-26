import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeSIWCMethod, registerNativeSIWC, stableSIWCHost } from '../plugin/native-siwc.mjs'

const host = 'urn:uuid:2461e969-229d-4c8d-b125-30c901171d56'
const granted = () => ({
  canUsePlan: true, clientID: 'oaiapp_synthetic_client', subject: 'synthetic-subject',
  issuer: 'https://auth.openai.com', scopes: ['resource.invoke','chatgpt.tokens.use.direct'],
  accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
  expiresAt: Date.now() + 120_000,
})

test('registration is inert until explicit OAuth authorize is requested', async () => {
  let started = 0, exchanged = 0, cancelled = 0
  const method = nativeSIWCMethod(host, {
    start: async ({ hostID }) => {
      started++
      assert.equal(hostID, host)
      return { authorizeURL: 'https://auth.openai.com/api/accounts/authorize',
        result: Promise.resolve({ code: 'synthetic' }), cancel: () => { cancelled++ } }
    },
    exchange: async ({ callback }) => { exchanged++; assert.equal(callback.code, 'synthetic'); return granted() },
  })
  assert.deepEqual(method.method, { id: 'chatgpt', type: 'oauth', label: 'Continue with ChatGPT' })
  assert.equal(method.integrationID, 'chat-on-opencode')
  assert.equal(Object.hasOwn(method, 'refresh'), false,
    'do not wire rotating refresh until cross-process credential replacement is atomic')
  assert.deepEqual([started,exchanged,cancelled],[0,0,0])
  const authorization = await method.authorize()
  assert.equal(authorization.mode, 'auto')
  assert.equal(started, 1)
  assert.equal(typeof authorization.callback?.then, 'function')
  const credential = await authorization.callback
  assert.equal(credential.type, 'oauth')
  assert.equal(credential.methodID, 'chatgpt')
  assert.equal(credential.metadata.subject, 'synthetic-subject')
  assert.equal(credential.refresh, 'synthetic-refresh')
  assert.deepEqual([started,exchanged,cancelled],[1,1,1])
})

test('missing direct plan consent never persists credential and cancels callback', async () => {
  let cancelled = false
  const method = nativeSIWCMethod(host, {
    start: async () => ({ authorizeURL: 'https://auth.openai.com/api/accounts/authorize',
      result: Promise.resolve({ code: 'synthetic' }), cancel: () => { cancelled = true } }),
    exchange: async () => ({ ...granted(), canUsePlan: false }),
  })
  await assert.rejects((await method.authorize()).callback, /siwc_plan_permission_missing/)
  assert.equal(cancelled, true)
})

test('native registration removes only its own fallback key method', async () => {
  const data = new Map([['siwc.host-id', host]])
  let otherRemoved = false
  const methods = [{type:'key',label:'API key'}, {type:'external',id:'other',label:'Unrelated connection'}]
  const registered = []
  const editor = {
    get: id => id === 'chat-on-opencode' ? {name:'Chat On OpenCode'} : undefined,
    method: {
      update(value) { registered.push(value) },
      list(id) { assert.equal(id,'chat-on-opencode');return [...methods] },
      remove(id,value) {
        assert.equal(id,'chat-on-opencode')
        if (value.type !== 'key') otherRemoved = true
        methods.splice(methods.indexOf(value),1)
      },
    },
  }
  const ctx = { storage: { get: async k => data.get(k), set: async (k,v) => { data.set(k,v) } },
    integration: { transform: async callback => callback(editor) } }
  assert.equal(await registerNativeSIWC(ctx),true)
  assert.equal(registered.length,1)
  assert.equal(registered[0].method.type,'oauth')
  assert.equal(otherRemoved,false)
  assert.equal(methods.length,1)
})

test('host identity is stable and invalid stored state fails closed', async () => {
  const data = new Map()
  const storage = { get: async k => data.get(k), set: async (k,v) => { data.set(k,v) } }
  const first = await stableSIWCHost(storage)
  assert.match(first,/^urn:uuid:[0-9a-f-]{36}$/)
  assert.equal(await stableSIWCHost(storage),first)
  data.set('siwc.host-id','known-user-email@example.com')
  await assert.rejects(stableSIWCHost(storage),/siwc_host_id_invalid/)
})

test('method registration survives integrations being reconstructed after plugin setup', async () => {
  const methods = []
  const ctx = { storage: {get:async()=>host,set:async()=>{}},
    integration: {transform:async f=>f({get:()=>undefined,method:{
      update:input=>methods.push(input),list:()=>[],remove:()=>{throw Error('not expected')},
    }})} }
  assert.equal(await registerNativeSIWC(ctx),true)
  assert.deepEqual(methods.map(input=>[input.integrationID,input.method.type]),
    [['chat-on-opencode','oauth']])
})
