import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerServiceProfile, providerServiceReady, PROVIDER_SERVICE_SWITCH } from '../src/main/provider-service.js';

const dirs: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cos-provider-v4-'));
  dirs.push(root);
  const personal = path.join(root, 'normal');
  const isolated = path.join(root, 'isolated');
  mkdirSync(personal);
  mkdirSync(isolated);
  return { root, personal, isolated };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Chat On OpenCode provider-mode preflight', () => {
  it('does not alter normal launches', () => {
    const { personal, isolated } = fixture();
    expect(providerServiceProfile(['app'], isolated, personal)).toBeNull();
  });

  it('rejects absent, overlapping and unresolvable provider identities', () => {
    const { root, personal, isolated } = fixture();
    const argv = ['app', PROVIDER_SERVICE_SWITCH];
    expect(providerServiceProfile(argv, isolated, personal)).toBe(realpathSync(isolated));
    expect(() => providerServiceProfile(argv, personal, personal)).toThrow(/overlaps_personal/);
    expect(() => providerServiceProfile(argv, root, personal)).toThrow(/overlaps_personal/);
    expect(() => providerServiceProfile(argv, path.join(root, 'missing'), personal)).toThrow(/profile_must_exist/);
    expect(() => providerServiceProfile(argv, undefined, personal)).toThrow(/isolated_absolute_userdata/);
  });

  it('requires explicit browser and action capability gates', () => {
    const allowed = (chatBrowser: string, enabled: boolean, allowActions: boolean) =>
      providerServiceReady({ ui: { chatBrowser }, controlApi: { enabled, allowActions } });
    expect(allowed('cos', true, true)).toBe(true);
    expect(allowed('chrome', true, true)).toBe(false);
    expect(allowed('cos', false, true)).toBe(false);
    expect(allowed('cos', true, false)).toBe(false);
  });
});
