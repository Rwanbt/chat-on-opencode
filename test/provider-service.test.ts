import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerNormalUserData, providerServiceProfile, providerServiceReady, providerReadinessStatus, PERSONAL_COS_APP_NAME, PROVIDER_SERVICE_SWITCH, PROVIDER_SIGN_IN_SWITCH } from '../src/main/provider-service.js';

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
  it('derives a disjoint normal Windows profile without Electron getPath at bootstrap', () => {
    const { root, isolated } = fixture();
    const normal = providerNormalUserData(root, 'Chat On Steroids');
    expect(normal).toBe(path.join(root, 'Chat On Steroids'));
    expect(providerServiceProfile(['app', PROVIDER_SERVICE_SWITCH], isolated, normal!)).toBe(realpathSync(isolated));
    expect(providerNormalUserData(undefined, 'Chat On Steroids')).toBeNull();
    expect(providerNormalUserData(root, '../isolated')).toBeNull();
    expect(providerNormalUserData('relative', 'Chat On Steroids')).toBeNull();
    expect(() => providerServiceProfile(['app', PROVIDER_SERVICE_SWITCH], isolated, root)).toThrow(/overlaps/);
  });
  it('protects the personal CoS product name when the packaged provider has its own name', () => {
    const { root } = fixture();
    expect(PERSONAL_COS_APP_NAME).toBe('Chat On Steroids');
    const personal = path.join(root, PERSONAL_COS_APP_NAME);
    const providerProductName = path.join(root, 'Chat On OpenCode Provider');
    mkdirSync(personal);
    mkdirSync(providerProductName);
    expect(() => providerServiceProfile(['app', PROVIDER_SERVICE_SWITCH], personal,
      providerNormalUserData(root, PERSONAL_COS_APP_NAME)!)).toThrow(/overlaps_personal/);
    expect(providerServiceProfile(['app', PROVIDER_SERVICE_SWITCH], providerProductName,
      providerNormalUserData(root, PERSONAL_COS_APP_NAME)!)).toBe(realpathSync(providerProductName));
  });
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

  it('allows only the explicitly selected isolated profile to enter one-time sign-in mode', () => {
    const { personal, isolated } = fixture();
    expect(providerServiceProfile(['app', PROVIDER_SIGN_IN_SWITCH], isolated, personal)).toBe(realpathSync(isolated));
    expect(() => providerServiceProfile(['app', PROVIDER_SIGN_IN_SWITCH], personal, personal)).toThrow(/overlaps_personal/);
    expect(() => providerServiceProfile(['app', PROVIDER_SIGN_IN_SWITCH, PROVIDER_SERVICE_SWITCH], isolated, personal))
      .toThrow(/conflicting_modes/);
  });

  it('does not confuse mere cookie presence with verified account authorization', () => {
    const bridge = { running: true, paired: true, cosExtension: { present: true } };
    expect(providerReadinessStatus(null, bridge)).toEqual({
      sessionCookie: 'unknown', extension: 'connected', paired: true, canAttempt: false
    });
    expect(providerReadinessStatus(false, bridge).canAttempt).toBe(false);
    expect(providerReadinessStatus(true, { ...bridge, cosExtension: { present: false } }).canAttempt).toBe(false);
    expect(providerReadinessStatus(true, bridge).canAttempt).toBe(true);
  });
});
