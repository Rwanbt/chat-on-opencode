import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { BridgeError } from './control.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')

/** One immutable, non-secret first-message identity per native session.
 * The CoS outbox already persists the actual text and receipt. This small
 * provider-owned marker keeps its first input id stable across gateway restart,
 * without storing prompts, browser cookies or gateway authorization tokens.
 */
export class TurnCustody {
  constructor(directory) {
    if (!path.isAbsolute(directory)) throw new BridgeError('turn_custody_directory_invalid', 503)
    this.directory = directory
  }

  file(sessionKey) { return path.join(this.directory, digest(sessionKey) + '.json') }

  read(sessionKey) {
    const file = this.file(sessionKey)
    if (!existsSync(file)) return null
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512) throw Error('unsafe')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed.version !== 1 || !/^[a-f0-9]{32}$/.test(parsed.salt) ||
          !/^[a-f0-9]{64}$/.test(parsed.message) ||
          !/^[a-f0-9]{64}$/.test(parsed.text)) throw Error('invalid')
      return parsed
    } catch { throw new BridgeError('turn_custody_corrupt', 409) }
  }

  /** Never rewrite an existing marker: even after a crash, an ambiguous
   * different initial message must use a different native session. */
  claimFirst(sessionKey, messageKey, text) {
    const old = this.read(sessionKey)
    if (old) return this.verify(old, messageKey, text)
    // Per-session randomness prevents offline guessing of short user prompts.
    const salt = randomBytes(16).toString('hex')
    const expected = { version: 1, salt,
      message: digest(salt + '\0' + messageKey), text: digest(salt + '\0' + text) }
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (!lstatSync(this.directory).isDirectory() || lstatSync(this.directory).isSymbolicLink()) {
        throw Error('unsafe_directory')
      }
      const fd = openSync(this.file(sessionKey), 'wx', 0o600)
      try { writeSync(fd, JSON.stringify(expected) + '\n'); fsyncSync(fd) }
      finally { closeSync(fd) }
    } catch (error) {
      if (error?.code === 'EEXIST') return this.verify(this.read(sessionKey), messageKey, text)
      throw new BridgeError('turn_custody_unavailable', 503)
    }
  }

  verify(record, messageKey, text) {
    if (!record || record.message !== digest(record.salt + '\0' + messageKey) ||
        record.text !== digest(record.salt + '\0' + text)) {
      throw new BridgeError('turn_first_message_conflict', 409)
    }
  }

  isOriginal(record, messageKey) {
    return !!record && record.message === digest(record.salt + '\0' + messageKey)
  }
}
