import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  throw new Error('Packaged provider Electron E2E requires Windows; Linux/macOS await native compositor tests');
}
const root = path.resolve('release/provider/win-unpacked');
const executable = path.join(root, 'Chat On OpenCode Provider.exe');
assert.ok(existsSync(executable), 'build the independent portable provider package first');

const home = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-'));
const profile = path.join(home, 'isolated');
const ownedAppData = path.join(home, 'appdata');
await mkdir(ownedAppData);
const command = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', profile], {
  windowsHide: true, encoding: 'utf8', timeout: 15_000, cwd: process.cwd(), shell: false,
});
assert.equal(command.status, 0, `cannot prepare isolated profile: ${command.stderr?.slice(-1500)}`);

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, ['--chat-on-opencode-provider-service'], {
  cwd: root, shell: false, windowsHide: true, stdio: 'ignore',
  env: {
    ...environment, APPDATA: ownedAppData, LOCALAPPDATA: home,
    CHAT_ON_OPENCODE_USERDATA_DIR: profile,
    CHAT_ON_OPENCODE_OWNER_PID: String(process.pid),
  },
});
try {
  let endpoint;
  let token;
  let healthy = false;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged provider exited ${child.exitCode}`);
    try {
      endpoint = JSON.parse(await readFile(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'));
      token = (await readFile(path.join(profile, 'control-api', 'token'), 'utf8')).trim();
      if (endpoint.pid !== child.pid || endpoint.protocol !== 1) throw new Error('endpoint_pid_or_protocol_mismatch');
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.pid, child.pid);
        assert.equal(health.actions?.enabled, true);
        const processInfo = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${child.pid} -ErrorAction Stop).MainWindowHandle`], {
          windowsHide: true, encoding: 'utf8', timeout: 5000,
        });
        assert.equal(processInfo.status, 0, 'cannot verify Windows window visibility');
        assert.equal(Number(processInfo.stdout.trim()), 0, 'provider service unexpectedly has a visible window');
        process.stdout.write('Packaged Chat On OpenCode Electron service: owned control API healthy; no visible CoS window.\n');
        healthy = true;
        break;
      }
    } catch (error) {
      if (/endpoint_pid_or_protocol_mismatch/.test(String(error))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(healthy, 'packaged Electron did not expose a healthy control API before deadline');
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (let i = 0; i < 15; i++) {
    try { await rm(home, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); break; }
    catch (error) { if (i === 14) throw error; await new Promise(resolve => setTimeout(resolve, 300)); }
  }
}
