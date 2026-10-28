/** Offline, disposable, actually packaged Electron cold-broker acceptance. No ChatGPT sign-in. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CoSRuntime } from '../packages/opencode-provider/src/runtime.mjs'

assert.equal(process.platform, 'win32', 'packaged test requires Windows')
const binary=path.resolve(process.env.COO_TEST_PACKAGED_EXE ?? 'release/provider/win-unpacked/Chat On OpenCode Provider.exe')
const profile=await mkdtemp(path.join(os.tmpdir(),'coo-offline-cold-broker-'))
const fixture=await readFile(new URL('../packages/opencode-provider/test/fixtures/valid-provider-config.json',import.meta.url))
await writeFile(path.join(profile,'config.json'),fixture)
let refused=0
const proxy=createServer((req,res)=>{refused++;res.writeHead(403);res.end()})
proxy.on('connect',(_req,socket)=>{refused++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')})
proxy.listen(0,'127.0.0.1');await once(proxy,'listening')
const proxyPort=proxy.address().port
const runtime=new CoSRuntime({executable:binary,profile,startupTimeoutMs:45000},{
 launcher:(exe,args,opts)=>spawn(exe,[...args,'--disable-quic','--disable-background-networking',
   `--proxy-server=127.0.0.1:${proxyPort}`,'--proxy-bypass-list=<-loopback>'],opts),
})
let ownedPid,connected=false,terminated=false
try {
 const control=await runtime.start()
 ownedPid=runtime.child?.pid
 assert.ok(Number.isSafeInteger(ownedPid)&&ownedPid>1)
 assert.equal(control.endpointPid,ownedPid)
 connected=true
} finally {
 runtime.stop()
 if(ownedPid){for(let i=0;i<80;i++) {try{process.kill(ownedPid,0)}catch{terminated=true;break}await delay(100)}}
 proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))
 await rm(profile,{recursive:true,force:true,maxRetries:30,retryDelay:200})
}
console.log('OFFLINE_COLD_PACKAGED_BROKER='+JSON.stringify({connected,endpointOwned:connected,ownedChildTerminated:terminated,externalRequestsBlocked:refused}))
assert.ok(connected&&terminated)
