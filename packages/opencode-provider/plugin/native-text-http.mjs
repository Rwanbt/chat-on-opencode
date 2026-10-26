// Official V2 native OpenAI Responses route, only for user-consented SIWC text.
// No CoS transport, API key fallback, files, tools or delegated permissions.
import { nativeSIWCTextAccount } from './native-responses.mjs'
import { collectResponsesSSE } from '../src/responses-adapter.mjs'

const PROVIDER = 'chat-on-opencode'
const OFFICIAL = 'https://api.openai.com/v1'
const BLOCK = new Set(['background','conversation','max_output_tokens','max_tool_calls',
  'metadata','moderation','multi_agent','prompt','prompt_cache_retention',
  'safety_identifier','temperature','top_logprobs','top_p','truncation','user',
  'previous_response_id','tools','tool_choice','additional_tools'])
const fail = () => { throw Error('siwc_native_text_request_rejected') }

function endpoint(value, allowLoopbackTest) {
  if (value === undefined || value === OFFICIAL) return OFFICIAL
  let url
  try { url = new URL(value) } catch { fail() }
  if (!allowLoopbackTest || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    !url.port || url.pathname !== '/v1' || url.search || url.hash ||
    url.username || url.password) fail()
  return url.href.replace(/\/$/, '')
}

function onlyText(items) {
  if (!Array.isArray(items) || !items.length || items.length > 1024) fail()
  for (const item of items) {
    if (!item || !['user','assistant','developer'].includes(item.role) ||
      (item.type !== undefined && item.type !== 'message')) fail()
    if (typeof item.content === 'string') continue
    if (!Array.isArray(item.content) || item.content.some(part =>
      !part || !['input_text','output_text'].includes(part.type) ||
      typeof part.text !== 'string')) fail()
  }
}

async function boundedBody(request) {
  if (request.method !== 'POST') fail()
  const reader = request.clone().body?.getReader()
  if (!reader) fail()
  let size = 0
  const parts = []
  try {
    for (;;) {
      const {done,value} = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1024*1024) fail()
      parts.push(value)
    }
  } finally { await reader.cancel().catch(()=>{}) }
  let body
  try {body = JSON.parse(Buffer.concat(parts.map(x=>Buffer.from(x)), size).toString('utf8'))}
  catch {fail()}
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail()
  return body
}

/** Native V2 HTTPS route, not the AI SDK callback (official 2.1.4 uses
 * `@opencode/ai/providers/openai`). In-flight request gets a fresh verified
 * account-bound bearer; store:false and tools-off are enforced before sending. */
export async function registerNativeHTTPText(ctx, options={}) {
  if (ctx?.options?.nativeOAuth !== 'preview' || ctx?.options?.nativeInference !== 'text' ||
    !ctx?.session?.hook || !ctx?.integration?.connection) fail()
  const baseURL=endpoint(options.baseURL, options.allowLoopbackTest)
  const account = nativeSIWCTextAccount(ctx.integration, options)
  await ctx.session.hook('model.request', async event => {
    if (event.model?.providerID !== PROVIDER) return
    if (event.kind !== 'primary') fail()
    const active = await account({modelID:event.model.id,signal:event.signal})
    const provider = await ctx.provider.get({providerID:PROVIDER})
    if ((provider?.data ?? provider)?.package !== '@opencode/ai/providers/openai') fail()
    event.baseURL=baseURL
    event.headers.Authorization='Bearer '+active.token
  }, {providerID:PROVIDER})
  await ctx.session.hook('http.request', async event => {
    if (event.model?.providerID !== PROVIDER) return
    if (event.kind !== 'primary' || event.request.url !== baseURL+'/responses') fail()
    const body=await boundedBody(event.request)
    if (body.model !== event.model.id ||
      body.stream !== true || body.store === true) fail()
    onlyText(body.input)
    if ((Array.isArray(body.tools) && body.tools.length) ||
      (body.tool_choice && body.tool_choice !== 'none') ||
      (body.instructions !== undefined && (typeof body.instructions !== 'string' ||
        body.instructions.length > 65536))) fail()
    for (const field of BLOCK) delete body[field]
    body.store=false
    body.stream=true
    const headers=new Headers(event.request.headers)
    headers.set('Content-Type','application/json')
    event.request=new Request(event.request.url,{method:'POST',headers,
      body:JSON.stringify(body),redirect:'error',signal:event.request.signal})
  }, {providerID:PROVIDER})
  // OpenCode's native parser must never see speculative deltas, tool calls or
  // a terminally failed stream. Bound the response before replaying it.
  await ctx.session.hook('http.response', async event => {
    if (event.model?.providerID !== PROVIDER) return
    if (event.kind !== 'primary' || event.response?.status !== 200 ||
      !/^text\/event-stream(?:\s*;|\s*$)/i.test(event.response.headers.get('content-type') ?? '')) fail()
    const chunks=[]
    let size=0
    for await (const part of event.response.body) {
      size += part.byteLength
      if (size > 4*1024*1024) fail()
      chunks.push(Buffer.from(part))
    }
    const bytes=Buffer.concat(chunks,size)
    await collectResponsesSSE([bytes], {expectedModel:event.model.id, allowedTools:new Set()})
    event.response=new Response(bytes,{status:200,headers:event.response.headers})
  }, {providerID:PROVIDER})
}
