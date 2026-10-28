#!/usr/bin/env node
// Read-only, interactive human evidence. Never stages, activates or closes Desktop.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { stdin, stdout } from 'node:process'
import { createDraftAttestationChallenge, verifyHumanDraftAttestation } from '../src/human-draft-attestation.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function guarded(file, directory = false) {
  if (!path.isAbsolute(file)) throw Error('attestation_absolute_path_required')
  const full = path.resolve(file)
  let part = path.parse(full).root
  for (const segment of full.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, segment)
    const st = lstatSync(part)
    if (st.isSymbolicLink()) throw Error('attestation_symlink_refused')
  }
  const st = lstatSync(full)
  if (directory ? !st.isDirectory() : !st.isFile()) throw Error('attestation_path_type_invalid')
  return full
}
function treeHash(folder) {
  guarded(folder, true)
  const rows = []
  function walk(at, relative = '') {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name), rel = path.join(relative, name).replaceAll('\\', '/')
      const st = lstatSync(file)
      if (st.isSymbolicLink()) throw Error('attestation_symlink_refused')
      if (st.isDirectory()) walk(file, rel)
      else if (st.isFile()) rows.push(rel + '\0' + sha(readFileSync(file)))
      else throw Error('attestation_nonregular_entry')
    }
  }
  walk(folder)
  return sha(rows.join('\n'))
}
export function captureAttestationCAS(paths) {
  const keys = ['config', 'journal', 'originalA', 'activeB', 'candidateC']
  if (Object.keys(paths ?? {}).sort().join() !== keys.slice().sort().join()) throw Error('attestation_paths_invalid')
  return Object.fromEntries(keys.map(key => [key, key === 'config' || key === 'journal'
    ? sha(readFileSync(guarded(paths[key]))) : treeHash(paths[key])]))
}
export function windowsProcessIdle({ runner = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return false
  const script = '$ErrorActionPreference="Stop"; $p=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -in @("OpenCode.exe","opencode.exe","opencode-cli.exe","Chat On OpenCode Provider.exe") }); Write-Output $p.Count'
  const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, encoding: 'utf8', timeout: 8000, shell: false })
  return r.status === 0 && /^0\s*$/.test(r.stdout ?? '')
}
export async function runAttestation(paths, { input = stdin, output = stdout, clock = Date.now, runner = spawnSync, platform = process.platform } = {}) {
  const no = reason => ({ status: 'NO_GO', activationAuthorized: false, reason })
  if (!input.isTTY || !output.isTTY) return no('attestation_interactive_terminal_required')
  if (!windowsProcessIdle({ runner, platform })) return no('attestation_process_not_idle')
  let before
  try { before = captureAttestationCAS(paths) } catch { return no('attestation_cas_unavailable') }
  const challenge = createDraftAttestationChallenge(before, { now: clock() })
  const rl = readline.createInterface({ input, output })
  try {
    output.write('Review ALL OpenCode Desktop windows and unsent composers. Save or deliberately discard every draft, then close Desktop yourself. This tool never reads drafts or closes windows.\n')
    output.write('Type this nonce ONLY after doing so: ' + challenge.challenge + '\n')
    const entered = (await rl.question('Nonce: ')).trim()
    if (entered !== challenge.challenge) return no('attestation_human_review_missing')
    if (!windowsProcessIdle({ runner, platform })) return no('attestation_process_not_idle')
    let after
    try { after = captureAttestationCAS(paths) } catch { return no('attestation_cas_unavailable') }
    return verifyHumanDraftAttestation(challenge,
      { nonce: entered, reviewedAllComposers: true, draftsSavedOrDiscarded: true }, after,
      { now: clock(), processIdle: true })
  } finally { rl.close() }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const keys = ['--config', '--journal', '--original-a', '--active-b', '--candidate-c']
  if (args.length !== 11 || args[0] !== '--attest-only' ||
      keys.some(key => args.filter(value => value === key).length !== 1)) {
    process.stderr.write('attestation_explicit_options_required\n'); process.exitCode = 2
  } else {
    const options = new Map()
    for (let i = 1; i < args.length; i += 2) options.set(args[i], args[i + 1])
    if (options.size !== 5 || keys.some(key => !path.isAbsolute(options.get(key) ?? ''))) {
      process.stderr.write('attestation_absolute_options_required\n'); process.exitCode = 2
    } else {
      const result = await runAttestation({ config: options.get('--config'), journal: options.get('--journal'),
        originalA: options.get('--original-a'), activeB: options.get('--active-b'), candidateC: options.get('--candidate-c') })
      process.stdout.write(JSON.stringify(result) + '\n')
      // Attestation is never a promotion token or implicit process exit success.
      process.exitCode = result.status === 'REVIEW_ATTESTED_ONLY' ? 0 : 2
    }
  }
}
