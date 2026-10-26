import { spawnSync } from 'node:child_process'

/**
 * Launch only the existing exact-PID PowerShell window probe. On busy Windows
 * runners Add-Type cold-compilation occasionally exhausts the initial probe
 * timeout. Repeat ONLY that process timeout, never an HWND/PID refusal.
 */
export function probeOwnedWindows({ pid, handle = 0, script, runner = spawnSync,
  timeoutMs = 30_000, attempts = 2 }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-OwnerProcessId', String(pid)]
  if (handle) args.push('-CloseHandle', String(handle))
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = runner('powershell.exe', args, {
      windowsHide: true, encoding: 'utf8', timeout: timeoutMs,
    })
    if (result.error?.code === 'ETIMEDOUT' && attempt + 1 < attempts) {
      process.stderr.write('WINDOW_PROBE_COLD_START_TIMEOUT_RETRY\n')
      continue
    }
    if (result.status !== 0) {
      throw new Error('Windows window probe failed: ' +
        (result.error?.message ?? result.stderr?.slice(-900) ?? 'unknown_exit'))
    }
    const parsed = JSON.parse(result.stdout.trim())
    return Array.isArray(parsed) ? parsed : [parsed]
  }
  throw new Error('Windows window probe exhausted')
}
