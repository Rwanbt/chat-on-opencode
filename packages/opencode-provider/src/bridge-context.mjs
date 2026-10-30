// The bridge carries its own tool contract to ChatGPT. OpenCode's native
// system prompt is not part of that contract: it describes the *native*
// tool-calling environment and repeats every tool in prose. On OpenCode
// 2.1.4 that prompt is about 70k characters - dominated by a second, prose
// copy of the same tools the bridge already forwards precisely - while the
// CoS envelope accepts 64k. Forwarding both made the bridge unusable on a
// realistic profile.
//
// The project directory is the one piece of native context the bridge cannot
// reconstruct: OpenCode resolves relative tool arguments against it, and the
// read contract asks for absolute paths.

export const MAX_LOCATION = 1024

/** Accept only a bounded absolute path without control characters. */
export function normalizeLocation(value) {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (candidate.length === 0 || candidate.length > MAX_LOCATION) return null
  if (/[\r\n\0]/.test(candidate)) return null
  const absolute = /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\') ||
    candidate.startsWith('/')
  return absolute ? candidate : null
}

/** The single line that tells the model where relative tool paths resolve. */
export function bridgeContextLine(location) {
  const normalized = normalizeLocation(location)
  if (!normalized) return ''
  return 'OpenCode runs these tools in the project directory: ' + normalized +
    '\nRelative paths in tool arguments are resolved against it.'
}
