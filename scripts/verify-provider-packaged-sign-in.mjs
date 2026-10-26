/**
 * A real packaged Electron window/exit qualification. No ChatGPT login, cookies, or
 * external browser are used: Chromium's HTTPS requests go to a rejecting local proxy.
 * The only OS window action targets the verified PID/handle of our own child process.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { probeOwnedWindows } from './provider-window-probe-runner.mjs';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Packaged sign-in E2E requires Windows');
const root = path.resolve('release/provider/win-unpacked');
const executable = path.join(root, 'Chat On OpenCode Provider.exe');
assert.ok(existsSync(executable), 'build the isolated provider package before running the sign-in E2E');
const probeScript = path.resolve('scripts/provider-windows-window-probe.ps1');
const home = await mkdtemp(path.join(os.tmpdir(), 'coo-provider-e2e-signin-'));
const profile = path.join(home, 'isolated');
const appdata = path.join(home, 'appdata');
const localappdata = path.join(home, 'localappdata');
const marker = path.join(home, 'personal-untouched.txt');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let proxy;
const attemptedHosts = new Set();
const processes = [];
const bareEnv = { ...process.env };
for (const key of Object.keys(bareEnv)) {
  if (key.startsWith('CHAT_ON_OPENCODE_') || key.startsWith('ELECTRON_') || key.startsWith('COS_')) delete bareEnv[key];
}
const env = {
  ...bareEnv, APPDATA: appdata, LOCALAPPDATA: localappdata,
  CHAT_ON_OPENCODE_USERDATA_DIR: profile
};

function checkWindows(pid, handle = 0) {
  return probeOwnedWindows({ pid, handle, script: probeScript });
}

function launch(flag, extras = {}) {
  const args = [flag, '--disable-quic', '--disable-background-networking',
    `--proxy-server=127.0.0.1:${proxy.address().port}`, '--proxy-bypass-list=<-loopback>'];
  const processHandle = spawn(executable, args, {
    // A sign-in is deliberately interactive. windowsHide is only valid for the
    // separately qualified service, not the user's one-time browser window.
    cwd: root, shell: false, windowsHide: false, stdio: 'ignore',
    env: { ...env, ...extras }
  });
  processes.push(processHandle);
  return processHandle;
}

async function exitWithin(childProcess, limit = 12_000) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return childProcess.exitCode;
  return new Promise((resolve, reject) => {
    const finished = code => { clearTimeout(deadline); resolve(code); };
    const deadline = setTimeout(() => {
      childProcess.off('exit', finished);
      reject(new Error('packaged Electron did not exit within its deadline'));
    }, limit);
    childProcess.once('exit', finished);
  });
}

async function stopOwned() {
  for (const handle of processes) {
    if (handle.exitCode === null && !handle.killed) handle.kill('SIGTERM');
  }
  for (const handle of processes) {
    if (handle.exitCode === null) {
      await Promise.race([new Promise(resolve => handle.once('exit', resolve)), delay(3000)]);
      if (handle.exitCode === null) handle.kill('SIGKILL');
    }
  }
}

try {
  await mkdir(appdata);
  await mkdir(localappdata);
  await writeFile(marker, 'PERSONAL_PROFILE_SENTINEL', { flag: 'wx' });
  const fixture = spawnSync('bun', ['run', 'scripts/provider-isolated-profile.ts', profile], {
    cwd: process.cwd(), windowsHide: true, shell: false, encoding: 'utf8', timeout: 15000
  });
  assert.equal(fixture.status, 0, `isolated profile fixture failed: ${fixture.stderr?.slice(-800)}`);
  const config = JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8'));
  assert.equal(config.readOnly, true);
  assert.deepEqual(config.roots, []);
  assert.ok(Object.values(config.capabilities).every(value => value === false));
  assert.equal(config.ui.chatBrowser, 'cos');

  // A proxy that never CONNECTs to the external network. Records only hostnames,
  // and rejects every request. No real ChatGPT or Google session can be accessed.
  proxy = createServer(socket => {
    // Chromium may abandon a blocked CONNECT immediately. A reset is an
    // expected failed network attempt, not a test runner exception.
    socket.on('error', () => undefined);
    socket.once('data', chunk => {
      const first = chunk.toString('ascii').split('\r\n', 1)[0] ?? '';
      const match = /^CONNECT ([^\s]+) HTTP\//i.exec(first);
      if (match) attemptedHosts.add(match[1].toLowerCase());
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    socket.setTimeout(5000, () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });

  // An invalid, uninitialized profile must be rejected before it can create a
  // sign-in window or write a browser state tree.
  const missing = path.join(home, 'missing-profile');
  child = launch('--chat-on-opencode-provider-sign-in', { CHAT_ON_OPENCODE_USERDATA_DIR: missing });
  const negativePID = child.pid;
  await exitWithin(child, 15000);
  assert.deepEqual(checkWindows(negativePID), [], 'missing profile showed a window');
  assert.ok(!existsSync(missing), 'invalid sign-in created a profile');

  child = launch('--chat-on-opencode-provider-sign-in');
  const deadline = Date.now() + 35_000;
  let visible = [];
  let windowHandle = 0;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged sign-in exited before opening (code ${child.exitCode})`);
    visible = checkWindows(child.pid);
    const browser = visible.filter(window => window.title.includes('Chat On Steroids browser'));
    if (browser.length === 1 && visible.length === 1) {
      windowHandle = browser[0].handle;
      break;
    }
    await delay(500);
  }
  assert.ok(windowHandle, `expected exactly one visible sign-in browser; saw ${JSON.stringify(visible)}`);
  // A stale or wrong HWND must never receive WM_CLOSE from this harness.
  assert.throws(() => checkWindows(child.pid, -1), /Windows window probe failed/);
  assert.deepEqual(checkWindows(child.pid).map(win => win.handle), [windowHandle]);
  // The login request is made by this isolated Chromium instance, through our
  // rejecting proxy. The exact /auth/login path is separately owned/tested in host.ts.
  for (let i = 0; i < 40 && ![...attemptedHosts].some(host => host.startsWith('chatgpt.com:')); i++) await delay(250);
  assert.ok([...attemptedHosts].some(host => host.startsWith('chatgpt.com:')),
    `isolated sign-in did not attempt chatgpt.com via rejecting proxy: ${JSON.stringify([...attemptedHosts])}`);
  const endpoint = JSON.parse(await readFile(path.join(profile, 'control-api', 'endpoint.json'), 'utf8'));
  assert.equal(endpoint.pid, child.pid, 'login control API belongs to different process');
  assert.equal(endpoint.protocol, 1);
  assert.deepEqual(checkWindows(child.pid).map(win => win.handle), [windowHandle], 'unexpected additional visible window');
  checkWindows(child.pid, windowHandle); // Verified WM_CLOSE for our child's own browser HWND.
  await exitWithin(child);
  assert.deepEqual(checkWindows(child.pid), [], 'login window remained visible after quit');
  assert.equal(await readFile(marker, 'utf8'), 'PERSONAL_PROFILE_SENTINEL');
  const appdataEntries = await readdir(appdata);
  assert.deepEqual(appdataEntries, [], `unexpected writes to separate ordinary profile: ${appdataEntries.join(',')}`);

  // Retain the existing hidden-service native gate in the same acceptance command.
  const service = spawnSync(process.execPath, ['scripts/verify-provider-packaged-electron.mjs'], {
    cwd: process.cwd(), shell: false, windowsHide: true, encoding: 'utf8', timeout: 100_000
  });
  assert.equal(service.status, 0, `hidden service packaged test failed: ${service.stderr?.slice(-1200)}`);
  assert.match(service.stdout, /no visible CoS window/);
  process.stdout.write('Packaged Electron sign-in: one owned browser, denied external network, WM_CLOSE exit, isolated profile; hidden service gate PASS. No ChatGPT auth used.\n');
} finally {
  await stopOwned();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  await rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
