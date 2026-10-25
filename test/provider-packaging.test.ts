import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('independent portable provider distribution', () => {
  it('does not inherit the CoS product identity or write into its release directory', () => {
    const settings = read('electron-builder.provider.yml');
    expect(settings).toContain('extends: ./electron-builder.yml');
    expect(settings).toContain('appId: dev.chatonopencode.provider');
    expect(settings).toContain('productName: Chat On OpenCode Provider');
    expect(settings).toContain('output: release/provider');
    expect(settings).toContain('executableName: Chat On OpenCode Provider');
    expect(settings).toContain('executableName: chat-on-opencode-provider');
    expect(settings).not.toMatch(/target:\s*nsis/);
  });

  it('enforces unpacked-only packaging and probes its separately named runtime', () => {
    const pack = read('scripts/package.mjs');
    const smoke = read('scripts/smoke-packaged-runtime.mjs');
    expect(pack).toContain("const providerOnly = args.includes('--provider')");
    expect(pack).toContain("builderArgs.push('--config', 'electron-builder.provider.yml')");
    expect(pack).toContain("if (dirOnly || providerOnly) builderArgs.push('--dir')");
    expect(pack).toContain("providerOnly ? ['--provider'] : []");
    expect(smoke).toContain("providerOnly ? 'Chat On OpenCode Provider.exe'");
    expect(smoke).toContain("providerOnly ? 'chat-on-opencode-provider'");
    expect(smoke).toContain("providerOnly ? 'Chat On OpenCode Provider.app'");
  });

  it('uses a disposable profile for the native Electron process, never a personal login', () => {
    const native = read('scripts/verify-provider-packaged-electron.mjs');
    const fixture = read('scripts/provider-isolated-profile.ts');
    expect(native).toContain("CHAT_ON_OPENCODE_OWNER_PID: String(process.pid)");
    expect(native).toContain("CHAT_ON_OPENCODE_USERDATA_DIR: profile");
    expect(native).toContain("APPDATA: ownedAppData, LOCALAPPDATA: home");
    expect(fixture).toContain("config.readOnly = true");
    expect(fixture).toContain("config.roots = []");
    expect(fixture).toContain("config.ui.autoConnect = false");
    expect(fixture).toContain("config.goal.enabled = false");
  });
});
