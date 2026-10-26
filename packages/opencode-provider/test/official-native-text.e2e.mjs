import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const official = process.env.CHAT_ON_OPENCODE_TEST_CLI
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = path.join(root, 'test', 'fixtures', 'native-siwc-text')

function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/F','/T','/PID',String(child.pid)],
    {windowsHide:true,shell:false,timeout:5000})
  else child.kill('SIGTERM')
}

test('actual official OpenCode 2.1.4 native OpenAI text turn reaches synthetic authorized Responses HTTP', {
  skip: !official ? 'Set CHAT_ON_OPENCODE_TEST_CLI to installed official binary' : false,
  timeout: 60000,
}, async t => {
  assert.ok(path.isAbsolute(official) && existsSync(official))
  const received = []
  const model = 'synthetic-gpt-model'
  const server = createServer(async (req,res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-native-cli-token-12345')
    received.push(req.url)
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type','application/json')
      return res.end(JSON.stringify({ models: [{ slug:model, display_name:'Synthetic Test', visibility:'list' }] }))
    }
    assert.equal(req.url,'/v1/responses')
    const parts=[]
    for await (const part of req) parts.push(part)
    const body=JSON.parse(Buffer.concat(parts).toString('utf8'))
    assert.equal(body.model,model)
    assert.equal(body.store,false)
    assert.equal(body.stream,true)
    assert.equal(body.tools,undefined)
    assert.ok(JSON.stringify(body.input).includes('SYNTHETIC_FIRST_TEXT') ||
      JSON.stringify(body.input).includes('title'), 'native protocol sent unexpected prompt')
    const id='resp_synthetic_001', itemID='msg_synthetic_001', text='NATIVE_SIWC_TEXT_OK'
    const item={ id:itemID,type:'message',role:'assistant',status:'completed',
      content:[{type:'output_text',text,annotations:[]}] }
    const base={id,object:'response',created_at:Math.floor(Date.now()/1000),model,
      status:'completed',output:[item],usage:{input_tokens:10,output_tokens:4,total_tokens:14}}
    const frames=[
      {type:'response.created',response:{...base,status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
      {type:'response.content_part.added',item_id:itemID,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
      {type:'response.output_text.delta',item_id:itemID,output_index:0,content_index:0,delta:text},
      {type:'response.output_text.done',item_id:itemID,output_index:0,content_index:0,text},
      {type:'response.content_part.done',item_id:itemID,output_index:0,content_index:0,part:item.content[0]},
      {type:'response.output_item.done',output_index:0,item},
      {type:'response.completed',response:base},
    ].map((data,i)=>{data.sequence_number=i;return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`})
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    res.end(frames.join('')+'data: [DONE]\n\n')
  })
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve))
  t.after(async () => {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const endpoint=`http://127.0.0.1:${server.address().port}`
  const tmp=await mkdtemp(path.join(os.tmpdir(),'coo-native-text-'))
  const paths=['home','data','cache','config','workspace','appdata','localappdata']
  for (const item of paths) await mkdir(path.join(tmp,item))
  const safe={}
  for(const [key,value] of Object.entries(process.env)){
    if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) safe[key]=value
  }
  const configuration={
    plugins:[{package:fixture,options:{testEndpoint:endpoint,testMarker:path.join(tmp,'native-stage.txt')}}],
    providers:{'chat-on-opencode':{name:'Chat On OpenCode Test',
      package:'aisdk:@ai-sdk/openai',
      settings:{baseURL:'http://127.0.0.1:1/v1'},
      models:{[model]:{name:'Synthetic SIWC Text',capabilities:{tools:false,input:['text'],output:['text']},
        limit:{context:16384,output:1024}}}}},
  }
  Object.assign(safe,{HOME:path.join(tmp,'home'),USERPROFILE:path.join(tmp,'home'),
    APPDATA:path.join(tmp,'appdata'),LOCALAPPDATA:path.join(tmp,'localappdata'),
    XDG_CONFIG_HOME:path.join(tmp,'config'),XDG_DATA_HOME:path.join(tmp,'data'),
    XDG_CACHE_HOME:path.join(tmp,'cache'),OPENCODE_CONFIG_DIR:path.join(tmp,'config'),
    OPENCODE_CONFIG_CONTENT:JSON.stringify(configuration),OPENCODE_CONFIG_PROJECT_DISABLE:'1',
    OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS:'1', OPENCODE_SERVER_PASSWORD:randomBytes(24).toString('hex')})
  let child
  try {
    child=spawn(official,['run','--standalone','--format','json','--model',
      'chat-on-opencode/'+model,'SYNTHETIC_FIRST_TEXT'],{
      cwd:path.join(tmp,'workspace'),env:safe,shell:false,windowsHide:true,
      stdio:['ignore','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.on('data',d=>{if(stdout.length<160000)stdout+=String(d)})
    child.stderr.on('data',d=>{if(stderr.length<16000)stderr+=String(d)})
    const deadline=Date.now()+6500
    while(!stdout.includes('NATIVE_SIWC_TEXT_OK') && child.exitCode===null && Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,200))
    }
    const publicEvents=stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
    const success=publicEvents.some(event=>event.type==='text' &&
      event.part?.text?.includes('NATIVE_SIWC_TEXT_OK'))
    let diagnosticsLog=''
    const folder=path.join(tmp,'data','opencode','log')
    for(const file of (await readdir(folder).catch(()=>[])).slice(-3)){
      diagnosticsLog+=(await readFile(path.join(folder,file),'utf8').catch(()=>''))
    }
    const mask=x=>String(x).replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
      .replace(/synthetic-native-cli-token-12345/g,'[synthetic-token]')
      .replace(/([a-zA-Z]:\\)[^\s]+/g,'[test-path]')
    const stage=(await readFile(path.join(tmp,'native-stage.txt'),'utf8').catch(()=>''))
    const diagnostics=JSON.stringify({exit:child.exitCode,received,stage,events:publicEvents.map(e=>({
      type:e.type,part:e.part?.type,error:e.error?String(e.error).slice(0,200):undefined})),
      tail:mask(stdout).slice(-1600),logs:mask(diagnosticsLog.split(/\r?\n/)
        .filter(x=>/plugin|error|fail|aisdk|language|auth/i.test(x)).slice(-16).join('\n')).slice(-2300),
      stderrBytes:stderr.length,stdoutBytes:stdout.length})
    assert.ok(success,'Official native text answer missing: '+diagnostics)
    assert.deepEqual(received,['/v1/models','/v1/responses'])
    assert.doesNotMatch(stdout+stderr,/synthetic-native-cli-token-12345/)
  }finally{
    stopOwned(child)
    await new Promise(resolve=>setTimeout(resolve,300))
    await rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})
