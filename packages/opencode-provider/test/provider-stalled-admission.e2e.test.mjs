import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { createGateway } from '../src/gateway.mjs'

test('cancelled stalled admission and cancellation acknowledgement release the native session lease', { timeout: 6000 }, async t => {
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  const forever = new Promise(() => {})
  let sendCount = 0
  let cancellation = 0
  const control = {
    async hasSession() { return true }, async assertReady() {},
    send() { if (++sendCount === 1) { enter(); return forever } },
    cancelInput() { cancellation++; return forever },
    async *events() {
      yield {kind:'user_message',inputId: lastId}
      yield {kind:'turn_start',turnId:'turn-2'}
      yield {kind:'assistant_message',turnId:'turn-2',message:{text:'SECOND-OK'}}
      yield {kind:'turn_end',turnId:'turn-2',outcome:'completed'}
    },
  }
  let lastId = ''
  const originalSend = control.send
  control.send = function (value) { lastId = value.id; return originalSend() }
  const key = 's'.repeat(48)
  const server = createGateway({control,key})
  server.listen(0,'127.0.0.1'); await once(server,'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions'
  function send(id) {
    const req = httpRequest(url,{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json','x-opencode-session-id':'restart-test','x-opencode-message-id':id}})
    const result = new Promise((resolve,reject)=>{req.on('response',res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve([res.statusCode,body]))});req.on('error',reject)})
    req.end(JSON.stringify({model:'chatgpt-default',stream:false,messages:[{role:'user',content:id}]}))
    return {req,result}
  }
  const first = send('message-stalled-001'); first.result.catch(()=>{})
  await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error('send_not_entered')),1000))])
  first.req.destroy()
  await new Promise(resolve=>setTimeout(resolve,40))
  const second = await Promise.race([send('message-second-002').result,new Promise((_,reject)=>setTimeout(()=>reject(Error('lease_blocked')),1200))])
  assert.equal(second[0],200)
  assert.match(second[1],/SECOND-OK/)
  assert.equal(sendCount,2)
  assert.equal(cancellation,1)
})
