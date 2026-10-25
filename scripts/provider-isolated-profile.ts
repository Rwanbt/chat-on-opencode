// Test-only: real schema defaults, then explicit consent inside a throwaway provider folder.
// No personal CoS or OpenCode profiles, browser logins or credentials are imported.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultConfig } from '../src/main/config.js';

const target = process.argv[2];
if (!target || !path.isAbsolute(target) || !target.includes('coo-provider-e2e-')) {
  throw new Error('refusing to construct a profile outside a temporary provider E2E directory');
}
const config = defaultConfig();
config.readOnly = true;
config.roots = [];
for (const capability of Object.keys(config.capabilities)) {
  (config.capabilities as Record<string, boolean>)[capability] = false;
}
config.ui.chatBrowser = 'cos';
config.ui.autoConnect = false;
config.ui.startAtLogin = false;
config.ui.turnNotifications = false;
config.multiAgent.enabled = false;
config.goal.enabled = false;
config.controlApi = { enabled: true, allowActions: true };
await mkdir(target, { recursive: true });
await writeFile(path.join(target, 'config.json'), JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
