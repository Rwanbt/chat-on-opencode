// Separate real Windows process; it never writes the file under observation.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const [config, oldSha, newSha] = process.argv.slice(2)
let oldCount = 0, newCount = 0, invalid = 0
let stopped = false
const sha = b => createHash('sha256').update(b).digest('hex')
const read = () => {
  try {
    const current = sha(readFileSync(config))
    if (current === oldSha) oldCount++
    else if (current === newSha) newCount++
    else invalid++
  } catch { invalid++ }
}
process.on('message', m => {
  if (m?.type === 'stop' && !stopped) {
    stopped = true
    read()
    process.send?.({ type: 'result', oldCount, newCount, invalid }, () => process.exit(0))
  }
})
read()
process.send?.({ type: 'ready' })
setInterval(() => { if (!stopped) read() }, 2).unref()
