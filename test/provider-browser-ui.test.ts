import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { providerBrowserUiAllowed, providerServiceOwner, PROVIDER_SERVICE_SWITCH } from '../src/main/provider-service.js';

describe('dedicated CoS provider service browser policy', () => {
  it('preserves ordinary browser presentation but suppresses provider presentation', () => {
    expect(providerBrowserUiAllowed(['app.exe'])).toBe(true);
    expect(providerBrowserUiAllowed(['app.exe', '--background'])).toBe(true);
    expect(providerBrowserUiAllowed(['app.exe', PROVIDER_SERVICE_SWITCH])).toBe(false);
  });

  it('enforces provider-specific presentation checks at both window and popup entrypoints', () => {
    const source = readFileSync(new URL('../src/main/cos-browser/host.ts', import.meta.url), 'utf8');
    const window = source.slice(source.indexOf('  private showWindow('), source.indexOf('  private userMinimize('));
    const popup = source.slice(source.indexOf('  private openExtensionPopup('), source.indexOf('  // ---- tabs '));
    expect(window).toContain('if (!providerBrowserUiAllowed(process.argv)) return;');
    expect(popup).toContain('if (!providerBrowserUiAllowed(process.argv)) return;');
  });

  it('will not accept its own PID or an absent parent as the gateway owner', () => {
    expect(() => providerServiceOwner(undefined, 42)).toThrow(/gateway_owner_required/);
    expect(() => providerServiceOwner('42', 42)).toThrow(/gateway_owner_required/);
    expect(providerServiceOwner('43', 42)).toBe(43);
  });
});
