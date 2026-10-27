import { closeSync, cpSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { planChainedManagedSwap } from './official-chained-swap-plan.mjs'
import { candidateDigest } from './official-upgrade.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const STAGED = '.chat-on-opencode-chain-next'
const JOURNAL = '.chat-on-opencode-chain-prepare.json'

/** Prepare a third immutable generation. Promotion remains deliberately unsupported. */
export function prepareChainedGeneration(config, candidate, expectedDigest, { fault } = {}) {
  const evidence = planChainedManagedSwap(config, candidate, expectedDigest)
  const root = path.dirname(path.resolve(config))
  const stage = path.join(root, STAGED), receipt = path.join(root, JOURNAL)
  if (existsSync(stage) || existsSync(receipt)) throw Error('chained_swap_already_prepared')
  const originalJournal = path.join(root, '.chat-on-opencode-directory-switch.json')
  const journalHash = sha(readFileSync(originalJournal))
  const verify = () => {
    if (sha(readFileSync(originalJournal)) !== journalHash ||
        sha(readFileSync(config)) !== evidence.configSha256 ||
        planChainedManagedSwap(config, candidate, expectedDigest).activePayloadSha256 !== evidence.activePayloadSha256) {
      throw Error('chained_swap_cas_changed')
    }
  }
  let ownsStage = false
  try {
    mkdirSync(stage)
    ownsStage = true
    fault?.('after_mkdir')
    for (const name of ['bin', 'plugin', 'src']) cpSync(path.join(candidate, name), path.join(stage, name), { recursive: true, errorOnExist: true })
    for (const name of ['package.json', 'README.md', 'opencode.example.jsonc']) {
      if (existsSync(path.join(candidate, name))) cpSync(path.join(candidate, name), path.join(stage, name), { errorOnExist: true })
    }
    fault?.('after_copy')
    if (candidateDigest(stage) !== expectedDigest) throw Error('chained_swap_staged_digest_mismatch')
    verify()
    fault?.('before_receipt')
    verify()
    const fd = openSync(receipt, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, configSha256: evidence.configSha256,
        journalSha256: journalHash, previousPayloadSha256: evidence.previousPayloadSha256,
        activePayloadSha256: evidence.activePayloadSha256, candidateSha256: expectedDigest }))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    return { prepared: true, promotionAllowed: false, candidateSha256: expectedDigest }
  } catch (error) {
    // Never remove an existing receipt; concurrent ownership must be inspected first.
    if (ownsStage && !existsSync(receipt)) rmSync(stage, { recursive: true, force: true })
    throw error
  }
}
