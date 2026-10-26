import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createOpenCodeConfig } from '../src/config.mjs'

const official = process.env.CHAT_ON_OPENCODE_TEST_CLI
const bundle = fileURLToPath(new URL('..', import.meta.url))
const portFromOS = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
function stopOwned(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
      shell: false, windowsHide: true, timeout: 5000,
    })
  } else if (child.pid) child.kill('SIGTERM')
}
test('official OpenCode 2.1.4 exposes native ChatGPT OAuth method only with preview opt-in', {
  skip: !official ? 'Set CHAT_ON_OPENCODE_TEST_CLI to an installed official binary' : false,
  timeout: 65_000,
}, async () => {
  assert.ok(path.isAbsolute(official) && existsSync(official))
  const root = await mkdtemp(path.join(os.tmpdir(), 'coo-siwc-native-official-'))
  let child
  try {
    for (const name of ['home','config','data','cache','appdata','localappdata','workspace','provider']) {
      await mkdir(path.join(root,name))
    }
    const executable = path.join(root, process.platform === 'win32' ? 'offline-runtime.exe' : 'offline-runtime')
    await writeFile(executable, 'Offline test: never launched')
    await writeFile(path.join(root,'provider','config.json'), JSON.stringify({
      ui:{chatBrowser:'cos'},controlApi:{enabled:true,allowActions:true},
    }))
    const port=await portFromOS(), gatewayPort=await portFromOS()
    const serverPassword=randomBytes(24).toString('base64url')
    const config=createOpenCodeConfig({runtimeExecutable:executable,
      runtimeData:path.join(root,'provider'),nodeExecutable:process.execPath,pluginDir:bundle,port:gatewayPort})
    config.plugins[0].options.nativeOAuth = 'preview'
    const env={}
    for (const [name,value] of Object.entries(process.env)) {
      if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(name)) env[name]=value
    }
    Object.assign(env, { HOME:path.join(root,'home'), USERPROFILE:path.join(root,'home'),
      APPDATA:path.join(root,'appdata'), LOCALAPPDATA:path.join(root,'localappdata'),
      XDG_CONFIG_HOME:path.join(root,'config'),XDG_DATA_HOME:path.join(root,'data'),
      XDG_CACHE_HOME:path.join(root,'cache'),OPENCODE_CONFIG_DIR:path.join(root,'config'),
      OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_CONFIG_PROJECT_DISABLE:'1',
      OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS:'1',
      OPENCODE_SERVER_USERNAME:'opencode',OPENCODE_SERVER_PASSWORD:serverPassword })
    child=spawn(official,['serve','--hostname','127.0.0.1','--port',String(port)],{
      cwd:path.join(root,'workspace'),env,shell:false,windowsHide:true,
      stdio:['ignore','pipe','pipe'],
    })
    let stderr='',stdout='', lastHTTP='none'
    child.stderr.on('data',data=>{if(stderr.length<8_000) stderr+=String(data)})
    child.stdout.on('data',data=>{if(stdout.length<8_000) stdout+=String(data)})
    let methods, rawKeys, pluginStatus
    const basic={Authorization:'Basic '+Buffer.from('opencode:'+serverPassword).toString('base64')}
    const deadline=Date.now()+20_000
    let failedState
    while(Date.now()<deadline && child.exitCode===null) {
      try {
        const response=await fetch(`http://127.0.0.1:${port}/api/integration/chat-on-opencode`,{
          signal:AbortSignal.timeout(1500),redirect:'error',
          headers:basic,
        })
        lastHTTP=String(response.status)
        if(response.ok) {
          const value=await response.json()
          rawKeys=Object.keys(value.data ?? value)
          methods=value.data?.methods ?? value.methods
          if(methods?.some(m=>m.type==='oauth'&&m.id==='chatgpt')) break
        }
      }catch { /* wait only for this PID and loopback service */ }
      if(lastHTTP==='200') {
        try {
          const probe=await fetch(`http://127.0.0.1:${port}/api/plugin`,{
            signal:AbortSignal.timeout(1200),headers:basic,
          })
          if(probe.ok) {
            const payload=await probe.json()
            const own=(payload.data??[]).find(item=>item.id==='chat-on-opencode')
            if(own?.state?.status==='failed') {
              failedState=own.state
              break
            }
          }
        }catch { /* diagnostic check is optional */ }
      }
      await new Promise(resolve=>setTimeout(resolve,300))
    }
    try {
      const response=await fetch(`http://127.0.0.1:${port}/api/plugin`,{
        signal:AbortSignal.timeout(1500),headers:basic,
      })
      if(response.ok) {
        const payload=await response.json()
        pluginStatus=(payload.data??[]).filter(item=>item.id==='chat-on-opencode')
          .map(item=>({id:item.id,status:item.state?.status,reason:item.state?.reason}))
      }
    }catch { /* optional categorical diagnostics */ }
    let log=''
    const folder=path.join(root,'data','opencode','log')
    const logs=await readdir(folder).catch(()=>[])
    for(const file of logs.slice(-5)) {
      try {log+='\n'+await readFile(path.join(folder,file),'utf8')}catch{}
    }
    const relevantLog=log.split(/\r?\n/).filter(line=>/integration|chat-on-opencode|siwc|plugin.*fail/i.test(line))
      .slice(-10).map(line=>line.replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
        .replace(/[A-Z]:\\[^\s]+/gi,'[isolated-path]').slice(-450))
    const diagnostic=JSON.stringify({http:lastHTTP,stdoutBytes:stdout.length,stderrBytes:stderr.length,
      alive:child.exitCode===null,keys:rawKeys,
      methods:methods?.map(m=>({id:m.id,type:m.type})),plugins:pluginStatus,
      failure:failedState?JSON.stringify(failedState).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(-700):undefined,
      logFileCount:logs.length,relevantLog,
      logTail:log.slice(-1100).replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
        .replace(/[A-Z]:\\[^\s]+/gi,'[isolated-path]')})
    assert.ok(Array.isArray(methods),'official integration metadata unavailable: '+diagnostic)
    assert.ok(methods.some(m=>m.type==='oauth'&&m.id==='chatgpt'), 'native OAuth method missing: '+diagnostic)
    assert.equal(methods.some(m=>m.type==='key'),false,'fallback API key still displayed')
    // Exercise the exact native OAuth entry point without opening the returned
    // URL or supplying a real ChatGPT account. Cancel its owned attempt.
    let attemptID
    try {
      const response=await fetch(`http://127.0.0.1:${port}/api/integration/chat-on-opencode/connect/oauth`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(4500),
        headers:{...basic,'content-type':'application/json'},
        body:JSON.stringify({methodID:'chatgpt',answer:null,label:null}),
      })
      assert.equal(response.status,200,'native OAuth connect endpoint rejected the plugin method')
      const result=await response.json()
      const details=result.data
      assert.ok(details && typeof details.attemptID==='string')
      attemptID=details.attemptID
      // OAuth URLs and opaque state must never be logged by the test.
      const info=JSON.stringify(details)
      assert.match(info,/auth\.openai\.com/)
      assert.doesNotMatch(info,/https?:\/\/(?!auth\.openai\.com)[^\s]*access_token=/)
    } finally {
      if(attemptID) {
        const cancelled=await fetch(`http://127.0.0.1:${port}/api/integration/chat-on-opencode/connect/oauth/${encodeURIComponent(attemptID)}`,{
          method:'DELETE',headers:basic,redirect:'error',signal:AbortSignal.timeout(4000),
        })
        assert.equal(cancelled.status,204)
      }
    }
  } finally {
    stopOwned(child)
    await new Promise(resolve=>setTimeout(resolve,800))
    for(let i=0;i<8;i++) {
      try{await rm(root,{recursive:true,force:true,maxRetries:1,retryDelay:150});break}
      catch {await new Promise(resolve=>setTimeout(resolve,150))}
    }
  }
})
