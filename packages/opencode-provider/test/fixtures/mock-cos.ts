/**
 * Offline test executable, compiled separately by Bun. It is NOT a ChatGPT browser or
 * a substitute for the packaged Electron E2E gate. It exercises real OS process/PID,
 * endpoint-file, token, outbox and SSE ownership boundaries without network login.
 */
import http from 'node:http'
import path from 'node:path'
import { appendFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'

const folder = process.env.CHAT_ON_OPENCODE_USERDATA_DIR
// Windows CI can launch under an 8.3 RUNNER~1 temp alias, while the runtime
// canonicalizes the provider-data directory to its long path before spawn.
const traceRoot = process.env.CHAT_ON_OPENCODE_TEST_TRACE_DIR
const traceAllowed = (() => {
  try {
    const observed = realpathSync(path.dirname(folder!))
    const permitted = realpathSync(traceRoot!)
    return process.platform === 'win32'
      ? observed.toLowerCase() === permitted.toLowerCase() : observed === permitted
  } catch { return false }
})()
const ready = process.argv.includes('--chat-on-opencode-provider-service')
const parentPID = Number(process.env.CHAT_ON_OPENCODE_OWNER_PID)
if (!ready || !folder || !path.isAbsolute(folder) || !Number.isSafeInteger(parentPID) || parentPID < 2 || parentPID === process.pid) process.exit(20)

const control = path.join(folder, 'control-api')
const token = randomBytes(32).toString('base64url')
const sessions = new Set<string>()
const events = new Map<string, Array<Record<string, unknown>>>()
const server = http.createServer(async (req, res) => {
  if (traceAllowed) {
    await appendFile(path.join(folder, 'fixture-routes.txt'), `${req.method} ${req.url?.split('?')[0]}\n`).catch(() => undefined)
  }
  const json = (status: number, obj: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  const port = (server.address() as { port: number }).port
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || req.headers.authorization !== `Bearer ${token}`) {
    return json(403, { error: 'untrusted_caller' })
  }
  if (req.method === 'GET' && req.url === '/v1/health') return json(200, { ok: true, protocol: 1, actions: { enabled: true } })
  if (req.method === 'GET' && req.url === '/v1/provider/readiness') return json(200, {
    sessionCookie: 'present', extension: 'connected', paired: true, canAttempt: true
  })
  if (req.method === 'POST' && req.url === '/v1/inputs') {
    let raw = ''
    for await (const chunk of req) raw += chunk.toString('utf8')
    const input = JSON.parse(raw)
    if (!/^[a-f0-9-]{36}$/.test(input.id) || typeof input.text !== 'string') return json(422, { error: 'bad_fixture_input' })
    const id = input.sessionId ?? input.id
    sessions.add(id)
    const list = events.get(id) ?? []
    const seq = list.length + 1
    list.push({ seq, kind: 'user_message', inputId: input.id })
    const toolFile = process.env.CHAT_ON_OPENCODE_TEST_NATIVE_READ_FILE
    const nativeReadIntent = toolFile && input.text.includes('OpenCode can execute ONE native read tool')
      && !input.text.includes('UNTRUSTED file content')
    const nativeReadResult = toolFile && input.text.includes('UNTRUSTED file content')
    const assistantText = nativeReadIntent
      ? '<opencode-read>' + JSON.stringify({ name: 'read', arguments: { path: toolFile } }) + '</opencode-read>'
      : nativeReadResult ? (input.text.includes('NATIVE_READ_PROOF_8729') ? 'NATIVE_FILE_READ_OK' : 'READ_CONTENT_NOT_FOUND')
      : 'OFFLINE_FORK_OK'
    list.push({ seq: seq + 1, kind: 'assistant_message', message: { text: assistantText, truncated: false } })
    list.push({ seq: seq + 2, kind: 'turn_end', outcome: 'completed' })
    events.set(id, list)
    return json(202, { input: { delivery: 'pending' } })
  }
  const session = /^\/v1\/sessions\/([0-9a-z-]+)$/.exec(req.url ?? '')
  if (req.method === 'GET' && session) return json(sessions.has(session[1]!) ? 200 : 404, sessions.has(session[1]!) ? { session: { id: session[1] } } : { error: 'session_not_found' })
  const stream = /^\/v1\/sessions\/([0-9a-z-]+)\/events\/stream\?from=(\d+)&full=1$/.exec(req.url ?? '')
  if (req.method === 'GET' && stream) {
    const list = events.get(stream[1]!)
    if (!list) return json(404, { error: 'session_not_found' })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
    for (const event of list) if ((event.seq as number) >= Number(stream[2])) {
      res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    res.end()
    return
  }
  json(404, { error: 'fixture_not_found' })
})

server.listen(0, '127.0.0.1', async () => {
  await mkdir(control, { recursive: true })
  await writeFile(path.join(control, 'token'), token, { mode: 0o600 })
  await writeFile(path.join(control, 'endpoint.json'), JSON.stringify({ protocol: 1, port: (server.address() as { port: number }).port, pid: process.pid }), { mode: 0o600 })
})

let closing = false
const stop = async () => {
  if (closing) return
  closing = true
  server.close()
  await Promise.all(['endpoint.json', 'token'].map(file => rm(path.join(control, file), { force: true })))
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
setInterval(() => {
  try { process.kill(parentPID, 0) } catch { void stop() }
}, 500).unref()
