import { createHash, randomBytes } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
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

  followupFile(sessionKey, messageKey) {
    return path.join(this.directory, digest(sessionKey + '\0' + messageKey) + '.followup.json')
  }

  readFollowup(sessionKey, messageKey) {
    const file = this.followupFile(sessionKey, messageKey)
    if (!existsSync(file)) return null
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512) throw Error('unsafe')
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record.version !== 1 || !/^[0-9a-f]{32}$/.test(record.salt) ||
          !/^[0-9a-f]{64}$/.test(record.history) || !/^[0-9a-f]{64}$/.test(record.text)) throw Error('invalid')
      return record
    } catch { throw new BridgeError('turn_followup_custody_corrupt', 409) }
  }

  verifyFollowup(record, historyFingerprint, text) {
    if (!record || record.history !== digest(record.salt + '\0' + historyFingerprint) ||
        (text !== undefined && record.text !== digest(record.salt + '\0' + text))) {
      throw new BridgeError('turn_followup_identity_conflict', 409)
    }
  }

  /** Commit only salted hashes before CoS outbox admission. On a gateway
   * restart, recover the actual text from CoS's existing durable outbox;
   * never persist prompt or transcript content into these markers. */
  claimFollowup(sessionKey, messageKey, historyFingerprint, text) {
    const old = this.readFollowup(sessionKey, messageKey)
    if (old) return this.verifyFollowup(old, historyFingerprint, text)
    const salt = randomBytes(16).toString('hex')
    const record = { version: 1, salt,
      history: digest(salt + '\0' + historyFingerprint), text: digest(salt + '\0' + text) }
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const directory = lstatSync(this.directory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('unsafe_directory')
      const fd = openSync(this.followupFile(sessionKey, messageKey), 'wx', 0o600)
      try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd) }
      finally { closeSync(fd) }
    } catch (error) {
      if (error?.code === 'EEXIST') return this.verifyFollowup(this.readFollowup(sessionKey, messageKey), historyFingerprint, text)
      throw new BridgeError('turn_followup_custody_unavailable', 503)
    }
  }

  anchorFile(sessionKey) { return path.join(this.directory, digest(sessionKey) + '.anchor.json') }

  /** An anchor is evidence from a completed CoS turn, never a transcript copy.
   * Sequence numbers belong to the durable CoS journal: an old message replay
   * cannot replace a newer anchor after gateway restart. */
  readAnchor(sessionKey) {
    const file = this.anchorFile(sessionKey)
    if (!existsSync(file)) return null
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512) throw Error('unsafe')
      const record = JSON.parse(readFileSync(file, 'utf8'))
      if (record.version !== 1 || !Number.isSafeInteger(record.seq) || record.seq < 1 ||
          !/^[a-f0-9]{32}$/.test(record.salt) ||
          !/^[a-f0-9]{64}$/.test(record.question) ||
          !/^[a-f0-9]{64}$/.test(record.answer)) throw Error('invalid')
      return record
    } catch { throw new BridgeError('turn_anchor_corrupt', 409) }
  }

  rememberAnchor(sessionKey, anchor, seq) {
    if (!Number.isSafeInteger(seq) || seq < 1 ||
        !/^[a-f0-9]{64}$/.test(anchor?.questionSha256) ||
        !/^[a-f0-9]{64}$/.test(anchor?.answerSha256)) return
    const previous = this.readAnchor(sessionKey)
    if (previous && previous.seq >= seq) return
    const salt = randomBytes(16).toString('hex')
    const record = { version: 1, seq, salt,
      question: digest(salt + '\0' + anchor.questionSha256),
      answer: digest(salt + '\0' + anchor.answerSha256) }
    let temporary
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const info = lstatSync(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('unsafe_directory')
      temporary = this.anchorFile(sessionKey) + '.' + randomBytes(8).toString('hex') + '.tmp'
      const fd = openSync(temporary, 'wx', 0o600)
      try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd) }
      finally { closeSync(fd) }
      renameSync(temporary, this.anchorFile(sessionKey))
    } catch {
      if (temporary) { try { unlinkSync(temporary) } catch { /* no owned temp remains */ } }
      throw new BridgeError('turn_anchor_unavailable', 503)
    }
  }
}
