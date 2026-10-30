/** Proves the promotion's touched-byte set never reaches the Desktop's user data.
 *
 * A promotion writes inside the OpenCode config root (`opencode.jsonc` scoped entries,
 * the format-2 manifest and the provider generation directories). The Desktop keeps
 * unsent composer drafts in `<userData>/drafts.sqlite`. The two are disjoint when the
 * config root is not inside the user data directory and the user data directory is not
 * inside the config root. Only path relations are compared; no file is read or written.
 */
import path from 'node:path'

const within = (child, parent) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function touchedSetDisjointFrom(configRoot, desktopUserData) {
  const config = path.resolve(configRoot)
  const desktop = path.resolve(desktopUserData)
  if (within(config, desktop) || within(desktop, config)) {
    return { disjoint: false, reason: 'touched_set_overlaps_desktop_state' }
  }
  return { disjoint: true, reason: null }
}
