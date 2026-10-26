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
    let controlHealthy = false;
    try {
      endpoint = JSON.parse(await readFile(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'));
      token = (await readFile(path.join(profile, 'control-api', 'token'), 'utf8')).trim();
      if (endpoint.pid !== child.pid || endpoint.protocol !== 1) throw new Error('endpoint_pid_or_protocol_mismatch');
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        controlHealthy = true;
        const health = await response.json();
        assert.equal(health.protocol, 1, 'provider control protocol changed');
        assert.equal(health.pid, child.pid);
        assert.equal(health.actions?.enabled, true);
        for (const route of ['/v1/provider/readiness', '/v1/sessions/{id}/events/stream']) {
          assert.ok(health.routes?.includes(route), `packaged provider lacks ${route}`);
        }
        for (const route of ['POST /v1/inputs', 'POST /v1/sessions/{id}/stop']) {
          assert.ok(health.actions?.routes?.includes(route), `packaged provider lacks ${route}`);
        }
        const readinessResponse = await fetch(`http://127.0.0.1:${endpoint.port}/v1/provider/readiness`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500),
        });
        assert.equal(readinessResponse.status, 200, 'packaged provider readiness route unavailable');
        const readiness = await readinessResponse.json();
        assert.ok(['absent', 'unknown', 'present'].includes(readiness.sessionCookie));
        assert.ok(['connected', 'disconnected'].includes(readiness.extension));
        assert.equal(typeof readiness.paired, 'boolean');
        assert.equal(typeof readiness.canAttempt, 'boolean');
        // A fresh synthetic profile has never been paired or signed into ChatGPT.
        // Cookie presence alone would never prove an authenticated inference anyway.
        assert.equal(readiness.canAttempt, false, 'fresh provider profile must not claim model readiness');
        const processInfo = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Process -Id ${child.pid} -ErrorAction Stop).MainWindowHandle`], {
          windowsHide: true, encoding: 'utf8', timeout: 5000,
        });
        assert.equal(processInfo.status, 0, 'cannot verify Windows window visibility');
        assert.equal(Number(processInfo.stdout.trim()), 0, 'provider service unexpectedly has a visible window');
        process.stdout.write('Packaged Chat On OpenCode Electron service: control routes and unpaired readiness verified; no visible CoS window.\n');
        healthy = true;
        break;
      }
    } catch (error) {
      // Once health has answered, missing routes or malformed readiness are
      // immutable build incompatibilities, not a transient startup delay.
      if (controlHealthy || /endpoint_pid_or_protocol_mismatch/.test(String(error))) throw error;
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
