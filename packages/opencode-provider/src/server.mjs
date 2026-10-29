import { CoSRuntime } from './runtime.mjs'
import { startService } from './service.mjs'
import { createHash } from 'node:crypto'
import { appendFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

// Explicitly test-only, profile-owned evidence. Never write account data,
// message content, tokens, raw native IDs, or raw CoS turn IDs.
function isolatedEvidenceSink(profile) {
  if (process.env.CHAT_ON_OPENCODE_TEST_EVIDENCE_ENABLED !== '1') return undefined
  const root = process.env.CHAT_ON_OPENCODE_TEST_TRACE_DIR
  const salt = process.env.CHAT_ON_OPENCODE_TEST_EVIDENCE_SALT
  if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(salt ?? '')) return undefined
  let actualRoot, actualProfile, receipts
  try {
    actualRoot = realpathSync(root)
    actualProfile = realpathSync(profile)
    receipts = realpathSync(path.join(actualRoot, 'receipts'))
    if (!actualProfile.startsWith(actualRoot + path.sep) ||
        receipts !== path.join(actualRoot, 'receipts') || !statSync(receipts).isDirectory()) return undefined
  } catch { return undefined }
  const allowed = new Set(['input_admitted','turn_started','assistant_revision',
    'native_delta_emitted','turn_completed','turn_stop_requested',
    'input_cancel_requested','cancel_command_acknowledged','cancel_command_unconfirmed'])
  const digest = value => value == null ? null : createHash('sha256').update(salt + ':' + value).digest('hex')
  return entry => {
    if (!allowed.has(entry?.stage)) return
    try {
      appendFileSync(path.join(receipts, 'gateway-evidence.jsonl'), JSON.stringify({
        stage:entry.stage, session:digest(entry.sessionID), turn:digest(entry.turnId),
        message:digest(entry.messageKey), seq:Number.isSafeInteger(entry.seq) ? entry.seq : null,
        atMs:entry.atMs,
      }) + '\n', { flag:'a' })
    } catch { /* evidence is optional; never alter inference or cancellation */ }
  }
}

const executable = process.env.CHAT_ON_OPENCODE_RUNTIME_EXE
const profile = process.env.CHAT_ON_OPENCODE_RUNTIME_DATA
const key = process.env.CHAT_ON_OPENCODE_GATEWAY_KEY
const port = Number(process.env.CHAT_ON_OPENCODE_PORT ?? '45861')
const owned = process.argv.includes('--owned-ipc')
if (owned && (!process.channel || process.connected !== true)) {
  console.error('Chat On OpenCode gateway requires its OpenCode parent IPC')
  process.exitCode = 1
} else if (!executable || !profile || !key || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Missing fork runtime executable, isolated profile, gateway key, or valid port')
  process.exitCode = 1
} else {
  const runtime = new CoSRuntime({ executable, profile, personalProfile: process.env.CHAT_ON_OPENCODE_PERSONAL_COS_DATA })
  try {
    await startService({ runtime, key, port, owned, onEvidence:isolatedEvidenceSink(profile),
      nativeTools: process.env.CHAT_ON_OPENCODE_NATIVE_TOOLS === 'coding' ? 'coding'
        : process.env.CHAT_ON_OPENCODE_NATIVE_TOOLS === 'read' ? 'read' : 'off' })
  } catch (error) {
    console.error('Chat On OpenCode cannot connect to its CoS runtime:', error.code ?? 'invalid_configuration')
    runtime.stop()
    process.exitCode = 1
  }
}
