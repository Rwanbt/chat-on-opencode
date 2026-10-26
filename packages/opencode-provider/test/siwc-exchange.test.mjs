import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { exchangeSIWCCode } from '../src/siwc-exchange.mjs'
const now = Date.UTC(2026,9,26)
const clientID='oaiapp_synthetic_test_client'
const callback={ clientID, code:'syntheticCode98765', verifier:'syntheticVerifier12345', nonce:'syntheticNonce12345', redirectURI:'http://127.0.0.1:45678/auth/callback' }
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048})
const jwk={...publicKey.export({format:'jwk'}),kid:'synthetic-kid',alg:'RS256',use:'sig'}
const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url')
function jwt(changes={}){
 const head=enc({alg:'RS256',kid:jwk.kid,typ:'JWT'})
 const payload=enc({iss:'https://auth.openai.com',aud:clientID,sub:'subject-test',nonce:callback.nonce,iat:Math.floor(now/1000)-1,exp:Math.floor(now/1000)+3600,...changes})
 return [head,payload,sign('RSA-SHA256',Buffer.from(head+'.'+payload),privateKey).toString('base64url')].join('.')
}
const response=(data,status=200,ct='application/json')=>({status,headers:{get:()=>ct},body:{async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(data))}}})
function fakeFetch(payload={},toks={}){const calls=[];const run=async(url,init)=>{
 calls.push({url,init});if(url.endsWith('/token'))return response({token_type:'Bearer',access_token:'synthetic-access-12345',refresh_token:'synthetic-refresh-12345',id_token:jwt(payload),scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',expires_in:3600,...toks})
 if(url.endsWith('jwks.json'))return response({keys:[jwk]});throw Error('off-allowlist')
 };return {run,calls}}
test('exact SIWC code exchange and JOSE identity proof with synthetic JWKS',async()=>{
 const f=fakeFetch();const record=await exchangeSIWCCode({callback,fetchImpl:f.run,clock:()=>now});
 assert.equal(record.canUsePlan,true);assert.equal(record.subject,'subject-test');assert.equal(f.calls.length,2)
 assert.equal(f.calls[0].url,'https://auth.openai.com/api/accounts/oauth/token');assert.equal(f.calls[0].init.redirect,'error')
 const body=new URLSearchParams(f.calls[0].init.body);assert.equal(body.get('client_id'),clientID)
 assert.equal(body.get('redirect_uri'),callback.redirectURI);assert.equal(body.get('code_verifier'),callback.verifier)
 assert.ok(!f.calls[0].init.body.includes('dynamic_agent_client'));assert.equal(f.calls[1].url,'https://auth.openai.com/.well-known/jwks.json')
})
test('without ChatGPT plan scope a signed-in identity cannot use subscription',async()=>{
 const f=fakeFetch({}, {scope:'openid profile email'});const r=await exchangeSIWCCode({callback,fetchImpl:f.run,clock:()=>now});assert.equal(r.canUsePlan,false)
})
for(const [name,claims,error] of [
 ['wrong issuer',{iss:'https://evil.example'},'siwc_identity_claims_invalid'],
 ['wrong audience',{aud:'other-client'},'siwc_identity_claims_invalid'],
 ['wrong nonce',{nonce:'other-nonce'},'siwc_identity_claims_invalid'],
 ['expired',{exp:Math.floor(now/1000)-10},'siwc_identity_claims_invalid'],
 ['future nbf',{nbf:Math.floor(now/1000)+40},'siwc_identity_claims_invalid'],
])test('reject '+name,async()=>{const f=fakeFetch(claims);await assert.rejects(exchangeSIWCCode({callback,fetchImpl:f.run,clock:()=>now}),x=>x.code===error)})
test('returning account mismatch refuses verified but wrong subject',async()=>{const f=fakeFetch();await assert.rejects(exchangeSIWCCode({callback,fetchImpl:f.run,clock:()=>now,selectedSubject:'different-sub'}),x=>x.code==='siwc_account_mismatch')})
test('no callback code, wrong host and missing issued client refuse before network',async()=>{for(const c of [{...callback,clientID:'dynamic_agent_client'},{...callback,code:''},{...callback,redirectURI:'http://localhost:45678/auth/callback'}]){
 let calls=0;await assert.rejects(exchangeSIWCCode({callback:c,fetchImpl:async()=>{calls++}}),x=>x.code==='siwc_exchange_options_invalid');assert.equal(calls,0)
}})
test('HTTP auth failure and unsigned forged payload refuse',async()=>{const f=fakeFetch();await assert.rejects(exchangeSIWCCode({callback,clock:()=>now,fetchImpl:async(u,o)=>u.endsWith('/token')?response({},400):f.run(u,o)}),x=>x.code==='siwc_token_exchange_refused')
 const forged=fakeFetch();await assert.rejects(exchangeSIWCCode({callback,clock:()=>now,fetchImpl:async(u,o)=>u.endsWith('/token')?response({token_type:'Bearer',access_token:'access-valid',refresh_token:'refresh-valid',id_token:'a.b.c',scope:'openid',expires_in:3600}):forged.run(u,o)}),x=>x.code==='siwc_identity_invalid')
})
