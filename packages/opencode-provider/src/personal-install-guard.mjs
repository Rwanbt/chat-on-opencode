/** Guards the personal installation.
 *
 * The install writes the owner's real OpenCode config, so it refuses unless the
 * process census is observed and empty. The install itself, with its exact-byte
 * backup and its scoped rollback, is `installProvider` in `official-install.mjs`.
 * A refusal here never touches a byte.
 */
import { observeWindows } from './context-overlay/activation-preflight.mjs'
import { installProvider } from './official-install.mjs'

export function guardedPersonalInstall(options, { observe = observeWindows, install = installProvider } = {}) {
  const census = observe()
  if (census?.state !== 'observed') {
    return { status: 'NO_GO', reason: 'process_and_port_state_unknown', installed: false }
  }
  if (census.activeOpenCode !== 0) {
    return { status: 'NO_GO', reason: 'opencode_processes_running', installed: false }
  }
  const result = install(options)
  return { status: 'INSTALLED', installed: true, ...result }
}
