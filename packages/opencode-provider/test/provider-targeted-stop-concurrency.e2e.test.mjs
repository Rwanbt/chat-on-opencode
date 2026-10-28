import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { createGateway, stableUUID } from '../src/gateway.mjs'

test('cancelled renderer stream stops exact CoS turn without stopping a concurrent session or sending residual SSE', { timeout:12000 }, async t => {
  const key='k'.repeat(48)
  const sends=[],stops=[],released=[]
  let releaseA,enterA
  const aReady=new Promise(resolve => {enterA=resolve})
  const stallA=new Promise(resolve => {releaseA=resolve})
  const control={
    async hasSession(){return true}, async assertReady(){},
    async send(input){sends.push(input)},
    async stop(...args){stops.push(args);return {stopped:true}},
    async cancelInput(){throw Error('proven_turn_must_stop_by_turn_id')},
    async *events(sessionID){
      const id=sends.find(x=>x.sessionId===sessionID)?.id
      const turn=sessionID===stableUUID('session:cancel-A')?'turn-a':'turn-b'
      yield {kind:'user_message',inputId:id}
      yield {kind:'turn_start',turnId:turn,inputId:id}
      if(turn==='turn-a'){
        yield {kind:'assistant_message',turnId:turn,message:{text:'PARTIAL-A'}}
        enterA()
        await stallA
        yield {kind:'assistant_message',turnId:turn,message:{text:'PARTIAL-A-RESIDUAL'}}
        released.push('a_tail_reached')
      }else{
        yield {kind:'assistant_message',turnId:turn,message:{text:'SAFE-B'}}
        yield {kind:'turn_end',turnId:turn,outcome:'completed',seq:4}
      }
    },
  }
  const gateway=createGateway({control,key})
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening')
  t.after(async()=>{releaseA();gateway.closeAllConnections();await new Promise(r=>gateway.close(r))})
  const uri='http://127.0.0.1:'+gateway.address().port+'/v1/chat/completions'
  const run=(session,message,stream)=> {
    let req
    const promise=new Promise((resolve,reject)=>{
      req=httpRequest(uri,{method:'POST',headers:{
        authorization:'Bearer '+key,'content-type':'application/json',
        'x-opencode-session-id':session,'x-opencode-message-id':message,
      }},res=>{
        let body=''
        res.on('data',chunk=>{body+=chunk.toString()})
        res.once('end',()=>resolve({status:res.statusCode,body}))
        res.once('aborted',()=>reject(Error('client_aborted')))
        res.once('error',reject)
      })
      req.once('error',reject)
      req.end(JSON.stringify({model:'chatgpt-default',stream,
        messages:[{role:'user',content:'test '+session}]}))
    })
    return {promise,abort:()=>req.destroy(Error('user_pressed_Stop'))}
  }
  const a=run('cancel-A','msg-a001',true)
  a.promise.catch(()=>undefined)
  await Promise.race([aReady,new Promise((_,reject)=>setTimeout(()=>reject(Error('a_never_streamed')),3000))])
  a.abort()
  await assert.rejects(a.promise,/user_pressed_Stop|client_aborted|ECONNRESET/)
  const b=await Promise.race([run('cancel-B','msg-b001',false).promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('other_session_blocked')),3000))])
  assert.equal(b.status,200)
  assert.match(b.body,/SAFE-B/)
  await new Promise(resolve=>setTimeout(resolve,50))
  assert.deepEqual(stops,[[stableUUID('session:cancel-A'),'turn-a']])
  assert.equal(sends.length,2)
  assert.equal(released.includes('a_tail_reached'),false,'no residual after Stop before stalled producer release')
})
