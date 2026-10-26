import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { registerLiveNativeText, nativeSIWCTextAccount } from '../plugin/native-responses.mjs'
import { registerNativeHTTPText } from '../plugin/native-text-http.mjs'

const subject = 'synthetic-account-42', model = 'synthetic-model-a'
const token = 'synthetic_oauth_token_1234'
const fake = (override = {}) => ({ type: 'oauth', methodID: 'chatgpt',
  access: token, expires: Date.now() + 60_000,
  metadata: { issuer: 'https://auth.openai.com', subject,
    clientID: 'oaiapp_synthetic_client', scopes: 'openid resource.invoke chatgpt.tokens.use.direct' },
  ...override })
const integration = (credential = fake()) => ({ connection: {
  active: async () => ({ type: 'credential', id: 'synthetic-account-ref' }),
  resolve: async () => credential,
} })
const prompt = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Salut' }] }], tools: [] }

test('opted-in native text resolves actual credential, loads eligible models and produces no-store Responses', async t => {
  const requests = []
  const service = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token)
    requests.push(req.url)
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ models: [
        { slug: model, display_name: 'Synthetic Test', visibility: 'list' },
        { slug: 'hidden-model', display_name: 'Not allowed', visibility: 'hidden' },
      ] }))
      return
    }
    assert.equal(req.url, '/v1/responses')
    const parts = []
    for await (const chunk of req) parts.push(chunk)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    assert.equal(body.model, model)
    assert.equal(body.store, false)
    assert.equal(body.stream, true)
    assert.equal(body.tools, undefined)
    res.setHeader('content-type', 'text/event-stream')
    res.end('event: response.completed\ndata: '+JSON.stringify({ type:'response.completed',
      response: { status:'completed', model,
        output:[{ type:'message', role:'assistant', content:[{ type:'output_text', text:'FIRST_TEXT_OK' }] }] } })+'\n\ndata: [DONE]\n\n')
  })
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
  t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)) })
  const endpoint = `http://127.0.0.1:${service.address().port}`
  const ctx = { options: { nativeOAuth:'preview', nativeInference:'text' },
    integration: integration(), aisdk: { language: async fn => { ctx.hook = fn } } }
  await registerLiveNativeText(ctx, { fetchImpl: fetch,
    modelsEndpoint: endpoint+'/v1/models', endpoint: endpoint+'/v1/responses', allowLoopbackTest: true })
  const event = { model: { providerID:'chat-on-opencode', api: { id: model } }, sdk: {} }
  ctx.hook(event)
  const { stream } = await event.language.doStream(prompt)
  const parts = []
  for await (const part of stream) parts.push(part)
  assert.equal(parts.find(p => p.type === 'text-delta')?.delta, 'FIRST_TEXT_OK')
  assert.deepEqual(requests, ['/v1/models','/v1/responses'])
})

test('real native text mode rejects API-key or unknown model before Responses request', async () => {
  const missing = integration({ type:'key', key:'not-oauth' })
  await assert.rejects(nativeSIWCTextAccount(missing)({modelID:model}), /native_oauth_credential_unverified/)
  const ctx = {options:{nativeOAuth:'preview',nativeInference:'read'},integration:integration(),aisdk:{language:async()=>{}}}
  await assert.rejects(registerLiveNativeText(ctx), /native_text_consent_required/)
})

test('stateless native transport nonce never gives tools, file or session authority', async () => {
  const ctx = { options:{ nativeOAuth:'preview', nativeInference:'text' },integration:integration(),
    aisdk:{ language: async fn => { ctx.hook=fn } } }
  await registerLiveNativeText(ctx)
  const event = {model:{providerID:'chat-on-opencode',api:{id:model}},sdk:{}}
  ctx.hook(event)
  await assert.rejects(event.language.doStream({ ...prompt,
    tools: [{ type:'function',name:'write-file' }] }), /native_text_only_required/)
  await assert.rejects(event.language.doStream({ prompt:[{role:'user',content:[{
    type:'file',data:Buffer.from('secret'), mediaType:'text/plain' }]}] }), /native_unsupported_context/)
})

test('native 2.1.4 HTTP hooks validate account/model and normalize no-store text-only request', async () => {
  const registered={}
  const base='http://127.0.0.1:45861/v1'
  const context={options:{nativeOAuth:'preview',nativeInference:'text'},
    integration:integration(),provider:{get:async()=>({data:{package:'@opencode/ai/providers/openai'}})},
    session:{hook:async(name,callback)=>{registered[name]=callback}},
  }
  await registerNativeHTTPText(context,{baseURL:base, modelsEndpoint:base+'/models',
    allowLoopbackTest:true,fetchImpl:async()=>new Response(JSON.stringify({models:[
      {slug:model,display_name:'Synthetic',visibility:'list'}]}),{
        headers:{'content-type':'application/json'}})})
  const selection={model:{providerID:'chat-on-opencode',id:model},kind:'primary',headers:{}}
  await registered['model.request'](selection)
  assert.equal(selection.baseURL,base)
  assert.equal(selection.headers.Authorization,'Bearer '+token)
  const body={model,input:[{role:'user',content:[{type:'input_text',text:'safe text'}]}],
    store:false,stream:true,max_output_tokens:999,temperature:0.8,metadata:{private:'x'},tools:[]}
  const request=(data,url=base+'/responses')=>({model:selection.model,kind:'primary',
    request:new Request(url,{method:'POST',headers:{Authorization:'Bearer '+token},
      body:JSON.stringify(data)})})
  const event=request(body)
  await registered['http.request'](event)
  const clean=await event.request.json()
  assert.equal(clean.store,false)
  assert.equal(clean.stream,true)
  assert.equal(clean.max_output_tokens,undefined)
  assert.equal(clean.temperature,undefined)
  assert.equal(clean.metadata,undefined)
  assert.equal(clean.tools,undefined)
  for(const invalid of [{...body,tools:[{type:'function',name:'shell'}]},
    {...body,input:[{type:'function_call',name:'bash'}]},
    {...body,model:'other-model'},
    {...body,store:true}]) {
    await assert.rejects(registered['http.request'](request(invalid)),
      /siwc_native_text_request_rejected/)
  }
  await assert.rejects(registered['http.request'](request(body,base+'/chat/completions')),
    /siwc_native_text_request_rejected/)
})

test('native HTTP response gate refuses failed/incomplete/tool SSE before native parser', async () => {
  const calls={}
  const ctx={options:{nativeOAuth:'preview',nativeInference:'text'},integration:integration(),
    session:{hook:async(name,callback)=>{calls[name]=callback}}}
  await registerNativeHTTPText(ctx)
  const selected={providerID:'chat-on-opencode',id:model}
  const event=(body)=>({kind:'primary',model:selected,
    response:new Response(body,{headers:{'content-type':'text/event-stream'}})})
  const valid='event: response.completed\ndata: '+JSON.stringify({type:'response.completed',
    response:{status:'completed',model,output:[{type:'message',role:'assistant',
      content:[{type:'output_text',text:'OK'}]}]}})+'\n\ndata: [DONE]\n\n'
  const succeeded=event(valid)
  await calls['http.response'](succeeded)
  assert.equal((await succeeded.response.text()).includes('response.completed'),true)
  await assert.rejects(calls['http.response'](event('event: response.failed\ndata: {"type":"response.failed"}\n\n')))
  await assert.rejects(calls['http.response'](event('event: response.output_text.delta\ndata: {"delta":"UNVERIFIED"}\n\n')))
})
