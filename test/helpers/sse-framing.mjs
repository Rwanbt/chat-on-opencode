/** Count SSE data fields across arbitrary TCP chunk boundaries without retaining message text. */
export function createSseDataFieldCounter(clock = () => Date.now()) {
  const prefix = [100, 97, 116, 97, 58] // ASCII data:
  let startOfLine = true
  let matched = 0
  let fields = 0
  let firstAt = null
  let lastAt = null
  return {
    push(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk)
      for (const byte of bytes) {
        if (byte === 10) {
          startOfLine = true
          matched = 0
          continue
        }
        if (!startOfLine) continue
        if (byte === prefix[matched]) {
          matched++
          if (matched === prefix.length) {
            fields++
            const now = clock()
            if (firstAt === null) firstAt = now
            lastAt = now
            startOfLine = false
          }
        } else {
          startOfLine = false
        }
      }
    },
    snapshot() {
      return { fields, firstAt, lastAt,
        elapsedMs: firstAt === null ? 0 : Math.max(0, lastAt - firstAt) }
    },
  }
}
