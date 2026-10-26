import { createHash } from 'node:crypto'
import { BridgeError } from './control.mjs'

const refuse = () => { throw new BridgeError('native_tool_result_not_issued', 403) }
const signature = args => {
  if (typeof args !== 'string' || args.length > 8192) refuse()
  let parsed
  try { parsed = JSON.parse(args) } catch { refuse() }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') refuse()
  return JSON.stringify(Object.keys(parsed).sort().map(name => [name, parsed[name]]))
}
const digest = value => createHash('sha256').update(value).digest('hex')

/** Volatile gateway custody: neither an approval decision nor a local tool executor.
 * A native result must match an exactly issued read call and may be delivered only once.
 * Retries with identical result bytes can resume an upstream idempotent turn. */
export class NativeReadCustody {
  #issued = new Map()
  constructor(max = 1024, { now = () => performance.now(), ttlMs = 30 * 60_000 } = {}) {
    this.max = max
    this.now = now
    this.ttlMs = ttlMs
  }
  has(session) { return this.#issued.has(session) }
  abandon(session) { this.#issued.delete(session) }
  issue(session, message, call) {
    if (call?.type !== 'function' || call.function?.name !== 'read' ||
        typeof call.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(call.id)) refuse()
    const prior = this.#issued.get(session)
    const continuing = prior?.message === message
    if (continuing && (prior.depth >= 2 || !prior.resultDigest)) refuse()
    const issued = { message, id: call.id, arguments: signature(call.function.arguments),
      resultDigest: null, issuedAt: this.now(), depth: continuing ? prior.depth + 1 : 1 }
    this.#issued.delete(session)
    this.#issued.set(session, issued)
    while (this.#issued.size > this.max) this.#issued.delete(this.#issued.keys().next().value)
  }
  claim(session, message, messages) {
    const issued = this.#issued.get(session)
    const result = messages?.at(-1)
    const previous = messages?.at(-2)
    const calls = previous?.tool_calls
    const call = Array.isArray(calls) && calls.length === 1 ? calls[0] : null
    if (!issued || this.now() < issued.issuedAt || this.now() - issued.issuedAt > this.ttlMs ||
        issued.message !== message || previous?.role !== 'assistant' ||
        !call || call.type !== 'function' || call.id !== issued.id ||
        call.function?.name !== 'read' || result?.role !== 'tool' ||
        result.tool_call_id !== issued.id || typeof result.content !== 'string' ||
        result.content.length > 64000 || signature(call.function.arguments) !== issued.arguments) refuse()
    const next = digest(result.content)
    if (issued.resultDigest && next !== issued.resultDigest) refuse()
    issued.resultDigest = next
  }
  canContinue(session, message) {
    const item = this.#issued.get(session)
    const now = this.now()
    return !!item && item.message === message && item.depth < 2 &&
      !!item.resultDigest && now >= item.issuedAt && now - item.issuedAt <= this.ttlMs
  }
  consume(session) { this.#issued.delete(session) }
}
