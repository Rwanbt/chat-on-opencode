import { appendFileSync } from 'node:fs'
import path from 'node:path'

/** Opt-in scratch diagnostic. Only constant stage names; never text, IDs or credentials. */
export function traceStage(stage, destination = process.env.CHAT_ON_OPENCODE_STAGE_TRACE) {
  if (!destination || !path.isAbsolute(destination) || !/^[a-z_]+$/.test(stage)) return
  try { appendFileSync(destination, stage + '\n', { encoding: 'utf8', flag: 'a' }) }
  catch { /* Diagnostics must never alter provider behavior. */ }
}
